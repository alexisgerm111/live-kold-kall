import { WorkerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as google from '@livekit/agents-plugin-google';
import * as silero from '@livekit/agents-plugin-silero';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ─── Prompt système du coach ───────────────────────────────────────────────
function buildCoachPrompt({ mode, playbook, history }) {
  return `
Tu es un coach commercial en temps réel pour Kold Kall.
Tu écoutes une conversation entre un commercial et un prospect, et tu produis des nudges ultra-courts (1 ligne max) que le commercial verra sur son écran.

═══════════════════════════════════════════
RÔLE ET CONTRAINTES ABSOLUES
═══════════════════════════════════════════
- Tu ne parles JAMAIS à voix haute (V1).
- Tu n'interromps JAMAIS la conversation.
- Tu n'es JAMAIS dans le jugement. Tu extrais ce que font les top commerciaux.
- Tu produis un nudge SEULEMENT s'il apporte une valeur immédiate. Le silence est une réponse valide.
- Tu ne répètes JAMAIS un nudge déjà envoyé dans les 2 dernières minutes.

═══════════════════════════════════════════
MODE : ${mode}
═══════════════════════════════════════════
${mode === 'visio'
  ? 'Le commercial a un prompteur à l\'écran. Tu peux afficher le script, surligner les passages pertinents.'
  : 'Le commercial est en face à face. Tu envoies des alertes discrètes sur son téléphone (notification type SMS). Les messages doivent être AUTONOMES et COMPRÉHENSIBLES en 3 secondes. Pas de référence à l\'écran.'}

═══════════════════════════════════════════
PLAYBOOK DE RÉFÉRENCE
═══════════════════════════════════════════
${playbook || '(aucun playbook fourni)'}

═══════════════════════════════════════════
CONVERSATION EN COURS
═══════════════════════════════════════════
${history || '(début de la conversation)'}

═══════════════════════════════════════════
CE QUE TU DÉTECTES ET LE NUDGE ASSOCIÉ
═══════════════════════════════════════════
1. OBJECTION PROSPECT
   Détection : "trop cher", "pas le temps", "déjà équipé", "pas intéressé", "envoyez-moi un mail", "on verra plus tard"
   Nudge : propose une réponse courte tirée du playbook.
   Format : "Réponds: <réponse>"

2. SIGNAL D'ACHAT
   Détection : questions sur le prix, le délai, l'implémentation, les références, la prochaine étape
   Nudge : "Zone d'achat. Enchaîne: <action>"

3. DÉBIT DE PAROLE
   Détection : >180 mots/min ou <110 mots/min sur les 30 dernières secondes du commercial
   Nudge : "Parle moins vite" ou "Accélère un peu"

4. SILENCE POST-QUESTION
   Détection : question clé posée, silence < 3 secondes, le commercial commence à remplir
   Nudge : "Laisse-le répondre. Ne remplis pas."

5. PROFIL DISC
   Détection : Dominant (direct, impatient) / Influent (bavard, digresse) / Steady (prudent) / Conscientious (précis, demande chiffres)
   Nudge : "Profil Dominant: va droit au but" / "Profil Analytique: donne un chiffre"
   Une seule fois par session, à >70% de confiance.

6. PHASE DE VENTE
   Détection : découverte, pitch, objections, closing
   Nudge : "Tu es en découverte depuis 8 min. Tu peux passer au pitch."

7. RECAP DÉCOUVERTE
   Détection : la découverte traîne, 3+ infos importantes déjà données
   Nudge : "Récapitule: '<points clés>'"

8. QUESTION À POSER
   Détection : commercial parle >70% du temps, prospect passif
   Nudge : "Pose: '<question ouverte>'"

═══════════════════════════════════════════
FORMAT DE SORTIE (JSON STRICT)
═══════════════════════════════════════════
{
  "should_nudge": true,
  "type": "objection|signal_achat|debit|silence|profil_disc|phase|recap|question",
  "priority": "high|medium|low",
  "message": "...",
  "reasoning": "1 phrase interne (non affichée)"
}

Si rien d'utile : { "should_nudge": false }

═══════════════════════════════════════════
RÈGLES DE FRÉQUENCE
═══════════════════════════════════════════
- Max 1 nudge / 15 secondes.
- Max 1 nudge par type / 2 minutes.
- Ton : impératif, 1 ligne, pas d'emoji (sauf urgence F2F), pas de "!" sauf urgence.
`;
}

async function generateNudge({ mode, playbook, history }) {
  const prompt = buildCoachPrompt({ mode, playbook, history });
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 200, responseMimeType: 'application/json' }
      })
    }
  );
  if (!r.ok) {
    console.error('[Coach] Gemini erreur :', r.status, await r.text());
    return null;
  }
  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed.should_nudge) return null;
    return parsed;
  } catch (e) {
    console.error('[Coach] JSON invalide :', text);
    return null;
  }
}

// ─── Agent LiveKit ─────────────────────────────────────────────────────────
export default defineAgent({
  entry: async (ctx) => {
    await ctx.connect();
    const meta = JSON.parse(ctx.room.metadata || '{}');
    const { mode, sessionId } = meta;
    console.log(`[Agent] Room ${ctx.room.name} | mode=${mode} | session=${sessionId}`);

    const { data: session } = await supabaseAdmin
      .from('coaching_sessions').select('playbook, mode').eq('id', sessionId).single();
    const playbook = session?.playbook || '';

    let lastNudgeAt = 0;
    const recentNudges = [];

    const agentSession = new voice.AgentSession({
      vad: await silero.VAD.load(),
      stt: new deepgram.STT({ model: 'nova-3', language: 'fr' }),
      llm: new google.LLM({ model: 'gemini-3.5-flash-lite' })
    });

    const listener = new voice.Agent({
      instructions: 'Tu écoutes en silence. Tu ne réponds jamais.',
      onUserTurnCompleted: async (agentCtx, chatCtx) => {
        const history = chatCtx.items
          .filter(i => i.type === 'message')
          .map(i => `${i.role === 'user' ? 'Commercial' : 'Prospect'}: ${i.content}`)
          .join('\n');

        const now = Date.now();
        if (now - lastNudgeAt < 15000) return;

        const twoMinAgo = now - 120000;
        const nudge = await generateNudge({ mode, playbook, history });
        if (!nudge) return;

        const recent = recentNudges.filter(n => n.ts > twoMinAgo && n.type === nudge.type);
        if (recent.length > 0) return;

        lastNudgeAt = now;
        recentNudges.push({ type: nudge.type, ts: now });

        const payload = new TextEncoder().encode(JSON.stringify({
          type: 'nudge',
          nudgeType: nudge.type,
          priority: nudge.priority || 'medium',
          message: nudge.message,
          ts: now
        }));
        try {
          await agentCtx.room.localParticipant.publishData(payload, {
            reliable: true,
            topic: 'coach-nudge'
          });
        } catch (e) {
          console.error('[Agent] publishData :', e.message);
        }

        await supabaseAdmin.from('coaching_nudges').insert({
          session_id: sessionId,
          type: nudge.type,
          message: nudge.message
        });

        console.log(`[Coach] ${nudge.type} → ${nudge.message}`);
      }
    });

    await agentSession.start({ agent: listener, room: ctx.room });
  }
});

cli.runApp(new WorkerOptions({
  agent: fileURLToPath(import.meta.url),
  wsURL: process.env.LIVEKIT_URL,
  apiKey: process.env.LIVEKIT_API_KEY,
  apiSecret: process.env.LIVEKIT_API_SECRET
}));
