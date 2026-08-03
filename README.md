# vc — ephemeral end-to-end encrypted rooms

Open the site, create a room, send the link. Whoever taps it picks a nickname
(or doesn't, and becomes a *Quiet Otter*) and lands straight in — no account, no
app, no install. Inside the room they can chat and join an audio call. The room
deletes itself after a period of inactivity, which the creator controls.

Messages and audio are end-to-end encrypted. The server relays ciphertext and
holds no keys.

```bash
npm install
npm start          # http://localhost:8080
npm test           # two real browsers in one room
```

`PORT` overrides the listen port. There is no database, no config file, and no
state on disk — rooms live in memory and die with the process.

## How the encryption works

**The key lives in the link.** Creating a room generates 32 random bytes in the
browser. They go in the URL *fragment*:

```
https://example.com/r/o8DYQMaKRCdV#kzB1n_S6…
                    └─ room id ──┘ └─ key ─┘
                    server sees    server never sees
```

Browsers do not transmit the fragment in an HTTP request. The server allocates
the room id and knows nothing else. Possession of the link *is* membership,
which is exactly the property asked for: tap it and you're in.

**Every payload is sign-then-encrypt.** Chat text, nicknames, call state, and
the WebRTC SDP all travel the same path:

```
inner  = {from, kind, seq, ts, …}
signed = {b: inner, s: ECDSA-P256(inner), k: sender pubkey}
wire   = AES-256-GCM(signed)      key = HKDF-SHA256(room secret)
```

The signature is *inside* the ciphertext, so the relay cannot even tell two
messages came from the same person beyond the peer id it assigned. On receipt a
message is dropped unless it decrypts, the signature verifies, the signed
`from` matches the peer the relay attributed it to, the public key matches the
first one seen for that peer, and the sequence number advances. That covers
tampering, cross-attribution, and replay.

**Audio is peer-to-peer.** WebRTC media is always DTLS-SRTP encrypted, but in a
normal deployment the signalling server can rewrite the DTLS fingerprints in
transit and sit in the middle. Here the SDP is sealed under the room key before
it is relayed, so the fingerprints are unreadable and unforgeable to the server.
Media then flows directly between browsers and never touches the server at all.

**Verify out of band.** The header shows a room code — the first 48 bits of
`SHA-256(room secret)`. Everyone who opened the same link sees the same code.
Read it aloud on the call and you know nobody was handed a substituted link.
Each participant also carries a short fingerprint of their signing key.

## Expiry

A room has an inactivity window, default 30 minutes, set by the creator at
creation and changeable at any time from the header. Messages, joins, and an
active call all reset the clock; an idle room is swept and its sockets closed
with an "expired" notice. The creator holds a host token that stays in their
tab's `sessionStorage` and is never part of the shareable link — nobody else can
extend the room.

Allowed range is 5 minutes to 24 hours. Nothing survives expiry: no transcript,
no logs, no recording. Restarting the server has the same effect.

## What this does and does not protect

Protected:

- The server operator cannot read messages, hear the call, or see nicknames.
- Anyone who intercepts traffic to the server sees only ciphertext.
- A malicious server cannot MITM the call by rewriting DTLS fingerprints.
- A participant cannot forge messages from another participant.
- Content is gone after expiry because it was never stored.

Not protected:

- **Anyone with the link is a member.** There is no per-person identity — that
  is the trade for zero sign-up. Send links over a channel you trust, and treat
  a leaked link as a leaked room.
- **The link is the key.** Anywhere it gets logged — a chat history, a URL
  preview bot, a screenshot — the room is readable. Prefer short expiries.
- **Metadata.** The server sees room ids, connection timing, message sizes, and
  who is connected at once. Audio packet timing can leak speech patterns; this
  build does not pad.
- **Endpoints.** E2EE protects the wire, not a compromised device.
- **Membership changes.** The room key is fixed for the room's life, so someone
  who leaves can still decrypt anything they capture afterwards. Rotate by
  making a new room.

## Deployment notes

- **Serve over HTTPS.** `crypto.subtle` and `getUserMedia` require a secure
  context — everything except `localhost` needs TLS.
- **NAT traversal.** Public STUN only, configured in `public/js/rtc.js`. Peers
  behind symmetric NAT will fail to connect the audio call; add a TURN server to
  `ICE_SERVERS` for those. Note that TURN relays media, so pick one you trust —
  it still cannot decrypt, but it does see the flow.
- **Group size.** The call is a full mesh: *n*−1 connections per participant.
  Comfortable to about 5, capped at 12 by `MAX_PEERS` in `server.js`. Beyond
  that you want an SFU, and a plain SFU gives up end-to-end encryption unless
  you add WebRTC Encoded Transform on top.
- **A strict CSP** (`default-src 'self'`, no inline script) is served with every
  page. Keep it: it is what stops an injected script from exfiltrating the room
  key sitting in `location.hash`.

## Layout

```
server.js              relay + room lifecycle; sees only ciphertext
public/index.html      create a room
public/room.html       the room shell
public/js/crypto.js    HKDF, AES-GCM sealing, ECDSA signing, replay defence
public/js/rtc.js       WebRTC audio mesh, perfect negotiation
public/js/room.js      presence, chat, call, expiry
public/js/names.js     nickname normalisation and animal names
test/e2e.test.mjs      two browsers, one room
```
