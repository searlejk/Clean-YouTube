"""Do the new, smaller covers still silence whole words? (roadmap step 5.3)

For every word of the exact-timing speech (word_timing.py), builds the mute
the extension would schedule, old way (Whisper times, per-model lag fix,
0.25 s each side) and new way (forced alignment, 60 ms before / 100 ms
after), and checks the mute covers the whole word. Also reports how much
audio outside the word gets muted. Clean speech and speech over music.

    .venv/bin/python tests/cover_check.py OUT_DIR
"""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from align import Aligner
import alignment_accuracy as A  # reuses its audio and Whisper runs (runs its report first)

LAG = {"tiny.en": (0.25, -0.05), "base.en": (-0.1, -0.35), "small.en": (0.05, -0.2)}  # settings.js COMPANION_MODELS
OLD = (0.25, 0.25)
NEW = (0.06, 0.10)

def check(words, truth, model, aligned):
    covered, extra, n = 0, [], 0
    for w, a, b in truth:
        c = [x for x in words if A.norm(x["text"]) == A.norm(w) and abs(x["start"] - a) < 0.3]
        if not c:
            continue
        x = min(c, key=lambda x: abs(x["start"] - a))
        n += 1
        if aligned and x.get("aligned"):
            m0, m1 = x["start"] - NEW[0], x["end"] + NEW[1]
        else:
            ls, le = LAG[model]
            m0, m1 = x["start"] - ls - OLD[0], x["end"] - le + OLD[1]
        covered += m0 <= a + 0.001 and m1 >= b - 0.001
        extra.append((m1 - m0) - (b - a))
    return n, covered, np.mean(extra)

print("\nWhole word silenced, and extra audio muted per word")
for label, audio in (("clean speech", A.clean), ("speech + music, voice stem", A.music_mix())):
    print(label)
    for model in ("tiny.en", "base.en", "small.en"):
        raw, aligned = A.run(model, audio, A.al)
        for name, ws, is_aligned in (("old (0.25 s)", raw, False), ("new (aligned)", aligned, True)):
            n, cov, ex = check(ws, A.truth, model, is_aligned)
            print(f"  {model:9s} {name:14s} whole word covered {cov}/{n}   extra muted {ex*1000:4.0f} ms per word")
