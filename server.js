import express from 'express';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Supabase ──────────────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ─── LiveKit ───────────────────────────────────────────────────────────────
const roomService = new RoomServiceClient(
  process.env.LIVEKIT_URL.replace('wss://', 'https://'),
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

// ─── Variables obligatoires ────────────────────────────────────────────────
const REQUIRED = [
  'SUPABASE_URL', 'SUPABASE_KEY', 'SUPABASE_SECRET_KEY',
  'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
  'DEEPGRAM_API_KEY', 'GEMINI_API_KEY'
];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌ Variables manquantes : ${missing.join(', ')}\n`);
  process.exit(1);
}

// ─── CORS ──────────────────────────────────────────────────────────────────
const ALLOWED = new Set([process.env.ALLOWED_ORIGIN || 'https://alexisgerm111.github.io']);
app.use((req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  const origin = req.headers.origin;
  if (origin && ALLOWED.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Health check (pour UptimeRobot) ───────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Helpers auth ──────────────────────────────────────────────────────────
async function getAuthenticatedUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data?.user ? null : data.user;
}

async function getProfile(userId) {
  const { data } = await supabaseAdmin.from('profiles').select('*').eq('id', userId).single();
  return data || null;
}

// ─── Handshake ─────────────────────────────────────────────────────────────
const handshakeCodes = new Map();
const HANDSHAKE_TTL_MS = 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, v] of handshakeCodes) {
    if (now - v.createdAt > HANDSHAKE_TTL_MS) handshakeCodes.delete(code);
  }
}, 60 * 1000).unref?.();

app.post('/api/auth/handshake', async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Auth requise' });
  const { refresh_token } = req.body;
  const auth = req.headers.authorization || '';
  const accessToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!accessToken || !refresh_token) return res.status(400).json({ error: 'Tokens requis' });
  const code = crypto.randomBytes(32).toString('base64url');
  handshakeCodes.set(code, { accessToken, refreshToken: refresh_token, userId: user.id, createdAt: Date.now() });
  res.json({ code, expiresIn: 60 });
});

app.post('/api/auth/exchange', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code requis' });
  const entry = handshakeCodes.get(code);
  if (!entry) return res.status(401).json({ error: 'Code invalide' });
  handshakeCodes.delete(code);
  if (Date.now() - entry.createdAt > HANDSHAKE_TTL_MS) return res.status(401).json({ error: 'Code expiré' });
  const profile = await getProfile(entry.userId);
  const { data: userData } = await supabaseAdmin.auth.admin.getUserById(entry.userId);
  res.json({
    access_token: entry.accessToken,
    refresh_token: entry.refreshToken,
    user: userData?.user || { id: entry.userId },
    profile
  });
});

app.post('/api/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token requis' });
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': process.env.SUPABASE_KEY },
    body: JSON.stringify({ refresh_token })
  });
  const data = await r.json();
  if (!r.ok) return res.status(r.status).json({ error: data.error_description || 'Refresh échoué' });
  res.json({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user });
});

// ─── Démarrage session coaching ────────────────────────────────────────────
app.post('/api/coaching/start', async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Auth requise' });
  const { mode, playbook } = req.body;
  if (!['visio', 'f2f'].includes(mode)) return res.status(400).json({ error: 'mode invalide' });

  try {
    const { data: session, error } = await supabaseAdmin
      .from('coaching_sessions')
      .insert({ user_id: user.id, mode, playbook: playbook || null, statut: 'en_cours' })
      .select('id')
      .single();
    if (error) throw error;

    const roomName = `coaching-${session.id}`;
    await roomService.createRoom({
      name: roomName,
      emptyTimeout: 300,
      maxParticipants: 4,
      metadata: JSON.stringify({ mode, sessionId: session.id, userId: user.id })
    });

    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: `commercial-${user.id}`,
      name: 'Commercial',
      ttl: '2h',
      metadata: JSON.stringify({ role: 'commercial', sessionId: session.id })
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    const token = await at.toJwt();

    res.json({ sessionId: session.id, roomName, token, livekitUrl: process.env.LIVEKIT_URL });
  } catch (err) {
    console.error('[Coaching] Erreur start :', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/coaching/end', async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Auth requise' });
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId requis' });
  const { error } = await supabaseAdmin
    .from('coaching_sessions')
    .update({ statut: 'terminee', ended_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('user_id', user.id);
  if (error) return res.status(500).json({ error: error.message });
  try { await roomService.deleteRoom(`coaching-${sessionId}`); } catch (_) {}
  res.json({ ok: true });
});

app.get('/api/coaching/session/:id', async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Auth requise' });
  const { data, error } = await supabaseAdmin
    .from('coaching_sessions')
    .select('id, mode, playbook, statut, started_at, ended_at, transcript')
    .eq('id', req.params.id)
    .eq('user_id', user.id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Session introuvable' });
  res.json(data);
});

app.get('/api/coaching/:id/nudges', async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Auth requise' });
  const { data: session } = await supabaseAdmin
    .from('coaching_sessions').select('id').eq('id', req.params.id).eq('user_id', user.id).single();
  if (!session) return res.status(404).json({ error: 'Session introuvable' });
  const { data, error } = await supabaseAdmin
    .from('coaching_nudges').select('*').eq('session_id', req.params.id).order('ts', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ nudges: data || [] });
});

// ─── Démarrage ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║      🎧  KOLD KALL — LIVE COACHING         ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`\n🚀  http://localhost:${PORT}`);
  console.log(`📡  LiveKit   →  ${process.env.LIVEKIT_URL}`);
  console.log('🎙️   STT       →  Deepgram Nova-3');
  console.log('🧠  LLM       →  Gemini 3.5 Flash Lite');
  console.log('🗄️   BDD       →  Supabase');
  console.log('\n─────────────────────────────────────────────\n');
});
