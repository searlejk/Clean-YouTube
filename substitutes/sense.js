// Which sense a swear is used in, from the words around it, using the simple
// map in map.json (no model at run time). Works in the extension and in Node.
//
//   const S = PFSense.create(mapJson, sensesJson);
//   S.senseOf(['oh', 'fuck', 'i', 'dropped', 'it'], 1)   // -> 'fuck.dismay'
//   S.standIn(words, 1, 0.4)        // -> {sense, say, from, to}: longest stand-in that fits 0.4 s
//
// A rule's pattern is space-separated slots around the swear:
//   S            the swear itself;  S=regex  the swear must also match regex
//   a|b|c        any one of these words;  /regex/  a word matching it
//   *            any one word;  ^  start of the sentence;  $  end of it
//   (x)          optional slot
// Rules are tried in order; the first that matches wins, else the root's default.
(function (root) {
  'use strict';

  function tokenize(text) {
    // Punctuation stays as a word of its own: "," (pause) or "." (end), so
    // "shit, I forgot" and "shit coffee" can be told apart.
    return String(text)
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[,;:—–]+/g, ' , ')
      .replace(/[.!?…]+/g, ' . ')
      .replace(/[^a-z0-9'\-,. ]+/g, ' ')
      .split(/[\s-]+/)
      .map((t) => t.replace(/^'+|'+$/g, ''))
      .filter(Boolean);
  }

  // A slot: test(word) for a word, edge = also matches past the start/end.
  function makeSlot(slot) {
    if (slot === '*') return { test: () => true, edge: false };
    if (slot.length > 1 && slot.startsWith('/') && slot.endsWith('/')) {
      const re = new RegExp('^(?:' + slot.slice(1, -1) + ')$');
      return { test: (w) => re.test(w), edge: false };
    }
    const parts = slot.split('|');
    const set = new Set(parts.filter((x) => x !== '^' && x !== '$'));
    return { test: (w) => set.has(w), edge: parts.includes('^') || parts.includes('$') };
  }

  function compile(pat) {
    const slots = pat.trim().split(/\s+/).map((raw) => {
      const optional = raw.startsWith('(') && raw.endsWith(')');
      const s = optional ? raw.slice(1, -1) : raw;
      if (s === 'S' || s.startsWith('S=')) {
        const re = s.length > 2 ? new RegExp('^(?:' + s.slice(2) + ')$') : null;
        return { swear: true, test: (w) => !re || re.test(w) };
      }
      return { optional, ...makeSlot(s) };
    });
    const si = slots.findIndex((x) => x.swear);
    if (si < 0) throw new Error('pattern needs S: ' + pat);
    return { before: slots.slice(0, si).reverse(), swear: slots[si], after: slots.slice(si + 1) };
  }

  // Match slots walking away from the swear (dir -1 before, +1 after).
  function side(slots, words, pos, dir) {
    if (!slots.length) return true;
    const [s, ...rest] = slots;
    if (pos < 0 || pos >= words.length) return (s.edge || s.optional) && side(rest, words, pos, dir);
    if (s.test(words[pos]) && side(rest, words, pos + dir, dir)) return true;
    return !!s.optional && side(rest, words, pos, dir);
  }

  function create(map, senses) {
    const roots = Object.entries(map.roots).map(([name, r]) => ({ name, re: new RegExp('^(?:' + r.token + ')$'), def: r.default }));
    const rules = map.rules.map((r) => ({ ...r, c: compile(r.pat) }));
    const subs = {};
    const rotate = {};
    for (const s of senses.senses) {
      subs[s.id] = s.subs;
      if (s.rotate) rotate[s.id] = 0;
    }

    function rootOf(word) {
      return roots.find((r) => r.re.test(word)) || null;
    }

    // The rule that matches (or the root's default), or null if not a swear.
    function ruleFor(words, i) {
      const r = rootOf(words[i]);
      if (!r) return null;
      for (const rule of rules) {
        if (rule.root !== r.name) continue;
        const c = rule.c;
        if (c.swear.test(words[i]) && side(c.before, words, i - 1, -1) && side(c.after, words, i + 1, 1)) return rule;
      }
      return { sense: r.def };
    }

    function senseOf(words, i) {
      const rule = ruleFor(words, i);
      return rule ? rule.sense : null;
    }

    // What to say for the swear at words[i] with `room` seconds:
    // {sense, say, from, to} — words from..to (inclusive) are replaced. A rule
    // can widen that ("prev": 1 takes "the" in "what the fuck" -> "what on
    // earth"; "next": 1 takes "ton" in "a shit ton" -> "a boatload") and can
    // give its own stand-ins ("subs") for that wording.
    function standIn(words, i, room) {
      const rule = ruleFor(words, i);
      if (!rule) return null;
      const from = Math.max(0, i - (rule.prev || 0));
      const to = Math.min(words.length - 1, i + (rule.next || 0));
      const say = pick(rule.sense, room, words[i], from > 0 ? words[from - 1] : null, rule.subs);
      return { sense: rule.sense, say, from, to };
    }

    // The swear's ending, for stand-ins written with {}: goof{} -> goofing.
    function ending(swear) {
      const w = String(swear || '').toLowerCase();
      if (/(ing|in|in')$/.test(w) && w.length > 5) return 'ing';
      if (/ed$/.test(w)) return 'ed';
      if (/[^s]s$/.test(w) && !/ass$/.test(w)) return 's';
      return '';
    }

    function inflect(sub, swear) {
      return sub.replace(/([a-z-]+)\{\}/g, (m, stem) => {
        const e = ending(swear);
        if (!e) return stem;
        if (e === 'ing') return (/[^e]e$/.test(stem) ? stem.slice(0, -1) : stem) + 'ing';
        if (e === 'ed') return stem + (/e$/.test(stem) ? 'd' : 'ed');
        if (/[^aeiou]y$/.test(stem)) return stem.slice(0, -1) + 'ies';
        return stem + (/(s|sh|ch|x)$/.test(stem) ? 'es' : 's');
      });
    }

    function seconds(t) {
      return 0.12 + 0.2 * t.toLowerCase().split(/[^a-z']+/).filter(Boolean).reduce((n, w) => n + Math.max(1, (w.match(/[aeiouy]+/g) || []).length), 0);
    }

    // What to say instead of `swear` (the word itself, e.g. "fucking") for
    // this sense: the longest stand-in that fits `room` seconds (≈0.2 s a
    // syllable), else the shortest; with the swear's ending, and without
    // repeating the word before it ("oh" + "oh snap" -> "snap").
    // One stand-in as it would be said in place of `swear` after `prev`.
    function say(t, swear, prev) {
      let x = inflect(t, swear);
      if (prev && x.toLowerCase().startsWith(String(prev).toLowerCase() + ' ')) x = x.slice(prev.length + 1);
      return x;
    }

    // Senses marked "rotate" take turns between the stand-ins that fit.
    function pick(sense, room, swear, prev, own) {
      const list = own || subs[sense] || [];
      if (!list.length) return null;
      const opts = list.map((t) => say(t, swear, prev));
      const fit = room == null ? opts.slice(0, 1) : opts.filter((t) => seconds(t) <= room);
      if (!fit.length) return opts[0];
      if (sense in rotate) return fit[rotate[sense]++ % fit.length];
      return fit[fit.length - 1];
    }

    return { tokenize, rootOf: (w) => (rootOf(w) || {}).name || null, senseOf, ruleFor, standIn, pick, say, seconds };
  }

  root.PFSense = { create, tokenize };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PFSense;
})(typeof globalThis !== 'undefined' ? globalThis : self);
