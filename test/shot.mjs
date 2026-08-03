// Dev utility: drives two browsers into a room and screenshots it.
// node test/shot.mjs [outdir]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 8123;
const BASE = `http://localhost:${PORT}`;
const out = process.argv[2] || '/tmp';

const server = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'inherit',
});
process.on('exit', () => server.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(900);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});

const phone = async () =>
  (
    await browser.newContext({
      permissions: ['microphone'],
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    })
  ).newPage();

const desktop = async () =>
  (
    await browser.newContext({
      permissions: ['microphone'],
      viewport: { width: 1220, height: 780 },
      deviceScaleFactor: 2,
    })
  ).newPage();

const host = await phone();
await host.goto(BASE);
await sleep(300);
await host.screenshot({ path: `${out}/01-landing.png` });

await host.click('#create');
await host.waitForURL(/\/r\//);
await sleep(400);
await host.screenshot({ path: `${out}/02-nickname.png` });
await host.fill('#nickInput', 'Ada');
await host.click('#nickForm button[type=submit]');
await host.waitForSelector('#input:not([disabled])');
const url = host.url();

const guest = await phone();
await guest.goto(url);
await guest.waitForSelector('#nickGate:not([hidden])');
await guest.click('#skipNick');
await guest.waitForSelector('#input:not([disabled])');

const say = async (p, t) => {
  await p.fill('#input', t);
  await p.press('#input', 'Enter');
  await sleep(320);
};
await say(host, 'link worked?');
await say(guest, 'yeah, tapped it and I was in');
await say(guest, 'no signup at all, nice');
await say(host, 'calling you now');

await host.click('#callBtn');
await guest.click('#callBtn');
await host.waitForSelector('#callStrip[data-state="active"]', { timeout: 20000 }).catch(() => {});
await sleep(1400);
await host.screenshot({ path: `${out}/03-room-phone.png` });

await host.click('#inviteBtn');
await sleep(400);
await host.screenshot({ path: `${out}/04-invite.png` });
await host.click('#inviteGate .closes');

await host.click('#securityBtn');
await sleep(400);
await host.screenshot({ path: `${out}/05-security.png` });
await host.click('#securityGate .closes');

// Same room, desktop layout.
const wide = await desktop();
await wide.goto(url);
await wide.waitForSelector('#nickGate:not([hidden])');
await wide.fill('#nickInput', 'Grace');
await wide.click('#nickForm button[type=submit]');
await wide.waitForSelector('#input:not([disabled])');
await say(wide, 'joining from a laptop — same room');
await sleep(600);
await wide.screenshot({ path: `${out}/06-room-desktop.png` });

await browser.close();
server.kill();
console.log('screenshots written to', out);
