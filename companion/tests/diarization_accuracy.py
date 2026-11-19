"""Speaker labels per word (roadmap step 8.1).

Runs the diarizer over each test conversation from interview_dataset.py,
feeding it 10 s at a time like the extension's read-ahead does (with the
voice detector's speech stretches), labels every word, and reports the share
of words given the right speaker (labels mapped to speakers the best way).

    .venv/bin/python tests/diarization_accuracy.py DATA_DIR [--music]
"""
import itertools, json, subprocess, sys, time
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from diarize import Diarizer, Embedder
from faster_whisper.vad import VadOptions, get_speech_timestamps

data = Path(sys.argv[1])
VAD = VadOptions(threshold=0.5, min_silence_duration_ms=120, speech_pad_ms=30)

def accuracy(words):
    truth = [w["speaker"] for w in words]
    pred = [w.get("label") for w in words]
    labels = sorted({p for p in pred if p is not None})
    best = 0
    for perm in itertools.permutations(range(max(2, len(labels))), len(labels)):
        m = dict(zip(labels, perm))
        best = max(best, sum(1 for t, p in zip(truth, pred) if p is not None and m[p] == t))
    return best / len(words), len(labels), sum(p is None for p in pred)

emb = Embedder()
MUSIC = "--music" in sys.argv
_sep = None
def with_music(x16, k):
    """Same-loudness CC0 music under the speech, then voice separation, like the companion."""
    global _sep
    from separation import Separator
    if _sep is None:
        _sep = Separator("Kim_Vocal_2")
    track = ["Komiku - 51 - Chocolate Valley.ogg", "Monplaisir - 05 - Heavy Looping.ogg", "Loyalty Freak Music - No Cadillac.ogg", "Komiku - 01 - Intro.ogg", "Loyalty Freak Music - 10 - Everyone is so alive.ogg"][k % 5]
    m = np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-i", str(Path(__file__).parent / "music" / track), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True).stdout, np.float32)[16000 * 20:][: len(x16)]
    mix = x16[: len(m)] + m * np.sqrt(np.mean(x16 ** 2) / np.mean(m ** 2))
    rs = lambda x, a, b: np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(a), "-ac", "1", "-i", "-", "-ar", str(b), "-f", "f32le", "-"], input=x.astype(np.float32).tobytes(), capture_output=True).stdout, np.float32)
    x44 = rs(mix, 16000, 44100)
    v, _ = _sep.separate(np.stack([x44, x44]))
    return rs(v.mean(0), 44100, 16000)[: len(x16)]

for k, name in enumerate(n for n in ("mixed", "two_men", "two_women", "similar_men", "similar_women") if (data / f"{n}.f32").exists()):
    audio = np.fromfile(data / f"{name}.f32", np.float32)
    if MUSIC:
        audio = with_music(audio, k)
    meta = json.load(open(data / f"{name}.json"))
    words = [dict(w) for w in meta["words"]]
    d = Diarizer(emb)
    t_start = time.perf_counter()
    for off in np.arange(0, len(audio) / 16000, 10.0):
        seg = audio[int(off * 16000): int((off + 10) * 16000)]
        speech = [[off + s["start"] / 16000, off + s["end"] / 16000] for s in get_speech_timestamps(seg, VAD)]
        d.add(off, seg, speech)
    took = time.perf_counter() - t_start
    labelled = d.label_words([{"text": w["text"], "start": w["start"], "end": w["end"]} for w in words])
    for w, l in zip(words, labelled):
        w["label"] = l["speaker"]
    acc, n_lab, unl = accuracy(words)
    # How separable: similarity of each fingerprint to its own speaker's other fingerprints vs the other speaker's.
    lab = {round(c, 2): None for c, *_ in d.windows}
    truth_at = lambda t: next((tu["speaker"] for tu in meta["turns"] if tu["start"] <= t <= tu["end"]), None)
    E = np.stack([w[3] for w in d.windows]); T = np.array([truth_at(w[0]) for w in d.windows], dtype=object)
    S = E @ E.T; same = [S[i, j] for i in range(len(T)) for j in range(i) if T[i] is not None and T[i] == T[j]]; diff = [S[i, j] for i in range(len(T)) for j in range(i) if T[i] is not None and T[j] is not None and T[i] != T[j]]
    print(f"{name:10s} ({' / '.join(meta['voices'])}): words with the right speaker {acc * 100:5.1f}%   speakers found {n_lab}   unlabelled {unl}   ({took:.1f} s for {len(audio) / 16000:.0f} s)   similarity same person 5% {np.percentile(same, 5):.2f} vs different 95% {np.percentile(diff, 95):.2f}")
