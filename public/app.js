import {
  Room, RoomEvent, createLocalAudioTrack, LocalAudioTrack
} from 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const code = params.get('code');
const mode = params.get('mode') || 'visio';

let room = null;
let sessionId = null;
let currentUser = null;
let authAccessToken = null;
let authRefreshToken = null;
let startedAt = null;
let timerInterval = null;
let nudgeCount = 0;
let transcriptCount = 0;

function setStatus(text, state = 'idle') {
  const dot = $('lcDot');
  $('lcStatus').textContent = text;
  dot.classList.remove('live', 'err');
  if (state === 'live') dot.classList.add('live');
  if (state === 'err') dot.classList.add('err');
}
function showLoginScreen() {
  $('lcLogin').classList.remove('hidden');
  $('lcApp').classList.add('hidden');
}
function showApp() {
  $('lcLogin').classList.add('hidden');
  $('lcApp').classList.remove('hidden');
}
function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function startTimer() {
  startedAt = Date.now();
  timerInterval = setInterval(() => {
    const s = (Date.now() - startedAt) / 1000;
    $('lcTimer').textContent = fmtTime(s);
  }, 500);
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

async function bootstrap() {
  if (!code) { showLoginScreen(); return; }
  history.replaceState({}, '', location.pathname);

  try {
    const r = await fetch('/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (!r.ok) { showLoginScreen(); return; }
    const data = await r.json();
    authAccessToken = data.access_token;
    authRefreshToken = data.refresh_token;
    currentUser = data.user;
    showApp();
    $('lcModeTag').textContent = mode === 'f2f' ? 'Face-à-face' : 'Visio';
    await startCoaching();
  } catch (e) {
    console.error('[Boot] Erreur :', e);
    showLoginScreen();
  }
}

async function startCoaching() {
  setStatus('Création de la session…');
  const playbook = sessionStorage.getItem('kk-live-playbook') || '';
  sessionStorage.removeItem('kk-live-playbook');

  try {
    const r = await fetch('/api/coaching/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authAccessToken}`
      },
      body: JSON.stringify({ mode, playbook })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    const { token, livekitUrl, sessionId: sid } = await r.json();
    sessionId = sid;

    if (mode === 'visio' && playbook) {
      $('lcScriptBody').textContent = playbook;
      $('lcScriptBody').classList.remove('lc-empty');
      $('lcScriptBadge').textContent = 'Actif';
      $('lcScriptBadge').classList.add('live');
    } else if (mode === 'f2f') {
      $('lcScriptBody').innerHTML = '<div class="lc-empty">Mode face-à-face : pas de script. Concentre-toi sur la conversation, le coach te guide discrètement.</div>';
      $('lcScriptBadge').textContent = 'F2F';
      $('lcScriptBadge').classList.add('live');
    }

    setStatus('Connexion à LiveKit…');

    room = new Room({ adaptiveStream: false, dynacast: false });
    room
      .on(RoomEvent.Connected, () => {
        setStatus('En écoute', 'live');
        $('lcEnd').disabled = false;
        startTimer();
      })
      .on(RoomEvent.Disconnected, () => {
        setStatus('Déconnecté');
        stopTimer();
      })
      .on(RoomEvent.DataReceived, handleData)
      .on(RoomEvent.TranscriptionReceived, handleTranscription);

    await room.connect(livekitUrl, token);

    const audioTrack = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    });
    await room.localParticipant.publishTrack(audioTrack);

    if (mode === 'visio') {
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true, audio: true
        });
        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length) {
          const prospectTrack = new LocalAudioTrack(audioTracks[0], 'prospect');
          await room.localParticipant.publishTrack(prospectTrack, { name: 'prospect' });
          displayStream.getVideoTracks().forEach(t => t.stop());
        } else {
          console.warn('[LiveKit] Aucune piste audio partagée — le prospect ne sera pas entendu.');
        }
      } catch (e) {
        console.warn('[LiveKit] Partage audio onglet refusé ou indisponible :', e.message);
      }
    }

    if (mode === 'f2f' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch (e) {
    console.error('[Coaching] Erreur :', e);
    setStatus('Erreur : ' + e.message, 'err');
  }
}

function handleData(payload, participant, kind, topic) {
  if (topic !== 'coach-nudge') return;
  try {
    const nudge = JSON.parse(new TextDecoder().decode(payload));
    renderNudge(nudge);
  } catch (e) {
    console.error('[Nudge] Parse erreur :', e);
  }
}

function renderNudge(nudge) {
  const list = $('lcNudgeList');
  if (nudgeCount === 0) list.innerHTML = '';

  nudgeCount++;
  $('lcNudgeCount').textContent = nudgeCount;

  const el = document.createElement('div');
  el.className = `lc-nudge lc-nudge--${nudge.nudgeType || 'phase'}${nudge.priority === 'high' ? ' lc-nudge--high' : ''}`;
  el.innerHTML = `
    <div class="lc-nudge-type">${escapeHtml(nudge.nudgeType || 'conseil')}</div>
    <div class="lc-nudge-msg">${escapeHtml(nudge.message)}</div>
    <div class="lc-nudge-time">${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
  `;
  list.prepend(el);
  while (list.children.length > 12) list.lastChild.remove();

  if (mode === 'f2f' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification('Kold Kall — Coach', {
        body: nudge.message,
        silent: false,
        tag: 'kk-nudge-' + Date.now()
      });
    } catch (_) {}
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  }
}

function handleTranscription(segments, participant) {
  const list = $('lcTranscript');
  if (transcriptCount === 0) list.innerHTML = '';
  segments.forEach(seg => {
    if (!seg.final) return;
    transcriptCount++;
    const isCommercial = participant?.identity?.startsWith('commercial-');
    const el = document.createElement('div');
    el.className = 'lc-line';
    el.innerHTML = `
      <span class="lc-who ${isCommercial ? 'c' : 'p'}">${isCommercial ? 'Commercial' : 'Prospect'}</span>
      <span class="lc-line-text">${escapeHtml(seg.text)}</span>
    `;
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
  });
  $('lcTranscriptBadge').textContent = transcriptCount + ' lignes';
}

$('lcEnd').addEventListener('click', async () => {
  if (!sessionId) return;
  $('lcEnd').disabled = true;
  $('lcEnd').textContent = 'Fermeture…';
  try {
    await fetch('/api/coaching/end', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authAccessToken}`
      },
      body: JSON.stringify({ sessionId })
    });
  } catch (e) {
    console.warn('[End] Erreur :', e);
  }
  if (room) await room.disconnect();
  stopTimer();
  window.location.href = 'https://alexisgerm111.github.io/daqhboard-kold-kall/';
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

bootstrap();
