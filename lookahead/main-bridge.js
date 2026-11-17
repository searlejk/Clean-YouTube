// Runs in the YouTube page itself (content script with "world": "MAIN"),
// because only there can the player's MediaSource buffers be seen
// (roadmap step 1.5). It taps them with MseTap and forwards the decoded
// 16 kHz audio to the extension's content script, tagged with the player's
// blob: URL so the extension can tell which <video> it belongs to.
//
// Messages (window.postMessage, `__cleanEars: 1`):
//   { type: 'pcm', src, time, samples }   ~250 ms of audio starting at media time `time`
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

  MseTap.install({
    timeline: false,
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
})();
