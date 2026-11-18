// Word-list matching. Pure functions so they can be unit tested in Node.
(function (root) {
  // Turn a transcribed word like " F***ing," or "Mother-Fucker!" into
  // comparable forms: the joined word plus each hyphen-separated part.
  function normalizeToken(text) {
    const lower = String(text)
      .toLowerCase()
      .replace(/[‘’ʼ`]/g, "'")
      .replace(/'/g, '');
    const parts = lower
      .split(/[-‐-―]+/)
      .map((p) => p.replace(/[^a-z0-9*]/g, ''))
      .filter(Boolean);
    const joined = parts.join('');
    const forms = joined ? [joined] : [];
    if (parts.length > 1) forms.push(...parts);
    return forms;
  }

  // Whisper occasionally writes swears pre-censored, e.g. "f***" or "s**t".
  function looksCensored(form) {
    return /[a-z0-9]/.test(form) && /\*/.test(form);
  }

  function patternToRegex(pattern) {
    const clean = String(pattern)
      .toLowerCase()
      .replace(/[‘’ʼ`']/g, '')
      .replace(/[^a-z0-9*]/g, '');
    if (!clean.replace(/\*/g, '')) return null;
    const body = clean
      .split('*')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[a-z0-9]*');
    return new RegExp('^' + body + '$');
  }

  // Entries with spaces become phrases ("son of a bitch"); everything else is
  // a single-word pattern where * is a wildcard.
  function compileWordList(list) {
    const singles = [];
    const phrases = [];
    for (const raw of list || []) {
      const entry = String(raw).trim();
      if (!entry || entry.startsWith('#')) continue;
      const pieces = entry.split(/\s+/);
      if (pieces.length === 1) {
        const re = patternToRegex(entry);
        if (re) singles.push({ re, source: entry });
      } else {
        const res = pieces.map(patternToRegex);
        if (res.every(Boolean)) phrases.push({ res, source: entry });
      }
    }
    return { singles, phrases };
  }

  function tokenMatches(forms, re) {
    return forms.some((f) => re.test(f));
  }

  // words: [{ text, start, end, aligned? }] -> [{ start, end, text, rule, aligned }]
  // (`aligned`: every word in the match was placed by forced alignment)
  function findMatches(words, compiled) {
    const out = [];
    const norm = words.map((w) => normalizeToken(w.text));
    const span = (a, b, rule) => ({
      start: words[a].start,
      end: words[b].end,
      text: words.slice(a, b + 1).map((w) => w.text.trim()).join(' '),
      rule,
      aligned: words.slice(a, b + 1).every((w) => w.aligned),
    });

    for (let i = 0; i < words.length; i++) {
      const forms = norm[i];
      if (!forms.length) continue;
      if (forms.some(looksCensored)) {
        out.push(span(i, i, '(pre-censored)'));
        continue;
      }
      const hit = compiled.singles.find((s) => tokenMatches(forms, s.re));
      if (hit) out.push(span(i, i, hit.source));
    }

    for (const phrase of compiled.phrases) {
      const n = phrase.res.length;
      for (let i = 0; i + n <= words.length; i++) {
        let ok = true;
        for (let k = 0; k < n && ok; k++) ok = tokenMatches(norm[i + k], phrase.res[k]);
        if (ok) {
          out.push(span(i, i + n - 1, phrase.source));
        }
      }
    }

    return out.sort((a, b) => a.start - b.start);
  }

  root.PFFilter = { normalizeToken, patternToRegex, compileWordList, findMatches };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.PFFilter;
})(typeof globalThis !== 'undefined' ? globalThis : self);
