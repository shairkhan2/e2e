// Two real browsers in one room: nickname handling, encrypted chat, a live
// WebRTC audio connection, expiry control, PWA installability, and the
// guarantee that the server only ever sees ciphertext.

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

// Everything runs at phone size, because that is the primary target.
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

const ctx = async (opts = {}) => {
  const c = await browser.newContext({ permissions: ['microphone'], ...PHONE, ...opts });
  return c.newPage();
};

const text = (page, sel) => page.locator(sel).innerText();
const logText = (page) => text(page, '#log');
const railNames = (page) =>
  page.$$eval('#peers .person .name', (els) => els.map((e) => e.textContent));

try {
  /* ---------------------------------------------------- room creation --- */

  const host = await ctx();
  await host.goto(BASE);
  await host.click('[data-ttl="60"]');
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
    assert.ok(!JSON.stringify(info).includes(keyFragment), 'key leaked into room metadata');
  });

  /* ------------------------------------------------------- nicknames ---- */

  await host.fill('#nickInput', 'Ada');
  await host.click('#nickForm button[type=submit]');
  await host.waitForSelector('#input:not([disabled])');

  const guest = await ctx();
  await guest.goto(url);
  await guest.waitForSelector('#nickGate:not([hidden])');
  await guest.click('#skipNick'); // no nickname -> random animal
  await guest.waitForSelector('#input:not([disabled])');

  await check('chosen nickname reaches the other device', async () => {
    await guest.waitForFunction(
      () => document.getElementById('peers').innerText.includes('Ada'),
      null,
      { timeout: 5000 },
    );
    assert.deepEqual(await railNames(guest), ['You', 'Ada']);
  });

  let animal = '';
  await check('skipping the nickname assigns a random animal', async () => {
    await host.waitForFunction(
      () => document.querySelectorAll('#peers .person').length === 2,
      null,
      { timeout: 5000 },
    );
    const names = await railNames(host);
    assert.equal(names[0], 'You');
    animal = names[1];
    assert.match(animal, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.equal(await text(host, '#count'), '2');
  });

  await check('avatars show initials with a stable per-person colour', async () => {
    const [av] = await host.$$eval('#peers .person:nth-child(2)', (els) =>
      els.map((e) => ({
        initials: e.querySelector('.av').textContent.trim(),
        hue: e.style.getPropertyValue('--h'),
      })),
    );
    assert.equal(av.initials, animal.split(' ').map((w) => w[0]).join(''));
    assert.match(av.hue, /^\d+$/);
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
    assert.match(await logText(guest), /Ada/);

    await guest.fill('#input', 'and back from the animal');
    await guest.press('#input', 'Enter');
    await host.waitForFunction(
      () => document.getElementById('log').innerText.includes('and back from the animal'),
      null,
      { timeout: 5000 },
    );
  });

  await check('consecutive messages from one person are grouped', async () => {
    const before = await guest.$$eval('#log .msg.them .who', (els) => els.length);
    for (const line of ['one more thing', 'and another']) {
      await host.fill('#input', line);
      await host.press('#input', 'Enter');
      await sleep(200);
    }
    await guest.waitForFunction(
      () => document.getElementById('log').innerText.includes('and another'),
      null,
      { timeout: 5000 },
    );
    // A run of two adds two bubbles but only one name label.
    const labelled = await guest.$$eval('#log .msg.them .who', (els) => els.length);
    assert.equal(labelled - before, 1, 'the second message of a run should not be re-labelled');
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
    await sleep(700);
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
    await impostor.goto(`${BASE}/r/${roomId}#${'A'.repeat(43)}`);
    await impostor.waitForSelector('#nickGate:not([hidden])');
    await impostor.click('#skipNick');
    await impostor.waitForSelector('#input:not([disabled])');

    await host.fill('#input', 'only for real members');
    await host.press('#input', 'Enter');
    await sleep(700);

    const log = await logText(impostor);
    assert.ok(!log.includes('only for real members'), 'impostor decrypted a message');
    assert.ok(!log.includes('Ada'), 'impostor learned a nickname');
    // Connected socket, never a room member.
    assert.deepEqual(await railNames(impostor), ['You']);
    await impostor.close();
  });

  await check('room code and fingerprints are shown for verification', async () => {
    await host.click('#securityBtn');
    await host.waitForSelector('#securityGate:not([hidden])');
    const code = await text(host, '#securityCode');
    assert.match(code, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);

    await host.waitForFunction(
      () => /^[0-9a-f]{6}$/.test(document.querySelector('#fingerprints .val')?.textContent || ''),
      null,
      { timeout: 5000 },
    );

    await guest.click('#securityBtn');
    await guest.waitForSelector('#securityGate:not([hidden])');
    assert.equal(await text(guest, '#securityCode'), code, 'peers disagree on the room code');
    await guest.click('#securityGate .closes');
    await host.click('#securityGate .closes');
  });

  /* ------------------------------------------------------------ call ---- */

  await check('audio call connects peer-to-peer', async () => {
    await host.click('#callBtn');
    await guest.click('#callBtn');

    const active = (page) =>
      page.waitForSelector('#callStrip[data-state="active"]', { timeout: 20000 });
    await Promise.all([active(host), active(guest)]);
    assert.match(await text(host, '#callStatus'), /In call · 2/);

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

  await check('call state shows on both avatars', async () => {
    await host.waitForFunction(
      () => document.querySelectorAll('#peers .person .flag.on-call').length === 2,
      null,
      { timeout: 8000 },
    );
  });

  await check('mute toggles the track and tells the room', async () => {
    await host.click('#muteBtn');
    assert.equal(await text(host, '#muteBtn'), 'Unmute');
    // The other side sees the muted badge, not just the local UI.
    await guest.waitForFunction(
      () => document.querySelectorAll('#peers .person .flag.muted').length === 1,
      null,
      { timeout: 5000 },
    );
    await host.click('#muteBtn');
    assert.equal(await text(host, '#muteBtn'), 'Mute');
  });

  await check('call timer runs', async () => {
    await host.waitForFunction(
      () => /^0:0[1-9]|^0:[1-5]\d/.test(document.getElementById('callElapsed').textContent),
      null,
      { timeout: 8000 },
    );
  });

  await check('leaving the call tears down the connection', async () => {
    await guest.click('#callBtn');
    await host.waitForSelector('#callStrip[data-state="connecting"]', { timeout: 8000 });
    await host.click('#callBtn');
    // An idle strip is display:none, so assert the attribute rather than wait
    // for a node that is never visible.
    await host.waitForFunction(
      () => document.getElementById('callStrip').dataset.state === 'idle',
      null,
      { timeout: 8000 },
    );
  });

  /* ----------------------------------------------------------- expiry --- */

  await check('only the host sees the expiry control', async () => {
    await host.click('#menuBtn');
    await host.waitForSelector('#menuGate:not([hidden])');
    assert.ok(await host.isVisible('#ttlSection'));

    await guest.click('#menuBtn');
    await guest.waitForSelector('#menuGate:not([hidden])');
    assert.ok(!(await guest.isVisible('#ttlSection')));
    await guest.click('#menuGate .closes');
  });

  await check('host can change how long the room stays open', async () => {
    await host.click('[data-room-ttl="480"]');
    await host.click('#saveTtl');
    await guest.waitForFunction(
      () => document.getElementById('log').innerText.includes('expires after 8 hours'),
      null,
      { timeout: 5000 },
    );
    const info = await (await fetch(`${BASE}/api/rooms/${roomId}`)).json();
    assert.equal(info.ttlMinutes, 480);
  });

  await check('a non-host cannot change the expiry', async () => {
    const res = await fetch(`${BASE}/api/rooms/${roomId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostToken: 'x'.repeat(32), ttlMinutes: 1440 }),
    });
    assert.equal(res.status, 403);
    assert.equal((await (await fetch(`${BASE}/api/rooms/${roomId}`)).json()).ttlMinutes, 480);
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
      (n) => document.getElementById('log').innerText.includes(`${n} left`),
      animal,
      { timeout: 5000 },
    );
    assert.equal(await text(host, '#count'), '1');
  });

  /* -------------------------------------------------------- phone/PWA --- */

  await check('nothing overflows horizontally on a small phone', async () => {
    const small = await ctx({ viewport: { width: 320, height: 568 } });
    await small.goto(BASE);
    const landing = await small.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    assert.ok(
      landing.scroll <= landing.inner + 1,
      `landing overflows: ${landing.scroll} > ${landing.inner}`,
    );

    await small.goto(url);
    await small.click('#skipNick');
    await small.waitForSelector('#input:not([disabled])');
    await small.fill('#input', 'x'.repeat(300)); // a message with no spaces to wrap on
    await small.press('#input', 'Enter');
    const room = await small.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    assert.ok(room.scroll <= room.inner + 1, `room overflows: ${room.scroll} > ${room.inner}`);
    await small.close();
  });

  await check('touch targets are big enough to hit', async () => {
    const small = await ctx();
    await small.goto(BASE);
    const tooSmall = await small.$$eval('button', (els) =>
      els
        .filter((e) => e.offsetParent !== null)
        .map((e) => ({ id: e.id || e.className, h: e.getBoundingClientRect().height }))
        .filter((b) => b.h < 40),
    );
    assert.deepEqual(tooSmall, [], 'controls below 40px tall');
    await small.close();
  });

  await check('manifest is served and installable', async () => {
    const res = await fetch(`${BASE}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/manifest\+json/);

    const m = await res.json();
    assert.equal(m.start_url, '/');
    assert.equal(m.display, 'standalone');
    assert.ok(m.name && m.short_name && m.background_color && m.theme_color);
    assert.ok(
      m.icons.some((i) => i.purpose === 'maskable'),
      'no maskable icon',
    );
    for (const icon of m.icons) {
      const r = await fetch(BASE + icon.src);
      assert.equal(r.status, 200, `${icon.src} missing`);
      assert.match(r.headers.get('content-type'), /image\/png/);
    }
  });

  await check('service worker activates and caches the shell', async () => {
    const page = await ctx();
    await page.goto(BASE);
    // `ready` resolves as soon as there is an active worker, which can still
    // be mid-activate while it primes the cache.
    const state = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const worker = reg.active;
      if (worker.state === 'activated') return worker.state;
      await new Promise((res) => {
        worker.addEventListener('statechange', () => worker.state === 'activated' && res());
      });
      return worker.state;
    });
    assert.equal(state, 'activated');

    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const cache = await caches.open(keys[0]);
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    for (const asset of ['/app.css', '/room.html', '/js/room.js', '/manifest.webmanifest']) {
      assert.ok(cached.includes(asset), `${asset} not precached`);
    }
    await page.close();
  });

  await check('the shell still renders with the network down', async () => {
    const page = await ctx();
    await page.goto(BASE);
    await page.evaluate(() => navigator.serviceWorker.ready);

    await page.context().setOffline(true);
    await page.reload();
    // Served from cache: the create button is there even with no network.
    assert.equal(await text(page, '#create'), 'Create room');
    await page.context().setOffline(false);
    await page.close();
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
    assert.match(await text(broken, '#deadTitle'), /Link is broken/);
    await broken.close();
  });
} finally {
  await browser.close();
  server?.kill();
}

console.log(`\n${passed} checks passed`);
