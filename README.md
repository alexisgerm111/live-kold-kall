# Kold Kall — Live Coaching

Coaching commercial en temps réel pendant les rendez-vous.

## Modes
- **Visio / Téléphonie** : script en prompteur + conseils adaptatifs
- **Face-à-face** : pense-bête + alertes discrètes via notifications

## Architecture (mono-service)
- Un seul Web Service Render
- `server.js` (API HTTP + frontend) et `agent.js` (worker LiveKit) tournent en parallèle via `concurrently`
- LiveKit Cloud = transport WebRTC
- Supabase = BDD partagée avec l'app de simulation

## Variables d'environnement (Render)
- SUPABASE_URL
- SUPABASE_KEY
- SUPABASE_SECRET_KEY
- LIVEKIT_URL
- LIVEKIT_API_KEY
- LIVEKIT_API_SECRET
- DEEPGRAM_API_KEY
- GEMINI_API_KEY
- ALLOWED_ORIGIN (optionnel)

## Déploiement
Web Service Render :
- Build Command : `npm install`
- Start Command : `npm start`
- Plan : Free (avec UptimeRobot sur `/health` pour éviter la mise en veille)
