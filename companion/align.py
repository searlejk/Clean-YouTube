"""Word timings by forced alignment (roadmap step 5.2), the WhisperX approach.

Whisper says *what* was said; wav2vec2 (a CTC model trained on letters) says
*when*. The transcript is turned into a letter sequence and the most likely
path through wav2vec2's per-frame letter probabilities (20 ms frames) is
found with Viterbi, so each word gets the frames its letters were heard in.
Runs the ONNX model with onnxruntime; no PyTorch.

    al = Aligner()
    words = al.align(samples16k, offset, words)   # words: [{text, start, end}] (media s)
    # -> same words with start/end from the audio; words it can't place keep
    #    Whisper's times and get "aligned": False
"""

import json
import re
from pathlib import Path

import numpy as np
import onnxruntime as ort

SR = 16000
MODELS = Path(__file__).parent / "models"
NAME = "wav2vec2-base-960h"
BLANK = 0  # <pad>
SEP = "|"
MAX_SECONDS = 30  # longer clips are aligned in pieces by Whisper segment (callers keep windows ~10 s)
HOP = 160  # 10 ms loudness frames for refining edges
MAX_BACK_S = 0.3  # how far a start may move earlier to the sound's onset
MAX_FWD_S = 0.35  # how far an end may move later to where the sound fades
EDGE_LEVEL = 0.03  # edge = where loudness falls below this share of the word's peak (0.12 left soft "s"/"h" starts ~65 ms late)


def _log_softmax(x):
    m = x.max(axis=-1, keepdims=True)
    return x - m - np.log(np.exp(x - m).sum(axis=-1, keepdims=True))


class Aligner:
    def __init__(self, providers=None):
        path = MODELS / f"{NAME}.onnx"
        if not path.exists():
            raise FileNotFoundError(f"{path} missing (see companion/README.md)")
        self.vocab = json.loads((MODELS / f"{NAME}.vocab.json").read_text())
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.add_free_dimension_override_by_name("batch_size", 1)
        self.session = ort.InferenceSession(str(path), opts, providers=providers or ["CPUExecutionProvider"])
        self.provider = self.session.get_providers()[0]

    def emissions(self, samples):
        x = np.asarray(samples, np.float32)
        x = (x - x.mean()) / np.sqrt(x.var() + 1e-7)  # the model's normalization
        logits = self.session.run(None, {"input_values": x[None, :]})[0][0]
        return _log_softmax(logits.astype(np.float32))

    def tokens_for(self, words):
        """Letter ids for the transcript, with '|' between words. Returns
        (tokens, owner): owner[i] is the word index of token i (-1 for '|')."""
        tokens, owner = [], []
        for wi, w in enumerate(words):
            letters = [self.vocab[c] for c in re.sub(r"[^A-Z']", "", w["text"].upper().replace("’", "'")) if c in self.vocab]
            if not letters:
                continue
            if tokens:
                tokens.append(self.vocab[SEP])
                owner.append(-1)
            tokens += letters
            owner += [wi] * len(letters)
        return np.array(tokens, np.int64), owner

    @staticmethod
    def viterbi(em, tokens):
        """Frame at which each token is first emitted (CTC forced alignment,
        as in the torchaudio/WhisperX tutorial: a token is entered from the
        previous one, or held through blank frames)."""
        T, N = em.shape[0], len(tokens)
        if N == 0 or T < N:
            return None
        trellis = np.full((T + 1, N + 1), -np.inf, np.float32)
        trellis[0, 0] = 0.0
        tok_em = em[:, tokens]  # [T, N]
        blank = em[:, BLANK]
        for t in range(T):
            trellis[t + 1, 0] = trellis[t, 0] + blank[t]
            stay = trellis[t, 1:] + blank[t]
            enter = trellis[t, :-1] + tok_em[t]
            trellis[t + 1, 1:] = np.maximum(stay, enter)
        # Backtrack from the end with every token used.
        starts = np.zeros(N, np.int64)
        j, t = N, T
        while j > 0 and t > 0:
            stay = trellis[t - 1, j] + blank[t - 1]
            enter = trellis[t - 1, j - 1] + tok_em[t - 1, j - 1]
            if enter >= stay:
                starts[j - 1] = t - 1
                j -= 1
            t -= 1
        if j > 0:
            return None
        return starts

    def align(self, samples, offset, words):
        out = [dict(w, aligned=False) for w in words]
        if not words or len(samples) < SR * 0.2 or len(samples) > SR * MAX_SECONDS:
            return out
        em = self.emissions(samples)
        frame = len(samples) / SR / em.shape[0]  # ~0.02 s
        tokens, owner = self.tokens_for(words)
        starts = self.viterbi(em, tokens)
        if starts is None:
            return out
        n = len(tokens)
        for wi in range(len(words)):
            idx = [i for i in range(n) if owner[i] == wi]
            if not idx:
                continue
            first, last = idx[0], idx[-1]
            # A letter lasts while it's more likely than silence, up to where
            # the next token starts.
            nxt = starts[last + 1] if last + 1 < n else em.shape[0]
            tok = tokens[last]
            end_f = starts[last] + 1
            for f in range(starts[last] + 1, nxt):
                if em[f, tok] > em[f, BLANK]:
                    end_f = f + 1
                else:
                    break
            out[wi].update(start=starts[first] * frame, end=end_f * frame, aligned=True)
        self.refine_edges(samples, out)
        for w in out:
            if w["aligned"]:
                w["start"] = round(offset + w["start"], 3)
                w["end"] = round(offset + w["end"], 3)
        return out

    @staticmethod
    def refine_edges(samples, words):
        """CTC fires a letter at its peak, not its onset (vowel-first words
        came out ~150 ms late) and the last letter's frame ends early. Move
        each start back to where the word's sound begins and each end on to
        where it fades, using the loudness envelope, never past the
        neighbouring words. Times here are seconds within `samples`."""
        x = np.asarray(samples, np.float32)
        n = len(x) // HOP
        if n < 3:
            return
        env = np.sqrt((x[: n * HOP].reshape(n, HOP) ** 2).mean(axis=1))
        floor = np.percentile(env, 10)
        placed = [w for w in words if w["aligned"]]
        for i, w in enumerate(placed):
            a, b = int(w["start"] * SR / HOP), max(int(w["start"] * SR / HOP) + 1, int(np.ceil(w["end"] * SR / HOP)))
            a, b = min(a, n - 1), min(b, n)
            peak = env[a:b].max() if b > a else env[a]
            level = max(floor * 2, peak * EDGE_LEVEL)
            prev_end = int(placed[i - 1]["end"] * SR / HOP) if i else 0
            lo = max(prev_end, a - int(MAX_BACK_S * SR / HOP))
            s = a
            while s - 1 >= lo and env[s - 1] > level:
                s -= 1
            nxt = int(placed[i + 1]["start"] * SR / HOP) if i + 1 < len(placed) else n
            hi = min(nxt, b + int(MAX_FWD_S * SR / HOP), n)
            e = b
            while e < hi and env[e] > level:
                e += 1
            w["start"] = s * HOP / SR
            w["end"] = max(e * HOP / SR, w["start"] + 0.02)
