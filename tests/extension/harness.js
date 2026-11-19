// YouTube-like MediaSource player for the extension harness: plays
// ../lookahead/fixtures/long.webm, appended in random slices ~20 s ahead
// (?ahead=60 for 60 s, closer to YouTube's buffering).
const H = (window.H = { ready: false, error: null });
const AHEAD = Number(new URLSearchParams(location.search).get('ahead')) || 20;
document.getElementById('start').addEventListener('click', async () => {
  try {
    const file = new URLSearchParams(location.search).get('file') || 'long.webm'; // ?file=interview-mixed.webm
    const bytes = new Uint8Array(await (await fetch('../lookahead/fixtures/' + file)).arrayBuffer());
    const clusters = [];
    for (let i = 0; i + 4 < bytes.length; i++) if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) {
      let p = i + 4 + (8 - Math.floor(Math.log2(bytes[i + 4])));
      if (bytes[p] !== 0xe7) continue;
      const len = bytes[p + 1] & 0x7f; let tc = 0;
      for (let k = 0; k < len; k++) tc = tc * 256 + bytes[p + 2 + k];
      clusters.push({ offset: i, time: tc / 1000 });
    }
    const video = document.querySelector('video');
    const ms = new MediaSource();
    video.src = URL.createObjectURL(ms);
    await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
    const sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    let pos = 0, gen = 0, seed = 5;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const timeAt = (off) => { let t = 0; for (const c of clusters) if (c.offset <= off) t = c.time; return t; };
    const append = (chunk) => new Promise((res, rej) => { sb.addEventListener('updateend', res, { once: true }); sb.addEventListener('error', rej, { once: true }); sb.appendBuffer(chunk); });
    await append(bytes.subarray(0, clusters[0].offset));
    pos = clusters[0].offset;
    (async () => { for (;;) {
      const g = gen;
      if (pos < bytes.length && timeAt(pos) < video.currentTime + AHEAD && !sb.updating) {
        const n = 8000 + Math.floor(rnd() * 32000);
        try { await append(bytes.subarray(pos, Math.min(bytes.length, pos + n))); if (g === gen) pos = Math.min(bytes.length, pos + n); } catch {}
      } else await new Promise((r) => setTimeout(r, 50));
    } })();
    video.addEventListener('seeking', () => { gen++; sb.abort(); let c = clusters[0]; for (const k of clusters) if (k.time <= video.currentTime) c = k; pos = c.offset; });
    H.video = video;
    H.ready = true;
  } catch (e) { H.error = String(e); }
});
H.diag = () => JSON.parse(document.documentElement.dataset.cleanEars || 'null');
