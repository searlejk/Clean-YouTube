"""Who is speaking (roadmap step 8): speaker labels for each word.

A voice-fingerprint model (WeSpeaker ResNet34, ONNX) turns 1.5 s of speech
into a 256-number vector; vectors from the same person point the same way.
Fingerprints are taken every 0.5 s through the speech, grouped online (a
fingerprint joins the most similar speaker if it's close enough, otherwise
starts a new one), and every stored stretch is re-assigned to the current
speaker profiles when asked, so early guesses get corrected as more speech
arrives and a person keeps one label for the whole video. Each word gets
the speaker of the stretch centred nearest to it.

    d = Diarizer(Embedder())
    d.add(t0, samples16k, speech=[[a, b], ...])   # speech stretches in media time (optional)
    d.label_words(words)                          # adds "speaker": 0, 1, ... (or None)
"""

from pathlib import Path

import numpy as np
import onnxruntime as ort

SR = 16000
MODEL = Path(__file__).parent / "models" / "wespeaker_en_voxceleb_resnet34_LM.onnx"
WIN_S = 1.5  # speech per fingerprint
HOP_S = 0.5
MIN_S = 0.6  # shortest stretch worth a fingerprint
SAME = 0.55  # cosine similarity above which a fingerprint joins a speaker online
# Profiles at least this similar are merged into one person. Off (> 1): on the
# test conversations merging never helped (at 0.5–0.8 it merged two real
# people under music before it fixed any split).
MERGE = float(__import__("os").environ.get("CE_MERGE", 1.1))
MAX_SPEAKERS = 6


def _mel_banks(n_fft=512, n_mels=80, lo=20.0, hi=8000.0):
    mel = lambda f: 1127.0 * np.log(1.0 + f / 700.0)
    m = np.linspace(mel(lo), mel(hi), n_mels + 2)
    fft_mel = mel(np.arange(n_fft // 2 + 1) * SR / n_fft)
    banks = np.zeros((n_mels, n_fft // 2 + 1), np.float32)
    for i in range(n_mels):
        l, c, r = m[i], m[i + 1], m[i + 2]
        up = (fft_mel - l) / (c - l)
        down = (r - fft_mel) / (r - c)
        banks[i] = np.maximum(0, np.minimum(up, down))
    return banks


_BANKS = _mel_banks()
_WIN = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(400) / 399)) ** 0.85  # Kaldi "povey" window


def fbank(x):
    """Kaldi-style 80-band log-mel features (25 ms frames, 10 ms hop), mean-normalized."""
    x = np.asarray(x, np.float32) * 32768.0  # WeSpeaker expects 16-bit scale
    n = 1 + (len(x) - 400) // 160
    if n < 1:
        return np.zeros((0, 80), np.float32)
    idx = np.arange(400)[None, :] + 160 * np.arange(n)[:, None]
    f = x[idx]
    f = f - f.mean(axis=1, keepdims=True)  # remove DC
    f = np.concatenate([f[:, :1] - 0.97 * f[:, :1], f[:, 1:] - 0.97 * f[:, :-1]], axis=1)  # pre-emphasis
    f = f * _WIN
    spec = np.abs(np.fft.rfft(f, n=512, axis=1)) ** 2
    feats = np.log(np.maximum(spec @ _BANKS.T, 1.1920929e-07)).astype(np.float32)
    return feats - feats.mean(axis=0, keepdims=True)


class Embedder:
    _shared = None

    @classmethod
    def shared(cls):
        if cls._shared is None:
            cls._shared = cls()
        return cls._shared

    def __init__(self, providers=None):
        if not MODEL.exists():
            raise FileNotFoundError(f"{MODEL} missing (see companion/README.md)")
        opts = ort.SessionOptions()
        opts.add_free_dimension_override_by_name("B", 1)
        self.session = ort.InferenceSession(str(MODEL), opts, providers=providers or ["CPUExecutionProvider"])

    def embed(self, samples):
        feats = fbank(samples)
        if len(feats) < 20:
            return None
        e = self.session.run(None, {"feats": feats[None]})[0][0]
        return e / (np.linalg.norm(e) + 1e-9)


class Diarizer:
    def __init__(self, embedder, same=SAME):
        self.emb = embedder
        self.same = same
        self.windows = []  # (center_s, start_s, end_s, embedding)
        self.done = set()  # window starts already fingerprinted (rounded)
        self.centroids = []  # running sums
        self.counts = []

    # ── keeping labels across page reloads (step 8.2) ──
    def state(self):
        """Speaker profiles to save with the video (a few KB)."""
        return {"centroids": np.stack(self.centroids).astype(np.float32) if self.centroids else np.zeros((0, 256), np.float32), "counts": np.array(self.counts, np.int64)}

    def restore(self, state):
        """Start from saved profiles: people heard before keep their labels."""
        c, n = state.get("centroids"), state.get("counts")
        if c is not None and len(c) and not self.centroids:
            self.centroids = [np.asarray(x, np.float32) for x in c]
            self.counts = [int(k) for k in n]

    def _assign(self, e):
        if self.centroids:
            sims = [float(e @ (c / np.linalg.norm(c))) for c in self.centroids]
            k = int(np.argmax(sims))
            if sims[k] >= self.same or len(self.centroids) >= MAX_SPEAKERS:
                self.centroids[k] = self.centroids[k] + e
                self.counts[k] += 1
                return k
        self.centroids.append(e.copy())
        self.counts.append(1)
        return len(self.centroids) - 1

    def add(self, t0, samples, speech=None):
        """Fingerprint new speech in `samples` (16 kHz, starting at media time
        t0). `speech`: [[a, b], ...] stretches with speech (e.g. from the voice
        detector); without it the whole clip is used."""
        dur = len(samples) / SR
        spans = speech if speech is not None else [[t0, t0 + dur]]
        for a, b in spans:
            a, b = max(a, t0), min(b, t0 + dur)
            if b - a < MIN_S:
                continue
            starts = np.arange(a, max(a, b - WIN_S) + 1e-6, HOP_S) if b - a > WIN_S else [a]
            for s in starts:
                key = round(s, 2)
                if key in self.done:
                    continue
                e_ = min(b, s + WIN_S)
                e = self.emb.embed(samples[int((s - t0) * SR): int((e_ - t0) * SR)])
                if e is None:
                    continue
                self.done.add(key)
                self._assign(e)
                self.windows.append(((s + e_) / 2, s, e_, e))

    def profiles(self):
        """Speaker profiles after merging ones that are really the same person
        (noise or music left by separation can split one voice in two), and
        dropping one-off glitches. Returns (ids, unit centroids)."""
        groups = [[k] for k in range(len(self.centroids))]
        sums = [c.copy() for c in self.centroids]
        while len(groups) > 1:
            U = np.stack([c / np.linalg.norm(c) for c in sums])
            S = U @ U.T
            np.fill_diagonal(S, -1)
            i, j = np.unravel_index(np.argmax(S), S.shape)
            if S[i, j] < MERGE:
                break
            i, j = min(i, j), max(i, j)
            groups[i] += groups.pop(j)
            sums[i] = sums[i] + sums.pop(j)
        counts = [sum(self.counts[k] for k in g) for g in groups]
        keep = [g for g, n in enumerate(counts) if n >= 3] or list(range(len(groups)))
        ids = [min(groups[g]) for g in keep]  # stable: a person keeps their first label
        return ids, np.stack([sums[g] / np.linalg.norm(sums[g]) for g in keep])

    def speakers(self):
        """Current label of every stretch, re-assigned to the final profiles
        (so early guesses follow what was learned later)."""
        if not self.centroids:
            return []
        ids, C = self.profiles()
        out = []
        for center, s, e, emb in self.windows:
            sims = C @ emb
            order = np.argsort(-sims)
            margin = float(sims[order[0]] - sims[order[1]]) if len(sims) > 1 else 1.0
            out.append((center, s, e, ids[int(order[0])], margin))
        return out

    def label_words(self, words):
        labels = self.speakers()
        if not labels:
            for w in words:
                w["speaker"] = None
            return words
        centers = np.array([l[0] for l in labels])
        for w in words:
            mid = (w["start"] + w["end"]) / 2
            # Stretches covering the word; pick the one centred nearest it.
            cover = [i for i, l in enumerate(labels) if l[1] <= mid <= l[2]]
            i = min(cover, key=lambda i: abs(centers[i] - mid)) if cover else int(np.argmin(np.abs(centers - mid)))
            near = abs(centers[i] - mid) < 2.0
            w["speaker"] = labels[i][3] if near else None
            # How much more this voice matched its speaker than the next one
            # (step 12.4 falls back to silence when unsure).
            w["speaker_conf"] = round(labels[i][4], 3) if near else 0.0
        return words
