// Who is talking right now.
//
// Reads the audio level of each stream locally, in the browser that already
// has the decrypted audio. Nothing about it is sent anywhere — the ring around
// an avatar is computed on the device that draws it.

const SPEAKING_ON = 0.045; // RMS to start showing someone as speaking
const SPEAKING_OFF = 0.025; // and the lower bar to stop — hysteresis, not flicker
const HOLD_MS = 420; // keep the ring up briefly through natural pauses

export function createLevelMonitor(onChange) {
  let ctx = null;
  const tracked = new Map(); // id -> { analyser, source, buf, speaking, until }
  let raf = null;

  function ensureCtx() {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    // Mobile browsers hand back a suspended context outside a gesture.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function attach(id, stream) {
    if (!stream?.getAudioTracks().length || tracked.has(id)) return;
    try {
      const audio = ensureCtx();
      const source = audio.createMediaStreamSource(stream);
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      // Deliberately not connected to the destination: the <audio> element
      // does the playing, this branch only measures.
      source.connect(analyser);
      tracked.set(id, {
        analyser,
        source,
        buf: new Float32Array(analyser.fftSize),
        speaking: false,
        until: 0,
      });
      start();
    } catch {
      /* an unsupported context just means no speaking rings */
    }
  }

  function detach(id) {
    const t = tracked.get(id);
    if (!t) return;
    try {
      t.source.disconnect();
    } catch {}
    tracked.delete(id);
    if (t.speaking) onChange(id, false);
    if (!tracked.size) stop();
  }

  function tick() {
    const now = performance.now();
    for (const [id, t] of tracked) {
      t.analyser.getFloatTimeDomainData(t.buf);
      let sum = 0;
      for (let i = 0; i < t.buf.length; i++) sum += t.buf[i] * t.buf[i];
      const rms = Math.sqrt(sum / t.buf.length);

      if (rms > SPEAKING_ON) t.until = now + HOLD_MS;
      else if (t.speaking && rms > SPEAKING_OFF) t.until = Math.max(t.until, now + HOLD_MS / 2);
      const speaking = t.until > now;

      if (speaking !== t.speaking) {
        t.speaking = speaking;
        onChange(id, speaking);
      }
    }
    raf = requestAnimationFrame(tick);
  }

  const start = () => {
    raf ??= requestAnimationFrame(tick);
  };
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  };

  function stopAll() {
    for (const id of [...tracked.keys()]) detach(id);
    stop();
    ctx?.close().catch(() => {});
    ctx = null;
  }

  return { attach, detach, stopAll };
}
