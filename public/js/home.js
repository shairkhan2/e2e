import { newRoomSecret, toB64Url } from '/js/crypto.js';

const btn = document.getElementById('create');
const err = document.getElementById('err');

btn.addEventListener('click', async () => {
  btn.disabled = true;
  err.textContent = '';
  try {
    const ttlMinutes = Number(document.getElementById('ttl').value);
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttlMinutes }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'could not create room');
    const { roomId, hostToken } = await res.json();

    // The host token proves to the server that we may change the expiry. It
    // is scoped to this tab and is never part of the shareable link.
    sessionStorage.setItem(`host:${roomId}`, hostToken);

    const secret = toB64Url(newRoomSecret());
    location.href = `/r/${roomId}#${secret}`;
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false;
  }
});
