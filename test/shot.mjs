// Dev utility: drives two browsers into a room and screenshots it.
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
const page = async () => {
  const c = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1180, height: 760 },
    deviceScaleFactor: 2,
  });
  return c.newPage();
};

const host = await page();
await host.goto(BASE);
await host.screenshot({ path: `${out}/01-landing.png` });

await host.click('#create');
await host.waitForURL(/\/r\//);
await host.fill('#nickInput', 'Ada');
await host.click('#nickForm button[type=submit]');
await host.waitForSelector('#input:not([disabled])');
const url = host.url();

const guest = await page();
await guest.goto(url);
await guest.waitForSelector('#nickGate:not([hidden])');
await guest.screenshot({ path: `${out}/02-nickname.png` });
await guest.click('#skipNick');
await guest.waitForSelector('#input:not([disabled])');

const say = async (p, t) => {
  await p.fill('#input', t);
  await p.press('#input', 'Enter');
  await sleep(320);
};
await say(host, 'link works? you got in fine');
await say(guest, 'yeah, tapped it and I was straight in — no signup');
await say(host, 'joining the call now');
await say(guest, "one sec, mic permission");

await host.click('#callBtn');
await guest.click('#callBtn');
await host
  .waitForFunction(() => document.getElementById('callStatus').innerText.includes('In the call with'), null, {
    timeout: 20000,
  })
  .catch(() => {});
await sleep(600);
await host.screenshot({ path: `${out}/03-room.png` });

await host.click('#inviteBtn');
await sleep(300);
await host.screenshot({ path: `${out}/04-invite.png` });

await browser.close();
server.kill();
console.log('screenshots written to', out);
