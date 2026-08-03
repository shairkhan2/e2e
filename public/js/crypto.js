// End-to-end crypto for rooms.
//
// The room secret is 32 random bytes generated in the creator's browser and
// carried in the URL fragment. Fragments are never transmitted in an HTTP
// request, so the server can hold the room id without ever holding the key.
//
// Every payload is sign-then-encrypt:
//   inner  = JSON of the actual message (chat text, SDP, nickname, ...)
//   signed = { b: inner, s: ECDSA-P256 signature over b, k: sender pubkey }
//   wire   = AES-256-GCM(signed) under a key derived from the room secret
//
// Encrypting the signature too means the relay learns nothing at all: not who
// spoke, not how long the message was beyond a padded ciphertext length.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

export function fromB64(str) {
  const norm = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm.padEnd(Math.ceil(norm.length / 4) * 4, '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const toB64Url = (bytes) =>
  toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function newRoomSecret() {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Derive the room's AES-GCM envelope key from the raw secret. */
async function deriveEnvelopeKey(secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode('e2e-vc/v1/salt'),
      info: enc.encode('envelope'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Short human-comparable fingerprint of the room secret. Two people reading
 * the same code aloud know they are in the same room under the same key —
 * the defence against a link being swapped in transit.
 */
async function roomCode(secret) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', secret));
  const hex = [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.toUpperCase().match(/.{1,4}/g).join('-');
}

export async function createSession(secret) {
  const key = await deriveEnvelopeKey(secret);
  const code = await roomCode(secret);

  // Per-session identity. Ephemeral: it exists only while this tab is open,
  // so there is no long-lived identifier to correlate rooms by.
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('spki', signing.publicKey));
  const pubB64 = toB64(pubRaw);

  let seq = 0;
  const knownKeys = new Map(); // peerId -> { pubB64, key }
  const lastSeq = new Map(); // peerId -> highest accepted seq

  async function seal(peerId, kind, fields) {
    const inner = JSON.stringify({ from: peerId, kind, seq: ++seq, ts: Date.now(), ...fields });
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signing.privateKey,
        enc.encode(inner),
      ),
    );
    const signed = enc.encode(JSON.stringify({ b: inner, s: toB64(sig), k: pubB64 }));

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, signed));

    const wire = new Uint8Array(iv.length + ct.length);
    wire.set(iv, 0);
    wire.set(ct, iv.length);
    return toB64(wire);
  }

  /**
   * Open an envelope. `claimedFrom` is the peer id the relay attributed the
   * message to; it is only believed if the signature agrees with it.
   * Returns null whenever anything fails to check out.
   */
  async function open(claimedFrom, wireB64) {
    let signed;
    try {
      const wire = fromB64(wireB64);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: wire.slice(0, 12) },
        key,
        wire.slice(12),
      );
      signed = JSON.parse(dec.decode(plain));
    } catch {
      return null; // wrong key, or tampered ciphertext
    }

    if (typeof signed.b !== 'string' || typeof signed.s !== 'string' || typeof signed.k !== 'string')
      return null;

    // First pubkey seen for a peer id is the one that peer keeps. A relay
    // that later tries to substitute its own key for that peer is rejected.
    const known = knownKeys.get(claimedFrom);
    if (known && known.pubB64 !== signed.k) return null;

    let verifyKey = known?.key;
    if (!verifyKey) {
      try {
        verifyKey = await crypto.subtle.importKey(
          'spki',
          fromB64(signed.k),
          { name: 'ECDSA', namedCurve: 'P-256' },
          true,
          ['verify'],
        );
      } catch {
        return null;
      }
      knownKeys.set(claimedFrom, { pubB64: signed.k, key: verifyKey });
    }

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      fromB64(signed.s),
      enc.encode(signed.b),
    );
    if (!ok) return null;

    let inner;
    try {
      inner = JSON.parse(signed.b);
    } catch {
      return null;
    }

    // The signature covers `from`, so a peer cannot have their traffic
    // replayed by the relay as if it came from somebody else.
    if (inner.from !== claimedFrom) return null;

    // Strictly increasing sequence numbers kill replay within a room.
    const prev = lastSeq.get(claimedFrom) ?? 0;
    if (!Number.isInteger(inner.seq) || inner.seq <= prev) return null;
    lastSeq.set(claimedFrom, inner.seq);

    return inner;
  }

  function forget(peerId) {
    knownKeys.delete(peerId);
    lastSeq.delete(peerId);
  }

  /** Stable per-peer fingerprint, shown next to a nickname. */
  async function peerFingerprint(peerId) {
    const known = knownKeys.get(peerId);
    if (!known) return null;
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', fromB64(known.pubB64)));
    return [...d.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  return { seal, open, forget, peerFingerprint, roomCode: code };
}
