// Fit a stand-in into the time around a swear, the way it's done by hand in
// the editor (no model, just rules):
//
//   1. Pick the stand-in for what the swear means (sense.js + map.json). A
//      rule can swap the words around it too: "what the fuck's going on" ->
//      "what is going on" ("is" replaces "the fuck's").
//   2. The free time is from the end of the word before to the start of the
//      word after (the swear's own time plus any pause on either side), so no
//      other word is covered.
//   3. The longest stand-in that fits there at its natural pace is used; if
//      none does, the shortest. It's placed over the swear, moved earlier
//      into the pause before when it would run into the next word.
//   4. The time given is exactly what the word needs. Only if even the
//      shortest stand-in doesn't fit is it sped up (up to MAX_SPEED), and
//      only then does it cover a bit of the next word.
//
//   const F = PFFit.fit(S, words, swear, lengthOf)
//   // S: PFSense.create(map, senses); words: [{text, start, end}] (seconds);
//   // swear: {start, end} of the swear's words; lengthOf(text) -> seconds
//   // -> {say, sense, span: [a, b], place, allowed, speed, fits, room, note}
//   // span: the words replaced (the swear, plus any the rule swaps too)
(function (root) {
  'use strict';

  const MARGIN = 0.04; // keep this far from the neighbouring words
  const MAX_PAUSE_USE = 0.6; // use at most this much of a pause before/after
  const MAX_SPEED = 1.35;

  function tokens(S, words) {
    const toks = [];
    const owner = [];
    words.forEach((w, i) => {
      for (const t of S.tokenize(w.text)) {
        toks.push(t);
        owner.push(i);
      }
    });
    return { toks, owner };
  }

  // opts.options: use these stand-ins instead of the map's (e.g. one typed in).
  function fit(S, words, swear, lengthOf, opts) {
    const mid = (w) => (w.start + w.end) / 2;
    const inSwear = words.map((w) => mid(w) >= swear.start - 0.02 && mid(w) <= swear.end + 0.02);
    const first = inSwear.indexOf(true);
    if (first < 0) return null;
    const last = inSwear.lastIndexOf(true);
    // Only the sentence around it is needed for the rules.
    const lo = Math.max(0, first - 12);
    const hi = Math.min(words.length - 1, last + 12);
    const near = words.slice(lo, hi + 1);
    const { toks, owner } = tokens(S, near);
    let ti = -1;
    for (let k = 0; k < toks.length; k++) {
      const wi = owner[k] + lo;
      if (wi >= first && wi <= last && S.rootOf(toks[k])) { ti = k; break; }
    }
    let say = null, sense = null, list = null, wFrom = first, wTo = last;
    if (ti >= 0) {
      const rule = S.ruleFor(toks, ti);
      sense = rule.sense;
      const from = Math.max(0, ti - (rule.prev || 0));
      const to = Math.min(toks.length - 1, ti + (rule.next || 0));
      wFrom = Math.min(first, owner[from] + lo);
      wTo = Math.max(last, owner[to] + lo);
      const prevTok = from > 0 ? toks[from - 1] : null;
      const raw = rule.subs || S.subsOf(sense) || [];
      list = [...new Set(raw.map((t) => S.say(t, toks[ti], prevTok)))];
    }
    if (opts && opts.options && opts.options.length) list = opts.options;
    if (!list || !list.length) list = swear.say ? [swear.say] : [];
    if (!list.length) return null;

    const a = words[wFrom].start;
    const b = words[wTo].end;
    const before = wFrom > 0 ? words[wFrom - 1].end + MARGIN : a - MAX_PAUSE_USE;
    const after = wTo + 1 < words.length ? words[wTo + 1].start - MARGIN : b + MAX_PAUSE_USE;
    const g0 = Math.max(0, Math.min(a, Math.max(before, a - MAX_PAUSE_USE)));
    const g1 = Math.max(b, Math.min(after, b + MAX_PAUSE_USE));
    const room = g1 - g0;

    const byLen = list.map((t) => ({ t, len: lengthOf(t) })).sort((x, y) => y.len - x.len);
    let pick = byLen.find((c) => c.len <= room);
    const out = { sense, span: [round(a), round(b)], room: round(room), options: byLen.map((c) => c.t) };
    if (pick) {
      const place = Math.min(Math.max(a, g0), g1 - pick.len); // over the swear, earlier if it would run on
      return Object.assign(out, { say: pick.t, place: round(Math.max(g0, place)), allowed: round(pick.len + 0.02), speed: 1, fits: true,
        note: `“${pick.t}” fits in the ${room.toFixed(2)} s between the words` });
    }
    pick = byLen[byLen.length - 1];
    const speed = Math.min(MAX_SPEED, Math.ceil((pick.len / room) * 100) / 100);
    const len = pick.len / speed;
    return Object.assign(out, { say: pick.t, place: round(g0), allowed: round(len + 0.02), speed, fits: len <= room + 0.01,
      note: len <= room + 0.01
        ? `even “${pick.t}” is long for the ${room.toFixed(2)} s free: said ${speed.toFixed(2)}× faster`
        : `nothing fits the ${room.toFixed(2)} s free: “${pick.t}” at ${speed.toFixed(2)}× still runs ${(len - room).toFixed(2)} s into the next word` });
  }

  function round(x) { return Math.round(x * 1000) / 1000; }

  root.PFFit = { fit, MARGIN, MAX_SPEED };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PFFit;
})(typeof globalThis !== 'undefined' ? globalThis : self);
