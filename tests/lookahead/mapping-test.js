// Step 1.3 test: does ClockSync predict when a moment of the media is heard?
//
// A MediaSource player behaves like YouTube's: it appends the WebM in random
// 8–40 KB slices about 20 s ahead of the playhead, and on every seek aborts
// the SourceBuffer and restarts from the cluster containing the target. The
// lookahead modules tap it exactly as they would on YouTube.
//
// The player's sound goes only into a Web Audio graph whose output device is
// "none" and whose output gain is 0: it is captured, never played. The page
// refuses to start if that isn't true.
//
// Ground truth: word onsets (a sound starting after ≥ 250 ms of quiet) found
// in the decoded lookahead audio, by media time. For each, ClockSync predicts
// the Web Audio time it will be heard. The error is measured by matching the
// shape of the sound around the word (a 500 ms loudness envelope, 1 ms steps)
// between the decoded audio and the captured audio at the predicted time:
// the lag of the best match is how far the prediction was off. (Comparing
// where each crosses a fixed threshold misfires on soft starts like "s".)
const T = (window.T = { log: [], segments: [], ready: false, error: null });
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  T.log.push(line);
  document.getElementById('log').textContent += line + '\n';
};

const AHEAD = 20; // seconds buffered ahead, like YouTube
const SR = 16000;

const tap = MseTap.install();
let stream = null;
let sync = null;

async function setup() {
  const bytes = new Uint8Array(await (await fetch('fixtures/long.webm')).arrayBuffer());
  // Cluster index: byte offset + timecode (ms) of each cluster.
  const clusters = [];
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) {
      let p = i + 4;
      const sizeLen = 8 - Math.floor(Math.log2(bytes[p]));
      p += sizeLen;
      if (bytes[p] !== 0xe7) continue;
      const len = bytes[p + 1] & 0x7f;
      let tc = 0;
      for (let k = 0; k < len; k++) tc = tc * 256 + bytes[p + 2 + k];
      clusters.push({ offset: i, time: tc / 1000 });
    }
  }
  const initEnd = clusters[0].offset;

  const audio = document.querySelector('audio');
  const ms = new MediaSource();
  audio.src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
  stream = tap.streams[tap.streams.length - 1];
  sync = new ClockSync({ timeline: stream.timeline });

  // Feeder: random slices, ~AHEAD seconds ahead; seek = abort + restart at a cluster.
  let pos = 0;
  let generation = 0;
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const timeAtByte = (off) => {
    let t = 0;
    for (const c of clusters) if (c.offset <= off) t = c.time;
    return t;
  };
  const appendNow = (chunk) =>
    new Promise((res, rej) => {
      sb.addEventListener('updateend', res, { once: true });
      sb.addEventListener('error', rej, { once: true });
      sb.appendBuffer(chunk);
    });
  await appendNow(bytes.subarray(0, initEnd));
  pos = initEnd;
  (async function feed() {
    for (;;) {
      const gen = generation;
      if (pos < bytes.length && timeAtByte(pos) < audio.currentTime + AHEAD && !sb.updating) {
        const n = 8000 + Math.floor(rnd() * 32000);
        try {
          await appendNow(bytes.subarray(pos, Math.min(bytes.length, pos + n)));
          if (gen === generation) pos = Math.min(bytes.length, pos + n);
        } catch (e) {
          log('append error', String(e));
        }
      } else {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  })();
  audio.addEventListener('seeking', () => {
    generation++;
    if (sb.updating) sb.abort();
    else sb.abort(); // like YouTube: always abort on seek
    const target = audio.currentTime;
    let c = clusters[0];
    for (const k of clusters) if (k.time <= target) c = k;
    pos = c.offset; // resume from the cluster containing the target
  });

  // Silent capture graph.
  const ctx = new AudioContext();
  await ctx.setSinkId({ type: 'none' });
  await ctx.resume();
  const zero = ctx.createGain();
  zero.gain.value = 0;
  zero.connect(ctx.destination);
  await ctx.audioWorklet.addModule('capture-worklet.js');
  const node = new AudioWorkletNode(ctx, 'cap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  node.port.onmessage = ({ data }) => sync.noteCapture(data.t, data.d, ctx.sampleRate);
  const src = ctx.createMediaElementSource(audio);
  src.connect(node);
  node.connect(zero);
  if (!(ctx.sinkId && ctx.sinkId.type === 'none') || zero.gain.value !== 0) throw new Error('capture graph is not silent');

  setInterval(() => sync.notePlayhead(ctx.currentTime, audio.currentTime, { paused: audio.paused || audio.seeking, rate: audio.playbackRate }), 25);
  setInterval(() => {
    if (!audio.paused) sync.calibrate(ctx.currentTime);
  }, 1000);

  Object.assign(T, { audio, ctx, sb, clusters, silent: true });
  T.ready = true;
  log('ready: sink', ctx.sinkId.type, '| output gain', zero.gain.value, '| clusters', clusters.length);
}

// Onsets: a 1 ms-hop, 10 ms-window envelope rising above `th` after ≥ 250 ms below `quiet`.
function onsets(x, th = 0.02, quiet = 0.006) {
  const HOP = 16, WIN = 160;
  const out = [];
  let quietRun = 0;
  for (let j = 0; (j + 1) * HOP + WIN < x.length; j++) {
    let q = 0;
    for (let i = j * HOP; i < j * HOP + WIN; i++) q += x[i] * x[i];
    const e = Math.sqrt(q / WIN);
    if (e < quiet) quietRun++;
    else {
      if (e > th && quietRun >= 250) out.push(j / 1000);
      if (e > th) quietRun = 0;
    }
  }
  return out;
}

// Lag (ms) at which the captured envelope best matches the decoded one, over
// the middle 500 ms of two 800 ms windows centred on the word; ±150 ms search.
function localLag(dec, cap) {
  const env = (x) => {
    const out = [];
    for (let j = 0; j * 16 + 160 <= x.length; j++) {
      let q = 0;
      for (let i = j * 16; i < j * 16 + 160; i++) q += x[i] * x[i];
      out.push(Math.sqrt(q / 160));
    }
    return out;
  };
  const d = env(dec), c = env(cap);
  const mid0 = 150, mid1 = Math.min(d.length, c.length) - 150;
  let best = { lag: 0, r: -2 };
  for (let lag = -150; lag <= 150; lag++) {
    let sx = 0, sy = 0, n = 0;
    for (let j = mid0; j < mid1; j++) { sx += d[j]; sy += c[j + lag]; n++; }
    const mx = sx / n, my = sy / n;
    let xy = 0, xx = 0, yy = 0;
    for (let j = mid0; j < mid1; j++) { const x = d[j] - mx, y = c[j + lag] - my; xy += x * y; xx += x * x; yy += y * y; }
    const r = xy / Math.sqrt(xx * yy + 1e-20);
    if (r > best.r) best = { lag, r };
  }
  return { lagMs: best.lag, r: +best.r.toFixed(3) };
}

// Play `secs` from media time `from` (seeking first), then score onsets heard
// in that stretch. Calibration carries over between segments; the media-clock
// fit restarts after each seek, as it would in the extension.
T.segment = async function (from, secs, label) {
  const { audio, ctx } = T;
  if (!T.silent) throw new Error('not silent');
  const playCtx0 = ctx.currentTime;
  if (Math.abs(audio.currentTime - from) > 0.05) {
    audio.currentTime = from;
    await new Promise((r) => audio.addEventListener('seeked', r, { once: true }));
  }
  const waitStart = performance.now();
  while (stream.timeline.readyAhead(from) < 3 && performance.now() - waitStart < 5000) await new Promise((r) => setTimeout(r, 50));
  const readyAheadAtStart = +stream.timeline.readyAhead(from).toFixed(2);
  await audio.play();
  await new Promise((r) => setTimeout(r, secs * 1000));
  audio.pause();

  // Score onsets that were heard after the media-clock fit had ≥ 1 s of data.
  const f = sync.fit();
  const cStart = Math.max(sync.run ? sync.run.startCtx + 1 : playCtx0, playCtx0);
  const cEnd = ctx.currentTime - 0.3;
  const m0 = sync.mediaHeardAt(cStart), m1 = sync.mediaHeardAt(cEnd);
  const dec = stream.timeline.read(m0 - 0.5, m1);
  const truth = onsets(dec.samples).map((t) => m0 - 0.5 + t).filter((m) => m >= m0 && m <= m1);
  const rows = [];
  for (const m of truth) {
    const predicted = sync.heardAt(m);
    const r = localLag(stream.timeline.read(m - 0.4, m + 0.4).samples, sync.capturedAt16k(predicted - 0.4, predicted + 0.4).samples);
    if (r.r > 0.8) rows.push({ media: +m.toFixed(3), errorMs: r.lagMs, r: r.r });
  }
  const errs = rows.map((r) => Math.abs(r.errorMs));
  const seg = {
    label,
    from,
    readyAheadAtStart,
    fitRate: f ? +f.a.toFixed(5) : null,
    calibration: sync.lastCalibration,
    offsetMs: Math.round(sync.lag * 1000),
    onsets: rows.length,
    maxAbsErrorMs: errs.length ? Math.max(...errs) : null,
    medianErrorMs: rows.length ? [...rows].sort((a, b) => a.errorMs - b.errorMs)[Math.floor(rows.length / 2)].errorMs : null,
    rows,
  };
  T.segments.push(seg);
  log(label, '→', { onsets: seg.onsets, medianErrorMs: seg.medianErrorMs, maxAbsErrorMs: seg.maxAbsErrorMs, offsetMs: seg.offsetMs, readyAheadAtStart });
  return seg;
};

document.getElementById('start').addEventListener('click', () => {
  setup().catch((e) => {
    T.error = String(e);
    log('ERROR', String(e));
  });
});
