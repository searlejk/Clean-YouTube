// How often map.json picks the right sense for the generated sentences.
//   node substitutes/evaluate.js [--split val|train|all] [--show sense.id] [--errors 20]
'use strict';
const fs = require('fs');
const path = require('path');
const PFSense = require('./sense.js');

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const split = opt('--split', 'all');
const show = opt('--show', null);
const nErr = +opt('--errors', 0);

const here = __dirname;
const map = JSON.parse(fs.readFileSync(path.join(here, 'map.json')));
const senses = JSON.parse(fs.readFileSync(path.join(here, 'senses.json')));
const S = PFSense.create(map, senses);
const rows = fs.readFileSync(path.join(here, 'data', 'sentences.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  .filter((r) => split === 'all' || r.split === split);

const per = {};
const confusion = {};
const errors = [];
let right = 0, total = 0, noSwear = 0;
for (const r of rows) {
  const words = S.tokenize(r.text);
  const want = r.sense;
  const wantRoot = want.split('.')[0];
  // The swear this sentence is about: the first word of the sense's root (else any swear).
  let i = words.findIndex((w) => S.rootOf(w) === wantRoot);
  if (i < 0) i = words.findIndex((w) => S.rootOf(w));
  if (i < 0) { noSwear++; continue; }
  const got = S.senseOf(words, i);
  const p = (per[want] ||= { n: 0, ok: 0 });
  p.n++; total++;
  if (got === want) { p.ok++; right++; }
  else {
    const k = `${want} -> ${got}`;
    confusion[k] = (confusion[k] || 0) + 1;
    if (!show || show === want) errors.push(`${want.padEnd(20)} got ${String(got).padEnd(20)} ${r.text}`);
  }
}
console.log(`${split}: ${right}/${total} right (${((100 * right) / total).toFixed(1)}%)${noSwear ? `, ${noSwear} with no swear found` : ''}\n`);
for (const [k, p] of Object.entries(per).sort()) console.log(`  ${k.padEnd(22)} ${String(p.ok).padStart(4)}/${String(p.n).padEnd(4)} ${((100 * p.ok) / p.n).toFixed(0).padStart(3)}%`);
const top = Object.entries(confusion).sort((a, b) => b[1] - a[1]).slice(0, 12);
if (top.length) console.log('\nMost common mix-ups:\n' + top.map(([k, n]) => `  ${String(n).padStart(4)}  ${k}`).join('\n'));
if (nErr) console.log('\n' + errors.slice(0, nErr).join('\n'));
