// Runs in the YouTube page itself (content script with "world": "MAIN"),
// because only there can the player's MediaSource buffers be seen
// (roadmap step 1.5). It taps them with MseTap and forwards the decoded
// 16 kHz audio to the extension's content script, tagged with the player's
// blob: URL so the extension can tell which <video> it belongs to.
//
// Messages (window.postMessage, `__cleanEars: 1`):
//   { type: 'pcm', src, time, samples }   ~250 ms of audio starting at media time `time`
//   { type: 'pcm48', src, time, rate, channels, pcm }   ~1 s of full-rate audio
//        (interleaved Int16Array), only while the content script has asked for
//        it with { type: 'fullAudio', on: true } (roadmap step 4.2: the
//        companion app separates voices from music, which needs full quality)
(function () {
  if (window.__cleanEarsBridge) return;
  window.__cleanEarsBridge = true;

  const SR = 16000;
  const BATCH = 0.25; // seconds of audio per message

  const pending = new Map(); // stream -> { time, parts: [Float32Array], n }

  function send(stream, p) {
    const src = stream.src();
    if (!src || !p.n) return;
    const samples = new Float32Array(p.n);
    let o = 0;
    for (const part of p.parts) {
      samples.set(part, o);
      o += part.length;
    }
    window.postMessage({ __cleanEars: 1, type: 'pcm', src, time: p.time, samples }, '*', [samples.buffer]);
  }

  // Full-rate audio, batched to ~1 s, only while asked for.
  const FULL_BATCH = 1.0;
  let fullOn = false;
  const fullPending = new Map(); // stream -> { time, rate, channels, parts, n }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source === window && m && m.__cleanEars === 1 && m.type === 'fullAudio') {
      fullOn = !!m.on;
      if (!fullOn) fullPending.clear();
    }
  });

  function sendFull(stream, p) {
    const src = stream.src();
    if (!src || !p.n) return;
    const pcm = new Int16Array(p.n * p.channels);
    let o = 0;
    for (const planes of p.parts) {
      const len = planes[0].length;
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < p.channels; c++) {
          const v = Math.max(-1, Math.min(1, planes[c] ? planes[c][i] : planes[0][i]));
          pcm[o++] = v < 0 ? v * 32768 : v * 32767;
        }
      }
    }
    window.postMessage({ __cleanEars: 1, type: 'pcm48', src, time: p.time, rate: p.rate, channels: p.channels, pcm }, '*', [pcm.buffer]);
  }

  function onFullPcm(stream, chunk) {
    if (!fullOn) return;
    let p = fullPending.get(stream);
    if (p && (p.rate !== chunk.rate || Math.abs(p.time + p.n / p.rate - chunk.time) > 0.002)) {
      sendFull(stream, p);
      p = null;
    }
    if (!p) {
      p = { time: chunk.time, rate: chunk.rate, channels: Math.min(2, chunk.planes.length), parts: [], n: 0 };
      fullPending.set(stream, p);
    }
    p.parts.push(chunk.planes);
    p.n += chunk.planes[0].length;
    if (p.n >= FULL_BATCH * p.rate) {
      sendFull(stream, p);
      fullPending.delete(stream);
    }
  }

  MseTap.install({
    timeline: false,
    onFullPcm,
    onPcm(stream, chunk) {
      let p = pending.get(stream);
      // Start a new batch at a jump (seek) so each batch is continuous.
      if (p && Math.abs(p.time + p.n / SR - chunk.time) > 0.002) {
        send(stream, p);
        p = null;
      }
      if (!p) {
        p = { time: chunk.time, parts: [], n: 0 };
        pending.set(stream, p);
      }
      p.parts.push(chunk.samples);
      p.n += chunk.samples.length;
      if (p.n >= BATCH * SR) {
        send(stream, p);
        pending.delete(stream);
      }
    },
  });

  // Flush partial batches regularly so the last bit before a pause arrives too.
  setInterval(() => {
    for (const [stream, p] of pending) send(stream, p);
    pending.clear();
  }, 300);
  setInterval(() => {
    for (const [stream, p] of fullPending) sendFull(stream, p);
    fullPending.clear();
  }, 1200);
})();
