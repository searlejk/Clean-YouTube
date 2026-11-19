"""Clean voice sample per speaker (roadmap step 9).

Runs a test conversation through the companion's stem store (separation,
voice detector, speaker fingerprints) as 48 kHz stereo, then the voice
collector with a word list in which "accident" and "winter*" stand in for
swears (the scripts have none). Checks, per speaker: seconds collected,
that every second is really that person (against the script's turns), and
that no listed word got in. With --music, the same with music underneath.

    .venv/bin/python tests/voice_samples.py DATA_DIR [--music]
"""
import json, subprocess, sys, tempfile, wave
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from separation import Separator
from diarize import Embedder
import stems as S
from voices import VoiceCollector

data = Path(sys.argv[1])
MUSIC = "--music" in sys.argv
LIST = ["accident", "winter*", "*fuck*", "shit*"]
S.IDLE_FLUSH_S = 0.0
rs = lambda x, a, b: np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(a), "-ac", "1", "-i", "-", "-ar", str(b), "-f", "f32le", "-"], input=x.astype(np.float32).tobytes(), capture_output=True).stdout, np.float32)

store = S.StemStore(Separator("Kim_Vocal_2"), Embedder.shared())
vc = VoiceCollector()
for k, name in enumerate(("mixed", "two_women", "two_men")):
    a16 = np.fromfile(data / f"{name}.f32", np.float32)
    meta = json.load(open(data / f"{name}.json"))
    if MUSIC:
        track = ["Komiku - 51 - Chocolate Valley.ogg", "Loyalty Freak Music - No Cadillac.ogg", "Monplaisir - 05 - Heavy Looping.ogg"][k]
        m = np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-i", str(Path(__file__).parent / "music" / track), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True).stdout, np.float32)[16000 * 20:][: len(a16)]
        a16 = a16[: len(m)] + m * 0.5 * np.sqrt(np.mean(a16 ** 2) / np.mean(m ** 2))  # music 6 dB under the voice
    a48 = rs(a16, 16000, 48000)
    stream = f"blob:{name}"
    for i in range(0, len(a48), 48000):
        store.add(stream, i / 48000, 48000, np.stack([a48[i:i + 48000]] * 2))
    while True:
        job, run = store.next_job()
        if not job:
            break
        store.finish(job())
    words = [{"text": w["text"], "start": w["start"], "end": w["end"]} for w in meta["words"]]
    picked = vc.update(store, stream, words, LIST)
    truth = lambda t: next((u["speaker"] for u in meta["turns"] if u["start"] <= t <= u["end"]), None)
    # Which label is which person: majority over the pieces.
    print(f"\n{name} ({' / '.join(meta['voices'])}){' with music' if MUSIC else ''}:")
    banned = [(w["start"], w["end"]) for w in words if any(x in w["text"].lower() for x in ("accident", "winter"))]
    for spk, pieces in sorted(picked.items()):
        secs = sum(p["end"] - p["start"] for p in pieces)
        grid = [t for p in pieces for t in np.arange(p["start"], p["end"], 0.05)]
        who = [truth(t) for t in grid]
        main = max(set(w for w in who if w is not None), key=who.count) if any(w is not None for w in who) else None
        purity = who.count(main) / len(who) if who else 0
        leaks = sum(1 for b0, b1 in banned for p in pieces if p["start"] < b1 and b0 < p["end"])
        mr = [p["music_ratio"] for p in pieces]
        print(f"  speaker {spk}: {secs:5.1f} s from {len(pieces)} stretches  ({'ready' if secs >= 10 else 'not ready'})   right person {purity * 100:5.1f}% (is {meta['voices'][main] if main is not None else '?'})   listed words inside: {leaks}   music/voice {min(mr):.2f}–{max(mr):.2f}")
    out = Path(tempfile.mkdtemp())
    saved = vc.save(store, stream, out)
    for spk in saved:
        with wave.open(str(out / f"speaker{spk}.wav")) as w:
            assert abs(w.getnframes() / w.getframerate() - saved[spk]["seconds"]) < 0.2 + 0.15 * len(saved[spk]["pieces"]), "WAV length mismatch"
    print(f"  saved {len(saved)} WAVs: {sorted(p.name for p in out.iterdir())}")
    store.close(stream)
