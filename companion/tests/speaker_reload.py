"""Speaker labels survive a reload (roadmap step 8.2).

Session 1 hears A and B (the woman/man conversation) and its profiles are
saved for a made-up video ID. Session 2 starts fresh, restores them, hears
two new people (C, D) first, then A and B again: A and B must get their
session-1 labels and C, D new ones.

    .venv/bin/python tests/speaker_reload.py DATA_DIR
"""
import json, sys, tempfile
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import stems
from diarize import Diarizer, Embedder
from faster_whisper.vad import VadOptions, get_speech_timestamps

data = Path(sys.argv[1])
stems.PROFILES = Path(tempfile.mkdtemp())  # don't touch the real saved profiles
VAD = VadOptions(threshold=0.5, min_silence_duration_ms=120, speech_pad_ms=30)

def feed(d, name, shift):
    a = np.fromfile(data / f"{name}.f32", np.float32)
    for off in np.arange(0, len(a) / 16000, 10.0):
        seg = a[int(off * 16000): int((off + 10) * 16000)]
        d.add(shift + off, seg, [[shift + off + s["start"] / 16000, shift + off + s["end"] / 16000] for s in get_speech_timestamps(seg, VAD)])
    m = json.load(open(data / f"{name}.json"))
    return [{"text": w["text"], "start": w["start"] + shift, "end": w["end"] + shift, "truth": w["speaker"]} for w in m["words"]]

def labels(d, words, people):
    out = {}
    for w in d.label_words([dict(x) for x in words]):
        out.setdefault(people[w["truth"]], []).append(w["speaker"])
    return {k: (max(set(v), key=v.count), round(v.count(max(set(v), key=v.count)) / len(v), 3)) for k, v in out.items()}

d1 = Diarizer(Embedder.shared())
w1 = feed(d1, "mixed", 0)
first = labels(d1, w1, "AB")
stems.save_profiles("TESTVIDEO01", d1.state())

d2 = Diarizer(Embedder.shared())
d2.restore(stems.load_profiles("TESTVIDEO01"))
wc = feed(d2, "two_men", 0)
wa = feed(d2, "mixed", 100)
second = {**labels(d2, wc, "CD"), **labels(d2, wa, "AB")}
print("session 1:", first)
print("session 2 (restored, new people first):", second)
ok = all(second[p][0] == first[p][0] and second[p][1] >= 0.95 for p in "AB") and len({second[p][0] for p in "ABCD"}) == 4
print("speaker reload test", "passed" if ok else "FAILED")
sys.exit(0 if ok else 1)
