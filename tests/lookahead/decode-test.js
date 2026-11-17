// Offline step-1.2 test: WebM bytes in random slices -> demux -> WebCodecs decode -> 16 kHz,
// compared with ffmpeg's decode by cross-correlation. Nothing is played.
window.result = null;
(async () => {
  const [webm, refBuf] = await Promise.all([fetch('fixtures/clip.webm').then(r => r.arrayBuffer()), fetch('fixtures/ref16k.f32').then(r => r.arrayBuffer())]);
  const ref = new Float32Array(refBuf);
  const chunks = [];
  const pcm = new OpusPcmDecoder({ onPcm: c => chunks.push(c) });
  const demux = new WebmOpusDemuxer({ onConfig: c => pcm.configure(c), onFrame: f => pcm.decode(f) });
  const bytes = new Uint8Array(webm);
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = 0; i < bytes.length;) { const n = 1 + Math.floor(rnd() * 40000); demux.push(bytes.subarray(i, i + n)); i += n; }
  await pcm.flush();
  // Lay chunks on a 16 kHz timeline by their media time.
  const SR = 16000, t0 = chunks[0].time;
  const end = chunks[chunks.length - 1].time + chunks[chunks.length - 1].samples.length / SR;
  const out = new Float32Array(Math.ceil((end - Math.min(0, t0)) * SR) + 10);
  let gaps = 0, prevEnd = null;
  for (const c of chunks) {
    const at = Math.round((c.time - Math.min(0, t0)) * SR);
    if (prevEnd != null && Math.abs(at - prevEnd) > 1) gaps++;
    out.set(c.samples, at); prevEnd = at + c.samples.length;
  }
  // Cross-correlate over a 10 s window starting at 2 s, lags ±50 ms.
  const W = 10 * SR, s0 = 2 * SR, shift = Math.round(-Math.min(0, t0) * SR);
  let best = { lag: 0, r: -1 };
  for (let lag = -800; lag <= 800; lag++) {
    let xy = 0, xx = 0, yy = 0;
    for (let i = 0; i < W; i++) { const a = out[s0 + shift + i + lag] || 0, b = ref[s0 + i]; xy += a * b; xx += a * a; yy += b * b; }
    const r = xy / Math.sqrt(xx * yy + 1e-20); if (r > best.r) best = { lag, r };
  }
  window.result = { firstChunkTime: +t0.toFixed(5), chunks: chunks.length, seconds: +((out.length) / SR).toFixed(2), refSeconds: +(ref.length / SR).toFixed(2),
    gapsInTimeline: gaps, offsetMs: +(best.lag / 16).toFixed(2), correlation: +best.r.toFixed(4), demux: demux.stats, decoder: pcm.stats };
})().catch(e => window.result = { error: String(e) });
