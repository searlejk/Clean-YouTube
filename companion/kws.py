"""Swear-word spotting from wav2vec2's letter probabilities (roadmap step 6).

A second detector that doesn't depend on Whisper's transcript: Whisper can
mishear a swear, or write a near-miss ("ship"), and then the word list never
sees it. wav2vec2 already gives, every 20 ms, how likely each letter is (it's
computed anyway for word alignment). For each word-list pattern this finds
the best place in the window where its spelling could have been said (CTC
keyword spotting: any start and end frame, letters may be held and separated
by blanks) and scores it against the most likely reading of those same
frames. A score near 0 means "this stretch sounds like that word".

Patterns follow the extension's word list: `shit*` must start a word,
`*fuck*` may sit inside one, `ass` must be a whole word, and phrases
("son of a bitch") are spelled with word gaps. Word edges are checked with
wav2vec2's word-separator token.

    spot = KeywordSpotter(vocab)
    spot.set_words(["*fuck*", "shit*", "ass", "son of a bitch"])
    hits = spot.find(emissions, frame_s, offset)   # [{word, start, end, score}]
"""

import re

import numpy as np

BLANK = 0
SEP = 4  # '|'
THRESHOLD = -1.0  # mean log-prob gap per frame; set from the tuning voices (tests/kws_eval.py)
MIN_GAP_S = 0.3  # hits closer than this for the same pattern are one hit


class KeywordSpotter:
    def __init__(self, vocab, threshold=THRESHOLD):
        self.vocab = vocab
        self.threshold = threshold
        self.patterns = []

    def set_words(self, words):
        """Build letter sequences from word-list entries. Entries with a '*'
        in the middle, or too short to spot reliably, are skipped."""
        pats = []
        for raw in words:
            w = raw.strip().lower()
            if not w:
                continue
            start_free, end_free = w.startswith("*"), w.endswith("*")
            core = w.strip("*")
            if "*" in core:
                continue
            letters = []
            for i, part in enumerate(core.split()):
                ids = [self.vocab[c] for c in re.sub(r"[^A-Z']", "", part.upper()) if c in self.vocab]
                if not ids:
                    continue
                if letters:
                    letters.append(SEP)
                letters += ids
            if sum(t != SEP for t in letters) < 3:
                continue
            pats.append({"word": raw.strip(), "tokens": np.array(letters, np.int64), "start_bound": not start_free, "end_bound": not end_free})
        self.patterns = pats

    @staticmethod
    def _spot(em, tokens):
        """Best path for `tokens` ending at each frame, starting anywhere.
        Returns (score[T], start[T]) for paths that have used every token."""
        T, N = em.shape[0], len(tokens)
        tok = em[:, tokens]  # [T, N]
        stay = np.maximum(em[:, BLANK][:, None], tok)  # hold a letter or pass a blank
        dp = np.full(N, -np.inf, np.float32)
        st = np.zeros(N, np.int64)
        score = np.full(T, -np.inf, np.float32)
        start = np.zeros(T, np.int64)
        for t in range(T):
            hold = dp + stay[t]
            enter = np.empty(N, np.float32)
            enter[0] = tok[t, 0]  # begin here
            enter[1:] = dp[:-1] + tok[t, 1:]
            from_enter = enter >= hold
            new_st = np.where(from_enter, np.concatenate(([t], st[:-1])), st)
            dp = np.where(from_enter, enter, hold)
            st = new_st
            score[t], start[t] = dp[-1], st[-1]
        return score, start

    def _edge_ok(self, em, a, b, start_bound, end_bound, window=3):
        """For bounded edges, the frames just outside the word should look
        like a word gap (separator or blank), not more letters."""
        T = em.shape[0]
        p = np.exp(em)
        gap = p[:, BLANK] + p[:, SEP]

        def ok(lo, hi):
            lo, hi = max(0, lo), min(T, hi)
            if hi <= lo:
                return True  # window edge: can't tell, allow
            # The most letter-like frame next to the edge must still be mostly gap,
            # or a separator must appear there.
            return p[lo:hi, SEP].max() > 0.3 or gap[lo:hi].min() > 0.5

        return (not start_bound or ok(a - window, a)) and (not end_bound or ok(b + 1, b + 1 + window))

    def find(self, em, frame_s, offset=0.0):
        """Hits for all patterns in a window of emissions (log-probs [T, 32])."""
        if not self.patterns or em.shape[0] < 3:
            return []
        best = em.max(axis=1)
        csum = np.concatenate(([0.0], np.cumsum(best)))
        hits = []
        for pat in self.patterns:
            score, start = self._spot(em, pat["tokens"])
            ends = np.where(np.isfinite(score))[0]
            if not len(ends):
                continue
            length = ends - start[ends] + 1
            ref = csum[ends + 1] - csum[start[ends]]
            conf = (score[ends] - ref) / length  # <= 0; 0 = the best reading
            order = np.argsort(-conf)
            taken = []
            for i in order:
                if conf[i] < self.threshold:
                    break
                b, a = int(ends[i]), int(start[ends[i]])
                if any(abs(a - ta) * frame_s < MIN_GAP_S for ta in taken):
                    continue
                if not self._edge_ok(em, a, b, pat["start_bound"], pat["end_bound"]):
                    continue
                taken.append(a)
                hits.append({"word": pat["word"], "start": round(offset + a * frame_s, 3), "end": round(offset + (b + 1) * frame_s, 3), "score": round(float(conf[i]), 3)})
        hits.sort(key=lambda h: h["start"])
        return hits

    def best_scores(self, em):
        """Best confidence per pattern in the window (for tuning)."""
        best = em.max(axis=1)
        csum = np.concatenate(([0.0], np.cumsum(best)))
        out = {}
        for pat in self.patterns:
            score, start = self._spot(em, pat["tokens"])
            ends = np.where(np.isfinite(score))[0]
            if not len(ends):
                continue
            conf = (score[ends] - (csum[ends + 1] - csum[start[ends]])) / (ends - start[ends] + 1)
            order = np.argsort(-conf)
            for i in order[:5]:  # best few, skipping ones that fail the edge check
                b, a = int(ends[i]), int(start[ends[i]])
                if self._edge_ok(em, a, b, pat["start_bound"], pat["end_bound"]):
                    out[pat["word"]] = float(conf[i])
                    break
        return out
