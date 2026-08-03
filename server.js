'use strict';

// Ephemeral E2EE room server.
//
// The server is deliberately dumb: it allocates room ids, tracks who is
// currently connected, enforces expiry, and relays opaque blobs between
// peers. It never sees a room key, a nickname, a message, or an SDP body —
// all of that is encrypted client side under a key that only ever lives in
// the URL fragment.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_TTL_MIN = 30;
const MIN_TTL_MIN = 5;
const MAX_TTL_MIN = 24 * 60;
const MAX_PEERS = 12;
const MAX_ROOMS = 5000;
const MAX_FRAME_BYTES = 128 * 1024;
const SWEEP_INTERVAL_MS = 15 * 1000;

// Token-bucket limits, per connection.
const RATE_BURST = 60;
const RATE_REFILL_PER_SEC = 25;

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {Object} Room
 * @property {string} id
 * @property {string} hostToken
 * @property {number} ttlMs      inactivity window
 * @property {number} lastActive epoch ms
 * @property {number} createdAt  epoch ms
 * @property {Map<string, import('ws').WebSocket>} peers
 */

const b64url = (buf) => buf.toString('base64url');
const randomId = (bytes) => b64url(crypto.randomBytes(bytes));

function createRoom(ttlMinutes) {
  if (rooms.size >= MAX_ROOMS) throw new Error('server at capacity');
  const id = randomId(9); // 12 url-safe chars
  const room = {
    id,
    hostToken: randomId(24),
    ttlMs: clampTtl(ttlMinutes) * 60_000,
    lastActive: Date.now(),
    createdAt: Date.now(),
    peers: new Map(),
  };
  rooms.set(id, room);
  return room;
}

function clampTtl(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return DEFAULT_TTL_MIN;
  return Math.min(MAX_TTL_MIN, Math.max(MIN_TTL_MIN, Math.round(n)));
}

const expiresAt = (room) => room.lastActive + room.ttlMs;

function touch(room) {
  room.lastActive = Date.now();
}

function roomInfo(room) {
  return {
    roomId: room.id,
    ttlMinutes: Math.round(room.ttlMs / 60_000),
    expiresAt: expiresAt(room),
    peerCount: room.peers.size,
  };
}

function broadcast(room, obj, exceptPeerId) {
  const data = JSON.stringify(obj);
  for (const [peerId, ws] of room.peers) {
    if (peerId === exceptPeerId) continue;
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function closeRoom(room, reason) {
  for (const ws of room.peers.values()) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'closed', reason }));
      ws.close(4000, reason);
    }
  }
  room.peers.clear();
  rooms.delete(room.id);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    // A room with nobody in it still lives out its inactivity window, so a
    // host can create a link, close the tab, and share it later.
    if (now >= expiresAt(room)) closeRoom(room, 'expired');
  }
}, SWEEP_INTERVAL_MS).unref();

/* ------------------------------- HTTP ---------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readJsonBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  // Room URLs are /r/<id>; they all render the same shell. The room id is
  // read back from location.pathname on the client.
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  if (rel.startsWith('/r/')) rel = '/room.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      // The app is fully self-contained; no external origins are needed.
      'content-security-policy':
        "default-src 'self'; connect-src 'self' ws: wss:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/rooms' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const room = createRoom(body.ttlMinutes ?? DEFAULT_TTL_MIN);
      sendJson(res, 201, { ...roomInfo(room), hostToken: room.hostToken });
      return;
    }

    const match = /^\/api\/rooms\/([A-Za-z0-9_-]{1,64})$/.exec(p);
    if (match) {
      const room = rooms.get(match[1]);
      if (!room) return sendJson(res, 404, { error: 'room not found or expired' });

      if (req.method === 'GET') return sendJson(res, 200, roomInfo(room));

      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const supplied = String(body.hostToken || '');
        const expected = room.hostToken;
        // Constant-time compare so the token can't be probed byte by byte.
        const ok =
          supplied.length === expected.length &&
          crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
        if (!ok) return sendJson(res, 403, { error: 'not the host' });

        room.ttlMs = clampTtl(body.ttlMinutes) * 60_000;
        touch(room);
        broadcast(room, { t: 'ttl', ...roomInfo(room) });
        return sendJson(res, 200, roomInfo(room));
      }
    }

    if (p === '/healthz') return sendJson(res, 200, { ok: true, rooms: rooms.size });

    if (req.method === 'GET') return serveStatic(req, res, p);
    res.writeHead(405).end('method not allowed');
  } catch (err) {
    sendJson(res, 400, { error: err.message || 'bad request' });
  }
});

/* ----------------------------- WebSocket -------------------------------- */

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();

  const room = rooms.get(url.searchParams.get('room') || '');
  if (!room) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  if (room.peers.size >= MAX_PEERS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return socket.destroy();
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const isHost = url.searchParams.get('host') === room.hostToken;
    join(room, ws, isHost);
  });
});

function join(room, ws, isHost) {
  const peerId = randomId(6);
  const existing = [...room.peers.keys()];

  room.peers.set(peerId, ws);
  touch(room);

  ws.isAlive = true;
  ws.tokens = RATE_BURST;
  ws.lastRefill = Date.now();

  ws.send(JSON.stringify({ t: 'hello', peerId, peers: existing, isHost, ...roomInfo(room) }));
  broadcast(room, { t: 'peer-join', peerId }, peerId);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    if (!allow(ws)) return;

    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    if (msg.t === 'relay' && typeof msg.payload === 'string') {
      touch(room);
      const out = JSON.stringify({ t: 'relay', from: peerId, payload: msg.payload });
      if (typeof msg.to === 'string') {
        // Directed: WebRTC signalling between one pair of peers.
        const target = room.peers.get(msg.to);
        if (target && target.readyState === target.OPEN) target.send(out);
      } else {
        // Broadcast: chat, presence, call state.
        for (const [id, peer] of room.peers) {
          if (id !== peerId && peer.readyState === peer.OPEN) peer.send(out);
        }
      }
      return;
    }

    if (msg.t === 'ping') {
      touch(room);
      ws.send(JSON.stringify({ t: 'pong', expiresAt: expiresAt(room) }));
    }
  });

  const cleanup = () => {
    if (room.peers.get(peerId) !== ws) return;
    room.peers.delete(peerId);
    broadcast(room, { t: 'peer-leave', peerId });
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

function allow(ws) {
  const now = Date.now();
  ws.tokens = Math.min(
    RATE_BURST,
    ws.tokens + ((now - ws.lastRefill) / 1000) * RATE_REFILL_PER_SEC,
  );
  ws.lastRefill = now;
  if (ws.tokens < 1) return false;
  ws.tokens -= 1;
  return true;
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000).unref();

server.listen(PORT, () => {
  console.log(`e2e vc server listening on http://localhost:${PORT}`);
});
