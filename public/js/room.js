// Room controller: presence, chat, call, expiry.
//
// Everything that carries meaning is sealed by crypto.js before it is handed
// to the socket, and opened only after the signature checks out. The socket
// layer below deals purely in opaque strings.

import { createSession, fromB64 } from './crypto.js';
import { normalizeNick } from './names.js';
import { createMesh } from './rtc.js';

const $ = (id) => document.getElementById(id);

const roomId = location.pathname.split('/')[2] || '';
const secretB64 = location.hash.slice(1);

let session = null;
let ws = null;
let selfId = null;
let isHost = false;
let nick = '';
let expiresAt = 0;
let inCall = false;
let localStream = null;
let reconnectDelay = 1000;
let dead = false;

const roster = new Map(); // peerId -> { nick, inCall }
const hostToken = sessionStorage.getItem(`host:${roomId}`);

/* ------------------------------------------------------------- boot ----- */

async function boot() {
  if (!roomId || !secretB64) return die('Broken link', 'This link is missing its key. Ask for a fresh one.');

  let secret;
  try {
    secret = fromB64(secretB64);
    if (secret.length !== 32) throw new Error('bad length');
  } catch {
    return die('Broken link', 'The key in this link is malformed. Ask for a fresh one.');
  }

  const probe = await fetch(`/api/rooms/${roomId}`).catch(() => null);
  if (!probe || !probe.ok) return die('Room expired', "This room is gone, along with everything that was in it.");

  session = await createSession(secret);
  $('roomCode').textContent = session.roomCode;
  $('inviteCode').textContent = session.roomCode;
  $('inviteLink').value = location.href;

  askNickname();
}

function askNickname() {
  const gate = $('nickGate');
  gate.hidden = false;
  $('nickInput').focus();

  const proceed = (raw) => {
    nick = normalizeNick(raw);
    gate.hidden = true;
    connect();
  };

  $('nickForm').addEventListener('submit', (e) => {
    e.preventDefault();
    proceed($('nickInput').value);
  });
  $('skipNick').addEventListener('click', () => proceed(''));
}

function die(title, body) {
  dead = true;
  $('deadTitle').textContent = title;
  $('deadBody').textContent = body;
  $('deadGate').hidden = false;
  $('nickGate').hidden = true;
  leaveCall();
  ws?.close();
}

/* ----------------------------------------------------------- socket ----- */

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ room: roomId });
  if (hostToken) qs.set('host', hostToken);

  ws = new WebSocket(`${proto}//${location.host}/ws?${qs}`);

  ws.onopen = () => {
    reconnectDelay = 1000;
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    await handleServerMessage(msg);
  };

  ws.onclose = async () => {
    if (dead) return;
    leaveCall();
    roster.clear();
    renderRoster();

    // A dropped socket means either a network blip or a room that no longer
    // exists. Ask, rather than reconnecting into the void forever.
    const probe = await fetch(`/api/rooms/${roomId}`).catch(() => null);
    if (probe && probe.status === 404) {
      return die('Room expired', "This room is gone, along with everything that was in it.");
    }

    system('Connection lost — reconnecting…');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

async function handleServerMessage(msg) {
  switch (msg.t) {
    case 'hello':
      selfId = msg.peerId;
      isHost = !!msg.isHost;
      setExpiry(msg.expiresAt);
      $('ttlBtn').hidden = !isHost;
      $('ttlSelect').value = String(msg.ttlMinutes);
      $('input').disabled = false;
      $('send').disabled = false;
      system(`You joined as ${nick}.`);
      renderRoster();
      await broadcast('presence', { nick, inCall });
      break;

    case 'peer-join':
      // Introduce ourselves directly to the newcomer.
      await sendTo(msg.peerId, 'presence', { nick, inCall });
      break;

    case 'peer-leave': {
      const gone = roster.get(msg.peerId);
      if (gone) system(`${gone.nick} left.`);
      roster.delete(msg.peerId);
      session.forget(msg.peerId);
      mesh.disconnect(msg.peerId);
      renderRoster();
      break;
    }

    case 'relay': {
      const inner = await session.open(msg.from, msg.payload);
      if (!inner) return; // wrong key, forged, or replayed — drop silently
      await handlePeerMessage(msg.from, inner);
      break;
    }

    case 'ttl':
      setExpiry(msg.expiresAt);
      $('ttlSelect').value = String(msg.ttlMinutes);
      system(`Room now expires after ${formatMinutes(msg.ttlMinutes)} of inactivity.`);
      break;

    case 'pong':
      setExpiry(msg.expiresAt);
      break;

    case 'closed':
      die('Room expired', "This room is gone, along with everything that was in it.");
      break;
  }
}

async function handlePeerMessage(from, inner) {
  switch (inner.kind) {
    case 'presence': {
      const known = roster.get(from);
      const name = normalizeNick(inner.nick);
      roster.set(from, { nick: name, inCall: !!inner.inCall });
      if (!known) system(`${name} joined.`);
      renderRoster();
      reconcileCall(from);
      break;
    }

    case 'chat':
      if (typeof inner.text === 'string' && inner.text.length) {
        addMessage(roster.get(from)?.nick || 'Someone', inner.text, false);
      }
      break;

    case 'signal':
      // Only meaningful if we are actually in the call.
      if (inCall) await mesh.handleSignal(from, inner.data || {});
      break;
  }
}

/* ------------------------------------------------------- send helpers --- */

async function broadcast(kind, fields) {
  if (ws?.readyState !== WebSocket.OPEN || !selfId) return;
  ws.send(JSON.stringify({ t: 'relay', payload: await session.seal(selfId, kind, fields) }));
}

async function sendTo(peerId, kind, fields) {
  if (ws?.readyState !== WebSocket.OPEN || !selfId) return;
  ws.send(
    JSON.stringify({ t: 'relay', to: peerId, payload: await session.seal(selfId, kind, fields) }),
  );
}

/* -------------------------------------------------------------- call ---- */

const mesh = createMesh({
  get selfId() {
    return selfId;
  },
  sendSignal: (peerId, data) => sendTo(peerId, 'signal', { data }),
  onTrack: (peerId, stream) => attachAudio(peerId, stream),
  onPeerState: (peerId, state) => {
    if (state === 'closed' || state === 'failed') detachAudio(peerId);
    updateCallStatus();
  },
});

function attachAudio(peerId, stream) {
  let el = document.getElementById(`a-${peerId}`);
  if (!el) {
    el = document.createElement('audio');
    el.id = `a-${peerId}`;
    el.autoplay = true;
    $('audioSinks').appendChild(el);
  }
  el.srcObject = stream;
  el.play().catch(() => {});
}

function detachAudio(peerId) {
  const el = document.getElementById(`a-${peerId}`);
  if (el) {
    el.srcObject = null;
    el.remove();
  }
}

/** Open or drop a peer connection based on whether we are both in the call. */
function reconcileCall(peerId) {
  const peer = roster.get(peerId);
  if (inCall && peer?.inCall) mesh.connect(peerId);
  else mesh.disconnect(peerId);
}

async function joinCall() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    system('Microphone permission denied — you can still chat.');
    return;
  }

  inCall = true;
  mesh.setLocalStream(localStream);
  $('callBtn').textContent = 'Leave call';
  $('callBtn').classList.replace('primary', 'danger');
  $('muteBtn').hidden = false;

  await broadcast('presence', { nick, inCall });
  for (const peerId of roster.keys()) reconcileCall(peerId);
  updateCallStatus();
  startHeartbeat();
}

function leaveCall() {
  if (!inCall) return;
  inCall = false;
  mesh.stopAll();
  localStream = null;
  for (const el of $('audioSinks').querySelectorAll('audio')) el.remove();

  $('callBtn').textContent = 'Join call';
  $('callBtn').classList.replace('danger', 'primary');
  $('muteBtn').hidden = true;
  $('muteBtn').textContent = 'Mute';

  broadcast('presence', { nick, inCall });
  updateCallStatus();
  stopHeartbeat();
}

function updateCallStatus() {
  if (!inCall) {
    $('callStatus').textContent = 'Not in the call';
    return;
  }
  const others = [...roster.values()].filter((p) => p.inCall).length;
  $('callStatus').textContent = others
    ? `In the call with ${others} ${others === 1 ? 'other' : 'others'} · peer-to-peer, encrypted`
    : 'In the call — waiting for someone else to join';
}

// While a call is running no chat may be sent for a long time, but the room is
// plainly in use. A heartbeat keeps the inactivity clock honest.
let heartbeat = null;
const startHeartbeat = () => {
  heartbeat ??= setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping' }));
  }, 60_000);
};
const stopHeartbeat = () => {
  clearInterval(heartbeat);
  heartbeat = null;
};

/* --------------------------------------------------------------- ui ----- */

function renderRoster() {
  const box = $('peers');
  box.innerHTML = '';
  $('count').textContent = String(roster.size + (selfId ? 1 : 0));

  const rows = [[selfId, { nick: `${nick} (you)`, inCall }], ...roster.entries()];
  for (const [peerId, peer] of rows) {
    if (!peerId) continue;
    const el = document.createElement('div');
    el.className = `peer${peer.inCall ? ' in-call' : ''}`;
    el.innerHTML = '<span class="dot"></span><span class="nick"></span><span class="fp mono"></span>';
    el.querySelector('.nick').textContent = peer.nick;
    box.appendChild(el);

    if (peerId !== selfId) {
      session.peerFingerprint(peerId).then((fp) => {
        if (fp) el.querySelector('.fp').textContent = fp;
      });
    }
  }
  updateCallStatus();
}

function addMessage(who, text, self) {
  const log = $('log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;

  const el = document.createElement('div');
  el.className = `msg${self ? ' self' : ''}`;
  el.innerHTML = '<div class="who"></div><div class="bubble"></div>';
  el.querySelector('.who').textContent = `${who} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  el.querySelector('.bubble').textContent = text;
  log.appendChild(el);

  if (nearBottom || self) log.scrollTop = log.scrollHeight;
}

function system(text) {
  const log = $('log');
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function setExpiry(ts) {
  expiresAt = ts;
}

function formatMinutes(m) {
  if (m < 60) return `${m} minutes`;
  const h = m / 60;
  return `${h % 1 === 0 ? h : h.toFixed(1)} hour${h === 1 ? '' : 's'}`;
}

setInterval(() => {
  if (!expiresAt || dead) return;
  const left = Math.max(0, expiresAt - Date.now());
  const mins = Math.floor(left / 60_000);
  const secs = Math.floor((left % 60_000) / 1000);
  $('expiry').textContent =
    left === 0 ? 'expiring…' : `expires in ${mins}:${String(secs).padStart(2, '0')}`;
}, 1000);

/* ---------------------------------------------------------- bindings ---- */

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  addMessage(`${nick} (you)`, text, true);
  await broadcast('chat', { text });
});

$('callBtn').addEventListener('click', () => (inCall ? leaveCall() : joinCall()));

$('muteBtn').addEventListener('click', () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('muteBtn').textContent = track.enabled ? 'Mute' : 'Unmute';
});

$('inviteBtn').addEventListener('click', () => {
  $('inviteLink').value = location.href;
  $('inviteGate').hidden = false;
});
$('closeInvite').addEventListener('click', () => ($('inviteGate').hidden = true));
$('copyLink').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    $('copyLink').textContent = 'Copied';
  } catch {
    $('inviteLink').select();
    $('copyLink').textContent = 'Select + copy';
  }
  setTimeout(() => ($('copyLink').textContent = 'Copy'), 1600);
});

$('newRoom').addEventListener('click', () => (location.href = '/'));

$('ttlBtn').addEventListener('click', () => ($('ttlGate').hidden = false));
$('cancelTtl').addEventListener('click', () => ($('ttlGate').hidden = true));
$('saveTtl').addEventListener('click', async () => {
  const ttlMinutes = Number($('ttlSelect').value);
  const res = await fetch(`/api/rooms/${roomId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostToken, ttlMinutes }),
  });
  if (res.ok) setExpiry((await res.json()).expiresAt);
  else system('Could not change the expiry.');
  $('ttlGate').hidden = true;
});

window.addEventListener('beforeunload', () => {
  mesh.stopAll();
  ws?.close();
});

boot();
