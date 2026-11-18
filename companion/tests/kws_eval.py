"""Keyword spotter vs Whisper on the swear / look-alike set (roadmap 6.2–7.2).

For each clip: the spotter's best score (any word-list pattern) and whether
Whisper small's transcript matches the word list. The spotter's threshold is
chosen on the 13 tuning voices (lowest threshold... highest one that still
catches >= 95% of swears), then everything is reported on the 13 held-back
voices: swears caught (recall) and look-alikes wrongly caught (false alarms),
for Whisper alone, the spotter alone, and either one.

    .venv/bin/python tests/kws_eval.py [--music]   (after tests/kws_dataset.py)
"""
import fnmatch, json, re, subprocess, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from align import Aligner
from kws import KeywordSpotter

HERE = Path(__file__).parent
DATA = HERE / "kws_data"
ROOT = HERE.parents[1]
WORDS = re.findall(r"'([^']+)'", re.search(r"DEFAULT_WORDS = \[(.*?)\];", (ROOT / "settings.js").read_text(), re.S).group(1))

def wordlist_hit(text):
    toks = [re.sub(r"[^a-z']", "", t) for t in text.lower().replace("-", " ").split()]
    toks = [t for t in toks if t]
    for p in WORDS:
        parts = p.split()
        if len(parts) > 1:
            if " ".join(parts) in " ".join(toks):
                return True
        elif any(fnmatch.fnmatchcase(t, p) for t in toks):
            return True
    return "*" in text  # pre-censored

def main():
    music = "--music" in sys.argv
    clips = json.load(open(DATA / "clips.json"))
    al = Aligner()
    spot = KeywordSpotter(al.vocab)
    spot.set_words(WORDS)
    from faster_whisper import WhisperModel
    asr = WhisperModel("small.en", device="mps", compute_type="float16")
    if music:
        track = np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-i", str(HERE / "music" / "Komiku - 01 - Intro.ogg"), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True).stdout, np.float32)
    rows = []
    for i, c in enumerate(clips):
        x = np.fromfile(DATA / f"{c['name']}.f32", np.float32)
        if music:  # music at the same loudness, then voice separation as in the companion
            m = track[(i * 37 * 16000) % (len(track) - len(x)):][: len(x)]
            x = x + m * np.sqrt(np.mean(x ** 2) / (np.mean(m ** 2) + 1e-9))
            x = separate(x)
        em = al.emissions(x)
        best = spot.best_scores(em)
        segs, _ = asr.transcribe(x, language="en", beam_size=1, condition_on_previous_text=False)
        text = " ".join(s.text for s in segs)
        rows.append({**c, "kws": max(best.values()) if best else -99, "kws_word": max(best, key=best.get) if best else None, "asr": wordlist_hit(text), "heard": text.strip()})
        if (i + 1) % 200 == 0:
            print(f"  {i + 1}/{len(clips)} clips", flush=True)
    tune = [r for r in rows if r["split"] == "tune"]
    sw = np.array([r["kws"] for r in tune if r["label"] == "swear"])
    thr = float(np.sort(sw)[int(np.floor(0.05 * len(sw)))])  # 95% of tuning swears at or above
    print(f"\nthreshold from tuning voices (catches 95% of their swears): {thr:.3f}")
    for split in ("tune", "test"):
        rs = [r for r in rows if r["split"] == split]
        S = [r for r in rs if r["label"] == "swear"]
        N = [r for r in rs if r["label"] == "near"]
        k = lambda r: r["kws"] >= thr
        def line(name, f):
            return f"  {name:16s} swears caught {sum(map(f, S))}/{len(S)} ({100 * np.mean([f(r) for r in S]):.1f}%)   look-alikes caught {sum(map(f, N))}/{len(N)} ({100 * np.mean([f(r) for r in N]):.1f}%)"
        print(f"\n{split} voices{' (with music)' if music else ''}:")
        print(line("Whisper + list", lambda r: r["asr"]))
        print(line("spotter", k))
        print(line("either", lambda r: r["asr"] or k(r)))
        print(line("both", lambda r: r["asr"] and k(r)))
    test = [r for r in rows if r["split"] == "test"]
    print("\nheld-back swears missed by both:", [(r["word"], r["voice"], r["heard"]) for r in test if r["label"] == "swear" and not r["asr"] and r["kws"] < thr][:10])
    print("look-alikes caught by the spotter:", sorted({(r["word"], r["kws_word"]) for r in test if r["label"] == "near" and r["kws"] >= thr})[:20])
    json.dump(rows, open(DATA / f"results{'-music' if music else ''}.json", "w"))

_sep = None
def separate(x16):
    global _sep
    from separation import Separator
    import stems as S
    if _sep is None:
        _sep = Separator("Kim_Vocal_2")
    up = lambda x, a, b: np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(a), "-ac", "1", "-i", "-", "-ar", str(b), "-f", "f32le", "-"], input=x.astype(np.float32).tobytes(), capture_output=True).stdout, np.float32)
    x44 = up(x16, 16000, 44100)
    v, _ = _sep.separate(np.stack([x44, x44]))
    return up(v.mean(0), 44100, 16000)[: len(x16)]

if __name__ == "__main__":
    main()
