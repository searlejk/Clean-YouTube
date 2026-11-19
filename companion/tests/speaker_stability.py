"""Do people keep their speaker label? (roadmap step 8.2)

Builds one long "video" from the test conversations: A and B talk (the
woman/man conversation), then two new people C and D (the two-men one), then
A and B come back (the first conversation again), so A and B return after a
~80 s absence. It's fed to the diarizer in 10 s pieces in three orders:
straight through; with a seek (the last third first, then from the start);
and with a pause (a 60 s gap of silence before A and B return). For each
person it reports which label(s) their words got.

    .venv/bin/python tests/speaker_stability.py DATA_DIR
"""
import json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from diarize import Diarizer, Embedder
from faster_whisper.vad import VadOptions, get_speech_timestamps

data = Path(sys.argv[1])
VAD = VadOptions(threshold=0.5, min_silence_duration_ms=120, speech_pad_ms=30)

def load(name, people, shift):
    a = np.fromfile(data / f"{name}.f32", np.float32)
    m = json.load(open(data / f"{name}.json"))
    words = [{"text": w["text"], "start": w["start"] + shift, "end": w["end"] + shift, "who": people[w["speaker"]]} for w in m["words"]]
    return a, words

def build(gap):
    parts, words, t = [], [], 0.0
    for name, people in (("mixed", "AB"), ("two_men", "CD"), ("mixed", "AB")):
        if name == "mixed" and t > 0 and gap:
            parts.append(np.zeros(int(gap * 16000), np.float32)); t += gap
        a, w = load(name, people, t)
        parts.append(a); words += w; t += len(a) / 16000
    return np.concatenate(parts), words

def run(audio, words, order):
    d = Diarizer(Embedder.shared())
    offs = list(np.arange(0, len(audio) / 16000, 10.0))
    if order == "seek":
        k = len(offs) * 2 // 3
        offs = offs[k:] + offs[:k]
    for off in offs:
        seg = audio[int(off * 16000): int((off + 10) * 16000)]
        sp = [[off + s["start"] / 16000, off + s["end"] / 16000] for s in get_speech_timestamps(seg, VAD)]
        d.add(off, seg, sp)
    lab = d.label_words([dict(w) for w in words])
    out = {}
    for w, l in zip(words, lab):
        out.setdefault(w["who"], []).append(l["speaker"])
    return out

for order, gap in (("straight", 0), ("seek", 0), ("pause", 60)):
    audio, words = build(gap)
    res = run(audio, words, order)
    summary = []
    ok = True
    used = {}
    for who in "ABCD":
        labs = res[who]
        main = max(set(labs), key=labs.count)
        share = labs.count(main) / len(labs)
        summary.append(f"{who}: label {main} on {share * 100:.0f}% of {len(labs)} words")
        ok &= share >= 0.95 and main not in used
        used[main] = who
    print(f"{order:8s} ({len(audio) / 16000:.0f} s): " + ";  ".join(summary) + ("   OK" if ok else "   PROBLEM"))
