// Step 1.4 test: does the transcript stay ≥ 5 s ahead of playback on Tiny?
//
// fixtures/ten-minutes.webm (make-ten-minute-fixture.sh) plays through a
// MediaSource player that feeds it like YouTube: random 8–40 KB slices kept
// ~20 s ahead of the playhead. The <audio> element is muted; this test only
// needs the decoded lookahead audio, not the player's output.
// MseTap decodes the buffered audio, LookaheadTranscriber sends it to the real
// Whisper worker (Tiny), and every 500 ms we record how far ahead of the
// playhead the transcript reaches.
const R = (window.R = { ready: false, error: null, samples: [], windows: [], done: false });
const log = (...a) => (document.getElementById('log').textContent += a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
const q = new URLSearchParams(location.search);
const RATE = Number(q.get('rate') || 1);
const AHEAD = 20;

const tap = MseTap.install();

async function setup() {
  const bytes = new Uint8Array(await (await fetch('fixtures/ten-minutes.webm')).arrayBuffer());
  const reference = await (await fetch('fixtures/ten-minutes.txt')).text();
  const clusters = [];
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) {
      let p = i + 4 + (8 - Math.floor(Math.log2(bytes[i + 4])));
      if (bytes[p] !== 0xe7) continue;
      const len = bytes[p + 1] & 0x7f;
      let tc = 0;
      for (let k = 0; k < len; k++) tc = tc * 256 + bytes[p + 2 + k];
      clusters.push({ offset: i, time: tc / 1000 });
    }
  }

  // Whisper worker (Tiny), with exact-range requests.
  const worker = new Worker('../../whisper-worker.js', { type: 'module' });
  const pending = new Map();
  let nextId = 1;
  let status = null;
  worker.onmessage = ({ data }) => {
    if (data.type === 'status') status = data;
    if (data.type === 'transcribed') {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (p) data.error ? p.reject(new Error(data.error)) : p.resolve(data);
    }
  };
  worker.postMessage({ type: 'config', session: 0, model: 'tiny.en' });
  const transcribe = (samples, offset) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const copy = samples.slice();
      worker.postMessage({ type: 'transcribe', id, samples: copy, offset }, [copy.buffer]);
    });
  log('loading Whisper Tiny…');
  while (!status || status.state !== 'ready') {
    if (status && status.state === 'error') throw new Error(status.message);
    await new Promise((r) => setTimeout(r, 200));
  }
  log('Whisper ready on', status.device);

  // YouTube-like player.
  const audio = document.querySelector('audio');
  audio.muted = true;
  const ms = new MediaSource();
  audio.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
  const stream = tap.streams[tap.streams.length - 1];
  let pos = 0;
  let seed = 11;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const timeAt = (off) => {
    let t = 0;
    for (const c of clusters) if (c.offset <= off) t = c.time;
    return t;
  };
  const append = (chunk) =>
    new Promise((res, rej) => {
      sb.addEventListener('updateend', res, { once: true });
      sb.addEventListener('error', rej, { once: true });
      sb.appendBuffer(chunk);
    });
  await append(bytes.subarray(0, clusters[0].offset));
  pos = clusters[0].offset;
  (async () => {
    for (;;) {
      if (pos < bytes.length && timeAt(pos) < audio.currentTime + AHEAD) {
        const n = 8000 + Math.floor(rnd() * 32000);
        await append(bytes.subarray(pos, Math.min(bytes.length, pos + n)));
        pos = Math.min(bytes.length, pos + n);
      } else {
        if (pos >= bytes.length && ms.readyState === 'open' && !sb.updating) ms.endOfStream();
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  })();

  const words = new WordTimeline();
  const lt = new LookaheadTranscriber({
    timeline: stream.timeline,
    words,
    transcribe,
    playhead: () => audio.currentTime,
    duration: () => (Number.isFinite(audio.duration) ? audio.duration : 600),
    onWindow: (w) => R.windows.push({ from: +w.from.toFixed(2), to: +w.to.toFixed(2), ms: Math.round(w.ms), silent: w.silent, at: +audio.currentTime.toFixed(2) }),
  });
  lt.start();
  Object.assign(R, { audio, words, lt, stream, reference, device: status.device });
  R.ready = true;
}

R.run = async function () {
  const { audio, words } = R;
  audio.playbackRate = RATE;
  await audio.play();
  const t0 = performance.now();
  const timer = setInterval(() => {
    const t = audio.currentTime;
    const left = (audio.duration || 600) - t;
    R.samples.push({ wall: +((performance.now() - t0) / 1000).toFixed(1), t: +t.toFixed(2), ahead: +words.aheadOf(t).toFixed(2), left: +left.toFixed(2), buffered: +R.stream.timeline.readyAhead(t, 120).toFixed(2) });
    if (audio.ended) {
      clearInterval(timer);
      R.lt.stop();
      R.done = true;
    }
  }, 500);
};

// Summary: the smallest "ahead" after the first 5 s, counting min(5 s, time
// left) as enough near the end; plus a check that the words are right.
R.summary = function () {
  const steady = R.samples.filter((s) => s.t > 5);
  // 0.05 s tolerance: near the very end, "ahead" and "time left" differ only by sampling rounding.
  const shortfall = steady.map((s) => ({ ...s, need: Math.min(5, s.left) })).filter((s) => s.ahead < s.need - 0.05);
  const minAhead = steady.reduce((m, s) => Math.min(m, s.ahead + (5 - Math.min(5, s.left))), Infinity);
  const ws = R.windows.filter((w) => !w.silent);
  const said = R.words.words.map((w) => w.text.toLowerCase().replace(/[^a-z0-9']/g, '')).filter(Boolean);
  const vocab = new Set(R.reference.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean));
  const numbers = new Set();
  const text = R.words.words.map((w) => w.text).join(' ').toLowerCase();
  for (const m of text.matchAll(/number\s+(\d+)/g)) numbers.add(Number(m[1]));
  const lastPlayed = R.samples.length ? R.samples[R.samples.length - 1].t : 0;
  return {
    device: R.device,
    playbackRate: RATE,
    playedTo: lastPlayed,
    samples: R.samples.length,
    minAheadSeconds: Number.isFinite(minAhead) ? +minAhead.toFixed(2) : null,
    timesBelow5s: shortfall.length,
    medianAhead: steady.length ? [...steady].sort((a, b) => a.ahead - b.ahead)[Math.floor(steady.length / 2)].ahead : null,
    windows: R.windows.length,
    whisperMsPerWindow: ws.length ? Math.round(ws.reduce((s, w) => s + w.ms, 0) / ws.length) : null,
    words: said.length,
    wordsInReferenceVocabulary: said.length ? +(said.filter((w) => vocab.has(w)).length / said.length).toFixed(3) : null,
    sentenceNumbersHeard: numbers.size,
    swearsHeard: (text.match(/damn|shit|hell/g) || []).length,
  };
};

document.getElementById('start').addEventListener('click', () => {
  setup().catch((e) => {
    R.error = String(e);
    log('ERROR', String(e));
  });
});
