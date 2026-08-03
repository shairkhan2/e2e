// Room controller: presence, chat, call, expiry.
//
// Everything that carries meaning is sealed by crypto.js before it is handed
// to the socket, and opened only after the signature checks out. The socket
// layer below deals purely in opaque strings.

import { createSession, fromB64 } from './crypto.js';
import { normalizeNick } from './names.js';
import { createMesh } from './rtc.js';
import { createLevelMonitor } from './levels.js';
import {
  $,
  registerServiceWorker,
  openSheet,
  closeSheet,
  wireSheet,
  hueFor,
  initials,
  segmented,
  select,
  formatTtl,
  holdScreenAwake,
  releaseScreen,
} from './ui.js';

registerServiceWorker();

const roomId = location.pathname.split('/')[2] || '';
const secretB64 = location.hash.slice(1);
const hostToken = sessionStorage.getItem(`host:${roomId}`);

let session = null;
let ws = null;
let selfId = null;
let isHost = false;
let nick = '';
let expiresAt = 0;
let ttlMinutes = 30;
let inCall = false;
let muted = false;
let callStartedAt = 0;
let localStream = null;
let reconnectDelay = 1000;
let dead = false;
let unread = 0;

const roster = new Map(); // peerId -> { nick, inCall, muted }
const speaking = new Set(); // peer ids (and 'me') currently talking

/* ------------------------------------------------------------- boot ----- */

async function boot() {
  for (const [el, dismissible] of [
    [$('inviteGate'), true],
    [$('securityGate'), true],
    [$('menuGate'), true],
    [$('nickGate'), false],
    [$('deadGate'), false],
  ]) {
    wireSheet(el, { canDismiss: dismissible });
  }

  if (!roomId || !secretB64) return die('Link is broken', 'It came through without its key. Ask for a fresh one.');

  let secret;
  try {
    secret = fromB64(secretB64);
    if (secret.length !== 32) throw new Error('bad length');
  } catch {
    return die('Link is broken', 'The key in this link is malformed. Ask for a fresh one.');
  }

  const probe = await fetch(`/api/rooms/${roomId}`).catch(() => null);
  if (!probe || !probe.ok) return die('Room expired', "It's gone, and so is everything that was in it.");

  session = await createSession(secret);
  $('roomCode').textContent = session.roomCode.split('-')[0];
  $('securityCode').textContent = session.roomCode;
  $('menuCode').textContent = session.roomCode;
  $('inviteLink').value = location.href;

  if (navigator.share) $('shareLink').hidden = false;

  openSheet($('nickGate'));
  setTimeout(() => $('nickInput').focus(), 250);
}

function proceedWithNick(raw) {
  nick = normalizeNick(raw);
  closeSheet($('nickGate'));
  connect();
}

$('nickForm').addEventListener('submit', (e) => {
  e.preventDefault();
  proceedWithNick($('nickInput').value);
});
$('skipNick').addEventListener('click', () => proceedWithNick(''));

function die(title, body) {
  dead = true;
  $('deadTitle').textContent = title;
  $('deadBody').textContent = body;
  closeSheet($('nickGate'));
  openSheet($('deadGate'));
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
    renderRail();

    // A dropped socket means either a network blip or a room that no longer
    // exists. Ask, rather than reconnecting into the void forever.
    const probe = await fetch(`/api/rooms/${roomId}`).catch(() => null);
    if (probe && probe.status === 404) {
      return die('Room expired', "It's gone, and so is everything that was in it.");
    }

    note('Reconnecting…');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

async function handleServerMessage(msg) {
  switch (msg.t) {
    case 'hello':
      selfId = msg.peerId;
      isHost = !!msg.isHost;
      setExpiry(msg.expiresAt, msg.ttlMinutes);
      $('ttlSection').hidden = !isHost;
      $('input').disabled = false;
      renderRail();
      await broadcastPresence();
      break;

    case 'peer-join':
      // Introduce ourselves directly to the newcomer.
      await sendTo(msg.peerId, 'presence', presenceFields());
      break;

    case 'peer-leave': {
      const gone = roster.get(msg.peerId);
      if (gone) note(`${gone.nick} left`);
      roster.delete(msg.peerId);
      speaking.delete(msg.peerId);
      session.forget(msg.peerId);
      mesh.disconnect(msg.peerId);
      renderRail();
      break;
    }

    case 'relay': {
      const inner = await session.open(msg.from, msg.payload);
      if (!inner) return; // wrong key, forged, or replayed — drop silently
      await handlePeerMessage(msg.from, inner);
      break;
    }

    case 'ttl':
      setExpiry(msg.expiresAt, msg.ttlMinutes);
      note(`Now expires after ${formatTtl(msg.ttlMinutes)} of quiet`);
      break;

    case 'pong':
      setExpiry(msg.expiresAt, ttlMinutes);
      break;

    case 'closed':
      die('Room expired', "It's gone, and so is everything that was in it.");
      break;
  }
}

async function handlePeerMessage(from, inner) {
  switch (inner.kind) {
    case 'presence': {
      const known = roster.get(from);
      const name = normalizeNick(inner.nick);
      roster.set(from, { nick: name, inCall: !!inner.inCall, muted: !!inner.muted });
      if (!known) note(`${name} joined`);
      renderRail();
      reconcileCall(from);
      break;
    }

    case 'chat':
      if (typeof inner.text === 'string' && inner.text.length) {
        addMessage(from, roster.get(from)?.nick || 'Someone', inner.text);
        if (document.hidden) {
          unread++;
          document.title = `(${unread}) vc`;
          navigator.vibrate?.(12);
        }
      }
      break;

    case 'signal':
      if (inCall) await mesh.handleSignal(from, inner.data || {});
      break;
  }
}

/* ------------------------------------------------------- send helpers --- */

const presenceFields = () => ({ nick, inCall, muted });

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

const broadcastPresence = () => broadcast('presence', presenceFields());

/* -------------------------------------------------------------- call ---- */

const levels = createLevelMonitor((id, isSpeaking) => {
  if (isSpeaking) speaking.add(id);
  else speaking.delete(id);
  paintSpeaking();
});

const mesh = createMesh({
  get selfId() {
    return selfId;
  },
  sendSignal: (peerId, data) => sendTo(peerId, 'signal', { data }),
  onTrack: (peerId, stream) => attachAudio(peerId, stream),
  onPeerState: (peerId, state) => {
    if (state === 'closed' || state === 'failed') detachAudio(peerId);
    updateCallUi();
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
  levels.attach(peerId, stream);
  updateCallUi();
}

function detachAudio(peerId) {
  levels.detach(peerId);
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
  $('callBtn').disabled = true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    note('Microphone blocked — you can still chat');
    $('callBtn').disabled = false;
    return;
  }
  $('callBtn').disabled = false;

  inCall = true;
  muted = false;
  callStartedAt = Date.now();
  mesh.setLocalStream(localStream);
  levels.attach('me', localStream);
  holdScreenAwake();

  await broadcastPresence();
  for (const peerId of roster.keys()) reconcileCall(peerId);
  updateCallUi();
  renderRail();
  startHeartbeat();
}

function leaveCall() {
  if (!inCall) return;
  inCall = false;
  muted = false;
  levels.detach('me');
  mesh.stopAll();
  localStream = null;
  for (const el of $('audioSinks').querySelectorAll('audio')) el.remove();
  releaseScreen();

  broadcastPresence();
  updateCallUi();
  renderRail();
  stopHeartbeat();
}

function updateCallUi() {
  const strip = $('callStrip');
  const btn = $('callBtn');
  btn.dataset.active = String(inCall);
  btn.setAttribute('aria-label', inCall ? 'Leave call' : 'Start call');

  if (!inCall) {
    strip.dataset.state = 'idle';
    return;
  }

  const others = [...roster.values()].filter((p) => p.inCall).length;
  strip.dataset.state = others ? 'active' : 'connecting';
  $('callStatus').textContent = others
    ? `In call · ${others + 1}`
    : 'Waiting for someone to join';
  $('muteBtn').textContent = muted ? 'Unmute' : 'Mute';
}

setInterval(() => {
  if (!inCall) return;
  const s = Math.floor((Date.now() - callStartedAt) / 1000);
  $('callElapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}, 1000);

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

function personEl(id, name, state, isMe) {
  const el = document.createElement('div');
  el.className = `person${isMe ? ' me' : ''}`;
  el.dataset.peer = id;
  el.style.setProperty('--h', hueFor(id || name));

  const flag = state.inCall
    ? `<span class="flag ${state.muted ? 'muted' : 'on-call'}"><svg><use href="#i-${state.muted ? 'mic-off' : 'mic'}"/></svg></span>`
    : '';

  el.innerHTML = `<span class="av">${initials(name)}${flag}</span><span class="name"></span>`;
  el.querySelector('.name').textContent = isMe ? 'You' : name;
  return el;
}

function renderRail() {
  const rail = $('peers');
  rail.innerHTML = '';
  $('count').textContent = String(roster.size + (selfId ? 1 : 0));

  if (selfId) rail.appendChild(personEl(selfId, nick, { inCall, muted }, true));
  for (const [peerId, peer] of roster) rail.appendChild(personEl(peerId, peer.nick, peer, false));

  paintSpeaking();
  updateCallUi();
}

function paintSpeaking() {
  for (const el of $('peers').querySelectorAll('.person')) {
    const id = el.dataset.peer;
    const live = speaking.has(id) || (id === selfId && speaking.has('me'));
    el.classList.toggle('speaking', live && !(id === selfId && muted));
  }
}

// Consecutive messages from one person collapse into a single group.
let lastGroup = { who: null, at: 0 };

function addMessage(fromId, who, text) {
  const log = $('log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
  const mine = fromId === selfId;
  const now = Date.now();
  const grouped = lastGroup.who === fromId && now - lastGroup.at < 4 * 60_000;

  const el = document.createElement('div');
  el.className = `msg ${mine ? 'me' : 'them'}${grouped ? ' grouped' : ''}`;
  // Own messages need no name: the side and colour already say who sent them.
  if (!grouped && !mine) {
    const label = document.createElement('div');
    label.className = 'who';
    label.textContent = who;
    el.appendChild(label);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  el.appendChild(bubble);
  log.appendChild(el);

  lastGroup = { who: fromId, at: now };
  if (nearBottom || mine) log.scrollTop = log.scrollHeight;
}

function note(text) {
  const log = $('log');
  const el = document.createElement('div');
  el.className = 'note';
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  lastGroup = { who: null, at: 0 };
}

function setExpiry(ts, minutes) {
  expiresAt = ts;
  if (minutes) {
    ttlMinutes = minutes;
    select($('ttlSelect'), 'room-ttl', minutes);
  }
}

setInterval(() => {
  if (!expiresAt || dead) return;
  const left = Math.max(0, expiresAt - Date.now());
  const mins = Math.floor(left / 60_000);
  const label =
    left === 0
      ? 'now'
      : mins >= 60
        ? `${Math.floor(mins / 60)}h ${mins % 60}m`
        : `${mins}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`;
  $('timer').textContent = label;
  $('timer').dataset.soon = String(left < 5 * 60_000);
  $('menuExpiry').textContent = label;
}, 1000);

/* ---------------------------------------------------------- bindings ---- */

const input = $('input');

function grow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  $('send').disabled = !input.value.trim();
}

input.addEventListener('input', grow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$('send').addEventListener('click', sendMessage);

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  grow();
  addMessage(selfId, nick, text);
  await broadcast('chat', { text });
}

$('callBtn').addEventListener('click', () => (inCall ? leaveCall() : joinCall()));
$('leaveBtn').addEventListener('click', leaveCall);

$('muteBtn').addEventListener('click', async () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  muted = !muted;
  track.enabled = !muted;
  updateCallUi();
  renderRail();
  await broadcastPresence();
});

$('inviteBtn').addEventListener('click', () => {
  $('inviteLink').value = location.href;
  openSheet($('inviteGate'));
});

$('shareLink').addEventListener('click', () => {
  navigator
    .share({ title: 'Join my room', text: 'Tap to join — no sign-up.', url: location.href })
    .catch(() => {});
});

$('copyLink').addEventListener('click', async () => {
  const label = $('copyLink').querySelector('.grow');
  try {
    await navigator.clipboard.writeText(location.href);
    label.innerHTML = 'Copied<small>Link is on your clipboard</small>';
  } catch {
    $('inviteLink').select();
    label.innerHTML = 'Select and copy<small>Clipboard is blocked here</small>';
  }
  setTimeout(() => (label.innerHTML = 'Copy link<small>Paste it anywhere</small>'), 2200);
});

$('securityBtn').addEventListener('click', async () => {
  const box = $('fingerprints');
  box.innerHTML = '';
  for (const [peerId, peer] of roster) {
    const fp = await session.peerFingerprint(peerId);
    if (!fp) continue;
    const line = document.createElement('div');
    line.className = 'line';
    line.innerHTML = '<span></span><span class="val mono"></span>';
    line.children[0].textContent = peer.nick;
    line.children[1].textContent = fp;
    box.appendChild(line);
  }
  openSheet($('securityGate'));
});

$('menuBtn').addEventListener('click', () => openSheet($('menuGate')));
$('leaveRoom').addEventListener('click', () => (location.href = '/'));
$('newRoom').addEventListener('click', () => (location.href = '/'));

let pendingTtl = null;
segmented($('ttlSelect'), 'room-ttl', (value) => (pendingTtl = value));

$('saveTtl').addEventListener('click', async () => {
  const res = await fetch(`/api/rooms/${roomId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostToken, ttlMinutes: pendingTtl ?? ttlMinutes }),
  });
  if (res.ok) {
    const info = await res.json();
    setExpiry(info.expiresAt, info.ttlMinutes);
  } else {
    note('Could not change the expiry');
  }
  closeSheet($('menuGate'));
});

addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    unread = 0;
    document.title = 'vc';
  }
});

addEventListener('beforeunload', () => {
  mesh.stopAll();
  ws?.close();
});

boot();
