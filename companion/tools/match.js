// Swears and their funny stand-ins for a transcript, with exactly the
// extension's logic (settings.js word list + phrases, filter.js matching).
//   node companion/tools/match.js words.json > swears.json
// words.json: [{ text, start, end, speaker }] sorted by time.
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
require(path.join(root, 'settings.js'));
require(path.join(root, 'filter.js'));
const F = globalThis.PFFilter;
const PF = globalThis.PF;
const words = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const compiled = F.compileWordList(PF.DEFAULT_WORDS, PF.DEFAULT_ALLOW);
const out = [];
for (const m of F.findMatches(words, compiled)) {
  const r = F.funnyReplacement(words, m, PF.FUNNY_PHRASES, PF.FUNNY_WORDS);
  if (out.some((o) => o.start < r.end && r.start < o.end)) continue; // one per stretch
  const next = words.find((w) => w.start >= r.end - 0.02 && w.start > r.start + 0.01);
  const roomEnd = next ? Math.min(r.end + 1.0, Math.max(r.end, next.start - 0.05)) : r.end + 0.5;
  out.push({ swear: m.text, rule: m.rule, start: r.start, end: r.end, roomEnd, say: r.say, phrase: r.phrase || null, speaker: m.speaker ?? null });
}
process.stdout.write(JSON.stringify(out, null, 1));
