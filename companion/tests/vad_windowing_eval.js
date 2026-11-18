// Pause-aware windows vs fixed 10 s windows (roadmap step 5.1), using the
// extension's real LookaheadTranscriber, PcmTimeline and WordTimeline, with a
// companion (started with --allow-local-test-pages) doing separation, VAD and
// Whisper on the separated voice.
//
//   node companion/tests/vad_windowing_eval.js CLIPS_DIR [port]
// CLIPS_DIR has clips.json + <name>.48k.f32 (stereo) + <name>.16k.f32 (mono).
const fs = require('fs');
const path = require('path');
const PcmTimeline = require('../../lookahead/pcm-timeline.js');
const WordTimeline = require('../../lookahead/word-timeline.js');
const LookaheadTranscriber = require('../../lookahead/lookahead-transcriber.js');

const dir = process.argv[2];
const port = process.argv[3] || 47996;
const clips = JSON.parse(fs.readFileSync(path.join(dir, 'clips.json')));
const SWEARS = new Set(['shit', 'hell', 'damn', 'fucking', 'bloody', 'crap', 'bullshit', 'bitch', 'goddamn', 'bastards', 'fuck']);
const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');
const wordsOf = (t) => t.replace(/-/g, ' ').split(/\s+/).map(norm).filter(Boolean);
function wer(ref, hyp) {
  let d = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= hyp.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (ref[i - 1] !== hyp[j - 1]));
      prev = t;
    }
  }
  return d[hyp.length] / ref.length;
}
const f32 = (p) => {
  const b = fs.readFileSync(p);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};
const b64 = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength).toString('base64');
const toI16 = (f) => {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) o[i] = Math.max(-1, Math.min(1, f[i])) * 32767;
  return o;
};

(async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const waiters = new Map();
  const stems = new Map();
  let nextId = 1;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'stems') stems.set(m.stream, m);
    if (m.type === 'transcribed' && waiters.has(m.id)) {
      waiters.get(m.id)(m);
      waiters.delete(m.id);
    }
    if (m.type === 'status') waiters.get('status')?.(m);
  };
  ws.send(JSON.stringify({ type: 'hello', version: 1 }));
  await new Promise((r) => waiters.set('status', (m) => m.state !== 'loading' && r()));

  const totals = {};
  for (const clip of clips) {
    const stream = 'blob:' + clip.name;
    const a48 = f32(path.join(dir, clip.name + '.48k.f32'));
    const a16 = f32(path.join(dir, clip.name + '.16k.f32'));
    for (let i = 0; i < a48.length; i += 96000) ws.send(JSON.stringify({ type: 'stem_audio', stream, time: i / 96000, rate: 48000, channels: 2, pcm16: b64(toI16(a48.subarray(i, i + 96000))) }));
    ws.send(JSON.stringify({ type: 'stem_playhead', stream, time: 0 }));
    const tWait = Date.now();
    while (!(stems.get(stream)?.ranges?.[0]?.[1] >= clip.seconds - 0.05)) {
      if (Date.now() - tWait > 30000) {
        console.log(`  ${clip.name}: stems still incomplete after 30 s: ${JSON.stringify(stems.get(stream)?.ranges)}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const info = stems.get(stream);
    for (const mode of ['fixed', 'pauses']) {
      const timeline = new PcmTimeline({ keepAhead: 1000 });
      timeline.add({ time: 0, samples: a16 });
      const words = new WordTimeline();
      let asrSec = 0;
      const lt = new LookaheadTranscriber({
        timeline,
        words,
        playhead: () => 0,
        duration: () => clip.seconds,
        maxAheadSec: 1000,
        idleMs: 20,
        speech: mode === 'pauses' ? (t0, t1) => info.speech.filter(([a, b]) => b > t0 && a < t1) : null,
        transcribe: (samples, offset) =>
          new Promise((resolve) => {
            const id = nextId++;
            asrSec += samples.length / 16000;
            waiters.set(id, resolve);
            ws.send(JSON.stringify({ type: 'transcribe', id, offset, stream, pcm16: b64(toI16(samples)) }));
          }),
      });
      lt.start();
      while ((words.coveredUntil(0) ?? 0) < clip.seconds - 0.25) await new Promise((r) => setTimeout(r, 50));
      lt.stop();
      const ref = wordsOf(clip.script);
      const hyp = words.words.flatMap((w) => wordsOf(w.text));
      const e = wer(ref, hyp);
      const refSw = ref.filter((w) => SWEARS.has(w)).length;
      const found = Math.min(refSw, hyp.filter((w) => SWEARS.has(w)).length);
      const s = lt.stats;
      console.log(`${clip.name.padEnd(12)} ${mode.padEnd(6)} WER ${(100 * e).toFixed(1).padStart(5)}%  swears ${found}/${refSw}  windows ${s.windows} (pause cuts ${s.pauseCuts}, skipped ${s.skippedNoSpeech})  audio sent ${asrSec.toFixed(0)} s`);
      const t = (totals[mode] = totals[mode] || { err: 0, n: 0, f: 0, sw: 0, asr: 0, win: 0 });
      t.err += e * ref.length; t.n += ref.length; t.f += found; t.sw += refSw; t.asr += asrSec; t.win += s.windows;
    }
    ws.send(JSON.stringify({ type: 'stem_close', stream }));
  }
  console.log('\nTotals:');
  for (const [mode, t] of Object.entries(totals)) console.log(`  ${mode.padEnd(6)} WER ${((100 * t.err) / t.n).toFixed(1)}%  swears ${t.f}/${t.sw}  windows ${t.win}  audio sent to Whisper ${t.asr.toFixed(0)} s`);
  ws.close();
  process.exit(0);
})();
