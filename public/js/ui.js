// Small shared UI helpers: sheets, avatars, PWA install, screen wake lock.

export const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------- service worker */

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Registration failure is never fatal — the app works fine without it.
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

/* ------------------------------------------------------------ install ---- */

/** Wire an "add to home screen" button, shown only when the browser offers it. */
export function setupInstall(button) {
  if (!button) return;
  let deferred = null;

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    button.hidden = false;
  });

  button.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    button.hidden = true;
  });

  addEventListener('appinstalled', () => {
    button.hidden = true;
  });
}

/* ------------------------------------------------------------- sheets ---- */

const dismissible = new WeakSet();

export function openSheet(el) {
  el.hidden = false;
}

export function closeSheet(el) {
  el.hidden = true;
}

/**
 * Sheets close on their own [.closes] buttons, on a tap outside the panel, and
 * on Escape — unless they are a gate the user must answer.
 */
export function wireSheet(el, { canDismiss = true } = {}) {
  if (canDismiss) dismissible.add(el);

  el.addEventListener('click', (e) => {
    if (e.target === el && canDismiss) closeSheet(el);
    if (e.target.closest('.closes')) closeSheet(el);
  });
}

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const el of document.querySelectorAll('.scrim:not([hidden])')) {
    if (dismissible.has(el)) closeSheet(el);
  }
});

/* ------------------------------------------------------------ avatars ---- */

/** Stable hue per person, so the same nickname always looks the same. */
export function hueFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/* --------------------------------------------------------- segmented ----- */

// `attr` is the HTML attribute suffix (data-room-ttl -> "room-ttl"); the
// matching dataset property is its camelCase form. Keeping both in one place
// stops the two spellings from drifting apart.
const datasetKey = (attr) => attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** Turn a group of buttons into a single-choice picker. */
export function segmented(container, attr, onPick) {
  const key = datasetKey(attr);
  container.addEventListener('click', (e) => {
    const btn = e.target.closest(`[data-${attr}]`);
    if (!btn) return;
    select(container, attr, btn.dataset[key]);
    onPick?.(Number(btn.dataset[key]));
  });
}

export function select(container, attr, value) {
  const key = datasetKey(attr);
  for (const b of container.querySelectorAll(`[data-${attr}]`)) {
    b.setAttribute('aria-pressed', String(b.dataset[key] === String(value)));
  }
}

export function formatTtl(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = minutes / 60;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/* ---------------------------------------------------------- wake lock ---- */

// Phones dim and sleep mid-call otherwise, which drops the tab's audio focus.
let lock = null;
let wanted = false;

export async function holdScreenAwake() {
  wanted = true;
  try {
    lock = await navigator.wakeLock?.request('screen');
  } catch {
    /* denied or unsupported — not worth surfacing */
  }
}

export function releaseScreen() {
  wanted = false;
  lock?.release().catch(() => {});
  lock = null;
}

// The browser drops a wake lock whenever the tab is hidden; take it again on
// return, but only if the call is still running.
addEventListener('visibilitychange', () => {
  if (wanted && document.visibilityState === 'visible') holdScreenAwake();
});
