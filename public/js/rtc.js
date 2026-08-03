// WebRTC audio mesh.
//
// Every participant dials every other participant directly, so audio never
// passes through the server at all. WebRTC media is always encrypted with
// DTLS-SRTP; what makes it *end to end* here is that the DTLS fingerprints
// live inside SDP that we relay as ciphertext under the room key. The server
// cannot read or rewrite a fingerprint, so it cannot insert itself as a
// middlebox the way plain WebRTC signalling would allow.
//
// Mesh cost is quadratic, which is why the room caps out at a small group.

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];

export function createMesh(opts) {
  // `selfId` is read lazily: the mesh is constructed before the socket has
  // handed us an id, and the polite/impolite rule depends on it.
  const { sendSignal, onTrack, onPeerState } = opts;
  /** @type {Map<string, PeerConn>} */
  const peers = new Map();
  let localStream = null;

  function ensure(peerId) {
    let p = peers.get(peerId);
    if (p) return p;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // "Perfect negotiation": one side is polite and yields on collision. A
    // stable rule both sides can compute without another round trip.
    const polite = opts.selfId > peerId;
    p = { pc, polite, makingOffer: false, ignoreOffer: false, senders: [] };
    peers.set(peerId, p);

    if (localStream) addLocalTracks(p, localStream);

    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        sendSignal(peerId, { sdp: pc.localDescription });
      } catch (err) {
        console.warn('negotiation failed', err);
      } finally {
        p.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal(peerId, { candidate });
    };

    pc.ontrack = ({ track, streams }) => {
      onTrack?.(peerId, streams[0] || new MediaStream([track]));
    };

    pc.onconnectionstatechange = () => {
      onPeerState?.(peerId, pc.connectionState);
      if (pc.connectionState === 'failed') pc.restartIce();
    };

    return p;
  }

  function addLocalTracks(p, stream) {
    for (const track of stream.getTracks()) {
      p.senders.push(p.pc.addTrack(track, stream));
    }
  }

  /** Publish (or replace) our microphone across every existing connection. */
  function setLocalStream(stream) {
    localStream = stream;
    for (const p of peers.values()) {
      if (p.senders.length) {
        const audio = stream?.getAudioTracks()[0] || null;
        p.senders.forEach((s) => s.replaceTrack(audio));
      } else if (stream) {
        addLocalTracks(p, stream);
      }
    }
  }

  /** Open a connection to a peer. Negotiation starts on its own from here. */
  function connect(peerId) {
    ensure(peerId);
  }

  async function handleSignal(peerId, msg) {
    const p = ensure(peerId);
    const { pc } = p;

    try {
      if (msg.sdp) {
        const offerCollision =
          msg.sdp.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');

        p.ignoreOffer = !p.polite && offerCollision;
        if (p.ignoreOffer) return;

        await pc.setRemoteDescription(msg.sdp);
        if (msg.sdp.type === 'offer') {
          await pc.setLocalDescription();
          sendSignal(peerId, { sdp: pc.localDescription });
        }
      } else if (msg.candidate) {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (err) {
          if (!p.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('signal handling failed', err);
    }
  }

  function disconnect(peerId) {
    const p = peers.get(peerId);
    if (!p) return;
    p.pc.onicecandidate = null;
    p.pc.ontrack = null;
    p.pc.onnegotiationneeded = null;
    p.pc.onconnectionstatechange = null;
    p.pc.close();
    peers.delete(peerId);
    onPeerState?.(peerId, 'closed');
  }

  function stopAll() {
    for (const peerId of [...peers.keys()]) disconnect(peerId);
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  return { connect, handleSignal, disconnect, stopAll, setLocalStream, peers };
}
