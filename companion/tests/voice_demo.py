"""Listen-and-measure demo for a voice-cloning model (roadmap step 10.1).

For each speaker: builds a ~20 s clean sample (from the test conversations'
known turns, or real samples the companion saved with --voices DIR), then
makes replacement words in that voice and saves, in voice-demos/<speaker>/:
  0-original.wav           8 s of the real voice, for comparison
  1-<word>-stock.wav       the word straight from macOS `say`
  2-<word>-cloned.wav      the word after OpenVoice converts it to the speaker
  3-sentence-cloned.wav    a short sentence, easier to judge
Also reports time per word, peak memory, and how close each cloned clip
sounds to the speaker (voice-fingerprint similarity, step 8's model; the
stock voice's score is the baseline). Nothing is played aloud.

    .venv/bin/python tests/voice_demo.py --data DATA_DIR [--device cpu|mps]
    .venv/bin/python tests/voice_demo.py --voices ~/Library/Application\ Support/CleanEars/voices/<video>
"""
import argparse, json, resource, sys, time
from pathlib import Path
import numpy as np
import soundfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "voice-demos"
WORDS = ["shoot", "fudge", "dang", "heck", "darn", "son of a gun"]
SENTENCE = "Oh shoot, that is not what I wanted at all."

def peak_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6  # bytes on macOS

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data"); ap.add_argument("--voices"); ap.add_argument("--device", default="cpu")
    a = ap.parse_args()
    import librosa
    from voice_clone import OpenVoiceCloner, BASES
    from diarize import Embedder
    emb = Embedder.shared()
    def sim(x, sr, ref):  # voice-fingerprint similarity to the speaker's sample
        y = librosa.resample(np.asarray(x, np.float32), orig_sr=sr, target_sr=16000)
        y = np.concatenate([y, y, y]) if len(y) < 16000 * 1.5 else y  # short words: repeat for a usable fingerprint
        e = emb.embed(y)
        return float(e @ ref) if e is not None else float("nan")

    speakers = {}  # name -> 16 kHz sample
    if a.voices:
        for w in sorted(Path(a.voices).glob("speaker*.wav")):
            y, sr = librosa.load(str(w), sr=16000)
            speakers[w.stem] = y
    else:
        data = Path(a.data)
        for name in ("mixed", "two_men", "two_women"):
            x = np.fromfile(data / f"{name}.f32", np.float32); m = json.load(open(data / f"{name}.json"))
            for spk, voice in enumerate(m["voices"]):
                parts = [x[int(u["start"] * 16000): int(u["end"] * 16000)] for u in m["turns"] if u["speaker"] == spk]
                speakers[voice.split(" (")[0] + ("-UK" if "UK" in voice else "")] = np.concatenate(parts)[: 16000 * 20]

    t0 = time.perf_counter(); oc = OpenVoiceCloner(device=a.device); load_s = time.perf_counter() - t0
    print(f"OpenVoice v2 on {a.device}: loaded in {load_s:.1f} s, memory so far {peak_mb():.0f} MB")
    rows = []
    for name, y in speakers.items():
        d = OUT / name; d.mkdir(parents=True, exist_ok=True)
        soundfile.write(d / "0-original.wav", y[: 16000 * 8], 16000)
        ref_wav = d / ".sample.wav"; soundfile.write(ref_wav, y, 16000)
        ref = emb.embed(y)
        t0 = time.perf_counter(); se = oc.speaker_embedding(ref_wav); se_s = time.perf_counter() - t0
        base = oc.base_for(ref_wav)
        oc.base_embedding(base)  # once per stock voice
        times, s_clone, s_stock = [], [], []
        for w in WORDS:
            from voice_clone import say
            stock = say(w, BASES[base], oc.sr)
            soundfile.write(d / f"1-{w.replace(' ', '_')}-stock.wav", stock, oc.sr)
            audio, sr, took = oc.timed_word(w, se, base)
            soundfile.write(d / f"2-{w.replace(' ', '_')}-cloned.wav", audio, sr)
            times.append(took); s_clone.append(sim(audio, sr, ref)); s_stock.append(sim(stock, oc.sr, ref))
        sent, sr, _ = oc.timed_word(SENTENCE, se, base)
        soundfile.write(d / "3-sentence-cloned.wav", sent, sr)
        soundfile.write(d / "3-sentence-stock.wav", __import__("voice_clone").say(SENTENCE, BASES[base], oc.sr), oc.sr)
        ss_clone = sim(sent, sr, ref); ss_stock = sim(__import__("voice_clone").say(SENTENCE, BASES[base], oc.sr), oc.sr, ref)
        ref_wav.unlink()
        rows.append((name, base, se_s, np.median(times), max(times), np.mean(s_stock), np.mean(s_clone), ss_stock, ss_clone))
        print(f"  {name:10s} (from {BASES[base]}): speaker colour {se_s:.2f} s; per word median {np.median(times)*1000:.0f} ms (max {max(times)*1000:.0f}); "
              f"sounds like speaker — words: stock {np.mean(s_stock):.2f} → cloned {np.mean(s_clone):.2f}; sentence: stock {ss_stock:.2f} → cloned {ss_clone:.2f}")
    print(f"peak memory {peak_mb():.0f} MB (whole process, incl. the fingerprint model)")
    print(f"listening files: {OUT}")

if __name__ == "__main__":
    main()
