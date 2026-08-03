import { newRoomSecret, toB64Url } from '/js/crypto.js';
import { $, registerServiceWorker, setupInstall, segmented, formatTtl } from '/js/ui.js';

registerServiceWorker();
setupInstall($('install'));

let ttlMinutes = 30;

segmented($('ttlPicker'), 'ttl', (value) => {
  ttlMinutes = value;
  $('ttlLabel').textContent = formatTtl(value);
});

$('create').addEventListener('click', async () => {
  const btn = $('create');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  $('err').textContent = '';

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlMinutes }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not create the room');
    const { roomId, hostToken } = await res.json();

    // The host token proves to the server that we may change the expiry. It
    // stays in this tab and is never part of the shareable link.
    sessionStorage.setItem(`host:${roomId}`, hostToken);

    location.href = `/r/${roomId}#${toB64Url(newRoomSecret())}`;
  } catch (err) {
    $('err').textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Create room';
  }
});
