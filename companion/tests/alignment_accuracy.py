"""Forced-alignment accuracy (roadmap step 5.2).

Uses the exact-timing speech from word_timing.py (OUT_DIR/lag-audio.npy and
lag-truth.json). Each Whisper size transcribes it in 10 s windows (9 s step,
like the extension), then align.py places the words; reports how far word
starts/ends land from the truth, before and after alignment. Also runs on
the same speech mixed with real music (0 dB) through voice separation.

    .venv/bin/python tests/alignment_accuracy.py OUT_DIR
"""
import json, subprocess, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from align import Aligner

out = Path(sys.argv[1])
truth = json.load(open(out / "lag-truth.json"))
clean = np.load(out / "lag-audio.npy").astype(np.float32)
norm = lambda s: "".join(c for c in s.lower() if c.isalnum())

def music_mix():
    from separation import Separator
    import stems as S
    music = np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-i", str(Path(__file__).parent / "music" / "Komiku - 51 - Chocolate Valley.ogg"), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True).stdout, np.float32)[16000 * 30:16000 * 30 + len(clean)]
    mix = clean + music * np.sqrt(np.mean(clean ** 2) / np.mean(music ** 2))
    mix = mix / max(1, np.abs(mix).max() / 0.98)
    up = lambda x: np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", "16000", "-ac", "1", "-i", "-", "-ar", "48000", "-f", "f32le", "-"], input=x.astype(np.float32).tobytes(), capture_output=True).stdout, np.float32)
    down = lambda x: np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "-", "-ar", "16000", "-f", "f32le", "-"], input=x.astype(np.float32).tobytes(), capture_output=True).stdout, np.float32)
    m48 = up(mix)
    S.IDLE_FLUSH_S = 0.0
    st = S.StemStore(Separator("Kim_Vocal_2"))
    for i in range(0, len(m48), 48000):
        st.add("m", i / 48000, 48000, np.stack([m48[i:i + 48000]] * 2))
    while True:
        j, r = st.next_job()
        if not j: break
        st.finish(j())
    voc, _ = st.get("m", 0, len(m48) / 48000 - 0.001)
    return down(voc.mean(0))[: len(clean)]

def run(model, audio, al):
    from faster_whisper import WhisperModel
    dev = "cpu" if model == "tiny.en" else "mps"
    m = WhisperModel(model, device=dev, compute_type="int8" if dev == "cpu" else "float16")
    raw, aligned = [], []
    for off in np.arange(0, len(audio) / 16000, 9.0):
        seg = audio[int(off * 16000): int((off + 10) * 16000)]
        segs, _ = m.transcribe(seg, language="en", word_timestamps=True, beam_size=1, condition_on_previous_text=False)
        ws = [{"text": w.word, "start": off + w.start, "end": off + w.end} for s in segs for w in s.words]
        raw += ws
        aligned += [w for w in al.align(seg, off, ws)]
    return raw, aligned

def score(words):
    ds, de = [], []
    for w, a, b in truth:
        c = [x for x in words if norm(x["text"]) == norm(w) and abs(x["start"] - a) < 1.0]
        if c:
            x = min(c, key=lambda x: abs(x["start"] - a)); ds.append(x["start"] - a); de.append(x["end"] - b)
    late_start.extend(x for x in ds if abs(x) < 0.3)  # >0.3 s off = a different word (transcription error)
    early_end.extend(-x for x in de if abs(x) < 0.3)
    ds, de = np.abs(np.array(ds)), np.array(de)
    return len(ds), np.median(ds), np.percentile(ds, 95), (ds <= 0.05).mean(), np.percentile(de, 5), np.percentile(de, 95)

al = Aligner()
late_start, early_end = [], []  # aligned words only, all models and conditions (step 5.3)
for label, audio in (("clean speech", clean), ("speech + music, voice stem", music_mix())):
    print(f"\n{label}")
    for model in ("tiny.en", "base.en", "small.en"):
        raw, aligned = run(model, audio, al)
        for name, ws in (("whisper", raw), ("aligned", aligned)):
            if name == "whisper":
                keep = (len(late_start), len(early_end))
            n, med, p95, within, e5, e95 = score(ws)
            if name == "whisper":
                del late_start[keep[0]:], early_end[keep[1]:]
            print(f"  {model:9s} {name:8s} matched {n}/{len(truth)}  start error median {med*1000:4.0f} ms, 95% {p95*1000:4.0f} ms, within ±50 ms {within*100:5.1f}%   end offset 5–95% {e5*1000:+5.0f}…{e95*1000:+5.0f} ms")

# Padding a mute needs so the whole word is covered (step 5.3).
ls, ee = np.array(late_start), np.array(early_end)
print("\nAligned words: how much padding covers the whole word")
for q in (95, 99, 100):
    print(f"  {q:3d}% of words: before {max(0, np.percentile(ls, q)) * 1000:4.0f} ms, after {max(0, np.percentile(ee, q)) * 1000:4.0f} ms")
