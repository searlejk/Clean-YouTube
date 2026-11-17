const fs = require('fs'), crypto = require('crypto');
const path = require('path');
const Demuxer = require(path.join(__dirname, '../../lookahead/webm-opus-demuxer.js'));
const dir = path.join(__dirname, 'fixtures');
const file = fs.readFileSync(dir + '/clip.webm');
const ref = fs.readFileSync(dir + '/clip.framemd5', 'utf8').split('\n').filter(l => l && !l.startsWith('#'))
  .map(l => { const p = l.split(',').map(s => s.trim()); return { ptsMs: +p[2], size: +p[4], md5: p[5] }; });

function rng(seed) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

function run(sliceSizer, label) {
  const frames = []; let config = null;
  const d = new Demuxer({ onConfig: c => (config = c), onFrame: f => frames.push(f) });
  for (let i = 0; i < file.length;) { const n = Math.max(1, Math.min(file.length - i, sliceSizer())); d.push(file.subarray(i, i + n)); i += n; }
  let ok = frames.length === ref.length && config && config.channels === 2;
  const offsets = new Set();
  frames.forEach((f, i) => {
    const r = ref[i];
    if (!r) { ok = false; return; }
    const md5 = crypto.createHash('md5').update(f.data).digest('hex');
    if (md5 !== r.md5 || f.data.length !== r.size) ok = false;
    offsets.add(Math.round(f.timestampUs / 1000 - r.ptsMs));
  });
  if (offsets.size > 1) ok = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(26)} frames ${frames.length}/${ref.length}  timestamp offset vs ffmpeg ${[...offsets].join(',')} ms  resyncs ${d.stats.resyncs}  laced ${d.stats.lacedBlocksSkipped}`);
  return ok;
}

let all = true;
all &= run(() => file.length, 'whole file at once');
all &= run(() => 1, '1-byte slices');
for (const seed of [1, 2, 3]) { const r = rng(seed); all &= run(() => 1 + Math.floor(r() * 65536), `random 1B-64KB (seed ${seed})`); }
{ const r = rng(9); all &= run(() => 1 + Math.floor(r() * 300), 'random 1-300 B'); }

// Seek simulation: feed 40%, reset (like SourceBuffer.abort), then continue from a random mid-cluster offset.
{
  const frames = [];
  const d = new Demuxer({ onFrame: f => frames.push(f) });
  const cut = Math.floor(file.length * 0.4), jump = Math.floor(file.length * 0.6) + 777;
  d.push(file.subarray(0, cut)); const before = frames.length;
  d.reset(); d.push(file.subarray(jump));
  const after = frames.slice(before);
  const byTs = new Map(ref.map(r => [r.ptsMs, r]));
  const off = Math.round(frames[0].timestampUs / 1000 - ref[0].ptsMs);
  const match = after.every(f => { const r = byTs.get(Math.round(f.timestampUs / 1000) - off); return r && crypto.createHash('md5').update(f.data).digest('hex') === r.md5; });
  const lastRef = ref[ref.length - 1].ptsMs + off;
  const ok = after.length > 100 && match && Math.round(after[after.length - 1].timestampUs / 1000) === lastRef;
  all &= ok;
  console.log(`${ok ? 'PASS' : 'FAIL'}  seek: reset + mid-cluster   resumed with ${after.length} frames, all matching ffmpeg, through to the last packet`);
}
console.log(all ? '\nALL PASS' : '\nSOME FAILED'); process.exit(all ? 0 : 1);
