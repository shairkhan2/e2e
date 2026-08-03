// Two real browsers in one room: nickname handling, encrypted chat, a live
// WebRTC audio connection, expiry control, and the guarantee that the server
// only ever sees ciphertext.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';

const PORT = 8099;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
const check = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL  ${name}\n      ${err.message}`);
      process.exitCode = 1;
    });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reachable = () =>
  fetch(`${BASE}/healthz`).then(
    (r) => r.ok,
    () => false,
  );

async function waitFor(want, what) {
  for (let i = 0; i < 100; i++) {
    if ((await reachable()) === want) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for the server to be ${what}`);
}

let server;
async function startServer() {
  server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
  });
  await waitFor(true, 'up');
}

async function stopServer() {
  server?.kill();
  await waitFor(false, 'down');
}

// A leftover server would silently keep rooms alive across the restart check.
if (await reachable()) {
  console.error(`Something is already listening on ${PORT}. Stop it and re-run.`);
  process.exit(1);
}

process.on('exit', () => server?.kill());
await startServer();

const browser = await chromium.launch({
  // Pinned build shipped with the image; avoids a browser download.
  executablePath:
    process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const ctx = async () => {
  const c = await browser.newContext({ permissions: ['microphone'] });
  return c.newPage();
};

const text = (page, sel) => page.locator(sel).innerText();
const logText = (page) => text(page, '#log');

try {
  /* ---------------------------------------------------- room creation --- */

  const host = await ctx();
  await host.goto(BASE);
  await host.selectOption('#ttl', '60');
  await host.click('#create');
  await host.waitForURL(/\/r\/[\w-]+#.+/);

  const url = host.url();
  const roomId = new URL(url).pathname.split('/')[2];
  const keyFragment = new URL(url).hash.slice(1);

  await check('link carries a 32-byte key in the fragment', () => {
    assert.match(keyFragment, /^[A-Za-z0-9_-]{43}$/);
  });

  await check('server never learns the key', async () => {
    const info = await (await fetch(`${BASE}/api/rooms/${roomId}`)).json();
    assert.equal(info.ttlMinutes, 60);
    const blob = JSON.stringify(info);
    assert.ok(!blob.includes(keyFragment), 'key leaked into room metadata');
  });

  /* ------------------------------------------------------- nicknames ---- */

  await host.fill('#nickInput', 'Ada');
  await host.click('#nickForm button[type=submit]');
  await host.waitForSelector('#input:not([disabled])');

  await check('chosen nickname is used', async () => {
    assert.match(await text(host, '#peers'), /Ada \(you\)/);
  });

  const guest = await ctx();
  await guest.goto(url);
  await guest.waitForSelector('#nickGate:not([hidden])');
  await guest.click('#skipNick'); // no nickname -> random animal
  await guest.waitForSelector('#input:not([disabled])');

  let animal = '';
  await check('skipping the nickname assigns a random animal', async () => {
    const roster = await text(guest, '#peers');
    const m = roster.match(/^(.+) \(you\)$/m);
    assert.ok(m, `no self row in roster: ${roster}`);
    animal = m[1];
    assert.match(animal, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  await check('both peers see each other in the roster', async () => {
    await host.waitForFunction(
      (n) => document.getElementById('peers').innerText.includes(n),
      animal,
      { timeout: 5000 },
    );
    await guest.waitForFunction(
      () => document.getElementById('peers').innerText.includes('Ada'),
      null,
      { timeout: 5000 },
    );
    assert.equal(await text(host, '#count'), '2');
  });

  await check('peer fingerprints are shown', async () => {
    await host.waitForFunction(
      () => /^[0-9a-f]{6}$/.test(document.querySelector('.peer:nth-child(2) .fp')?.textContent || ''),
      null,
      { timeout: 5000 },
    );
  });

  await check('both peers derive the same room code', async () => {
    const a = await text(host, '#roomCode');
    assert.match(a, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    assert.equal(a, await text(guest, '#roomCode'));
  });

  /* ------------------------------------------------------------ chat ---- */

  await check('messages cross the room in both directions', async () => {
    await host.fill('#input', 'hello from ada');
    await host.press('#input', 'Enter');
    await guest.waitForFunction(
      () => document.getElementById('log').innerText.includes('hello from ada'),
      null,
      { timeout: 5000 },
    );
    assert.match(await logText(guest), /Ada · \d{1,2}:\d{2}/);

    await guest.fill('#input', 'and back from the animal');
    await guest.press('#input', 'Enter');
    await host.waitForFunction(
      () => document.getElementById('log').innerText.includes('and back from the animal'),
      null,
      { timeout: 5000 },
    );
  });

  /* ------------------------------------------ what the relay actually sees */

  await check('relayed frames contain no plaintext', async () => {
    const seen = [];
    const spy = new WebSocket(`ws://localhost:${PORT}/ws?room=${roomId}`);
    await new Promise((res, rej) => {
      spy.once('open', res);
      spy.once('error', rej);
    });
    spy.on('message', (raw) => seen.push(raw.toString()));

    const secret = 'grandmas maiden name is Wodehouse';
    await host.fill('#input', secret);
    await host.press('#input', 'Enter');
    await new Promise((r) => setTimeout(r, 700));
    spy.close();

    const relayed = seen.filter((s) => JSON.parse(s).t === 'relay');
    assert.ok(relayed.length > 0, 'spy saw no relayed frames');
    const all = seen.join('\n');
    for (const leak of [secret, 'Wodehouse', 'Ada', animal, 'hello from ada']) {
      assert.ok(!all.includes(leak), `plaintext "${leak}" visible to the relay`);
    }
  });

  await check('a wrong key cannot read the room', async () => {
    const impostor = await ctx();
    const wrongKey = 'A'.repeat(43);
    await impostor.goto(`${BASE}/r/${roomId}#${wrongKey}`);
    await impostor.waitForSelector('#nickGate:not([hidden])');
    await impostor.click('#skipNick');
    await impostor.waitForSelector('#input:not([disabled])');

    await host.fill('#input', 'only for real members');
    await host.press('#input', 'Enter');
    await new Promise((r) => setTimeout(r, 700));

    const log = await logText(impostor);
    assert.ok(!log.includes('only for real members'), 'impostor decrypted a message');
    assert.ok(!log.includes('Ada'), 'impostor learned a nickname');
    // The impostor is a connected socket, but never a room member.
    assert.equal((await text(impostor, '#peers')).match(/\(you\)/g).length, 1);
    await impostor.close();
  });

  /* ------------------------------------------------------------ call ---- */

  await check('audio call connects peer-to-peer', async () => {
    await host.click('#callBtn');
    await guest.click('#callBtn');

    const connected = (page) =>
      page.waitForFunction(
        () => document.getElementById('callStatus').innerText.includes('In the call with'),
        null,
        { timeout: 20000 },
      );
    await Promise.all([connected(host), connected(guest)]);

    // Media really is flowing: a remote audio element with a live track.
    await host.waitForFunction(
      () => {
        const el = document.querySelector('#audioSinks audio');
        return !!el?.srcObject && el.srcObject.getAudioTracks().length > 0;
      },
      null,
      { timeout: 20000 },
    );
  });

  await check('mute toggles the outgoing track', async () => {
    await host.click('#muteBtn');
    assert.equal(await text(host, '#muteBtn'), 'Unmute');
    await host.click('#muteBtn');
    assert.equal(await text(host, '#muteBtn'), 'Mute');
  });

  await check('leaving the call tears down the connection', async () => {
    await guest.click('#callBtn');
    await host.waitForFunction(
      () => document.getElementById('callStatus').innerText === 'In the call — waiting for someone else to join',
      null,
      { timeout: 8000 },
    );
    await host.click('#callBtn');
    assert.equal(await text(host, '#callStatus'), 'Not in the call');
  });

  /* ----------------------------------------------------------- expiry --- */

  await check('only the host sees the expiry control', async () => {
    assert.ok(await host.isVisible('#ttlBtn'));
    assert.ok(!(await guest.isVisible('#ttlBtn')));
  });

  await check('host can change how long the room stays open', async () => {
    await host.click('#ttlBtn');
    await host.selectOption('#ttlSelect', '180');
    await host.click('#saveTtl');
    await guest.waitForFunction(
      () => document.getElementById('log').innerText.includes('expires after 3 hours'),
      null,
      { timeout: 5000 },
    );
    const info = await (await fetch(`${BASE}/api/rooms/${roomId}`)).json();
    assert.equal(info.ttlMinutes, 180);
  });

  await check('a non-host cannot change the expiry', async () => {
    const res = await fetch(`${BASE}/api/rooms/${roomId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostToken: 'x'.repeat(32), ttlMinutes: 1440 }),
    });
    assert.equal(res.status, 403);
    const info = await (await fetch(`${BASE}/api/rooms/${roomId}`)).json();
    assert.equal(info.ttlMinutes, 180);
  });

  await check('ttl is clamped to the allowed range', async () => {
    const res = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlMinutes: 99999 }),
    });
    assert.equal((await res.json()).ttlMinutes, 1440);
  });

  await check('leaving is announced to the room', async () => {
    await guest.close();
    await host.waitForFunction(
      (n) => document.getElementById('log').innerText.includes(`${n} left.`),
      animal,
      { timeout: 5000 },
    );
    assert.equal(await text(host, '#count'), '1');
  });

  /* ------------------------------------------------- expiry enforcement -- */

  await check('an expired room is destroyed and its members evicted', async () => {
    // 5-minute floor on the API, so drive the clock from the inside instead.
    const short = await (
      await fetch(`${BASE}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ttlMinutes: 5 }),
      })
    ).json();

    const doomed = await ctx();
    await doomed.goto(`${BASE}/r/${short.roomId}#${keyFragment}`);
    await doomed.waitForSelector('#nickGate:not([hidden])');
    await doomed.click('#skipNick');
    await doomed.waitForSelector('#input:not([disabled])');

    // Restarting the server is the strongest possible statement that nothing
    // was persisted: the room cannot come back.
    await stopServer();
    await startServer();

    assert.equal((await fetch(`${BASE}/api/rooms/${short.roomId}`)).status, 404);
    await doomed.waitForSelector('#deadGate:not([hidden])', { timeout: 15000 });
    assert.match(await text(doomed, '#deadTitle'), /expired/i);
    await doomed.close();
  });

  await check('a bad link is refused', async () => {
    const broken = await ctx();
    await broken.goto(`${BASE}/r/${roomId}`); // no fragment at all
    await broken.waitForSelector('#deadGate:not([hidden])', { timeout: 5000 });
    assert.match(await text(broken, '#deadTitle'), /Broken link/);
    await broken.close();
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} checks passed`);
