"""Two-person conversations with known speakers (roadmap step 8.1).

Three conversations, each a series of turns spoken by two macOS voices
(written to files; nothing plays aloud): a woman and a man, two men, two
women. Turns are 1–4 sentences with short pauses, like an interview. Every
word's speaker and exact time are recorded (each sentence is synthesized
separately and its words timed by forced alignment against its own text).

    .venv/bin/python tests/interview_dataset.py OUT_DIR
    -> OUT_DIR/<name>.f32 (16 kHz mono) and <name>.json (turns, words with speaker)
"""
import json, random, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from align import Aligner

PAIRS = {"mixed": ("Samantha", "Daniel"), "two_men": ("Fred", "Reed (English (UK))"), "two_women": ("Karen", "Moira"),
         # Same synthesizer family, similar voices: the hard case.
         "similar_men": ("Eddy (English (US))", "Reed (English (US))"), "similar_women": ("Flo (English (US))", "Shelley (English (US))")}
ONLY = sys.argv[2:]  # optional: names to (re)build
LINES = [
    "So tell me how you got started.", "Honestly it was an accident.", "I was working at a small shop downtown and a friend asked for help.",
    "That sounds like a lucky break.", "It was, but it was also a lot of hard work.", "What was the hardest part?",
    "Probably the first winter, when nobody came in for weeks.", "How did you keep going?", "My family helped, and I took a second job at night.",
    "Did you ever think about quitting?", "Every single day for about a year.", "What changed?", "A local paper wrote a story about us and suddenly the phone would not stop ringing.",
    "That must have been overwhelming.", "We had a line out the door for a month.", "And now?", "Now we have three shops and about forty people working with us.",
    "What would you tell someone starting out today?", "Start smaller than you think, and save more than you think.", "Anything else?",
    "Be kind to the people who work with you, they are the whole business.", "That is great advice.", "Thanks for having me.", "Thanks for coming in.",
    "One more question.", "Sure, go ahead.", "Where do you see yourself in five years?", "Hopefully on a beach somewhere, but probably still behind the counter.",
]

def synth(voice, text, d):
    a = Path(d) / "s.aiff"
    subprocess.run(["say", "-v", voice, "-o", str(a), text], check=True)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(a), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True).stdout
    x = np.frombuffer(raw, np.float32)
    nz = np.where(np.abs(x) > 0.005)[0]
    return x[nz[0]: nz[-1] + 1] if len(nz) else x

def main():
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    al = Aligner()
    rng = random.Random(7)
    for name, (va, vb) in PAIRS.items():
        if ONLY and name not in ONLY:
            continue
        parts, words, turns, t = [np.zeros(8000, np.float32)], [], [], 0.5
        speaker = 0
        i = 0
        with tempfile.TemporaryDirectory() as d:
            while i < len(LINES):
                n = rng.choice([1, 1, 2, 2, 3, 4])
                voice = (va, vb)[speaker]
                t_turn = t
                for line in LINES[i:i + n]:
                    x = synth(voice, line, d)
                    ws = al.align(x, 0.0, [{"text": w, "start": 0, "end": 0} for w in line.split()])
                    for w in ws:
                        words.append({"text": w["text"], "start": round(t + w["start"], 3), "end": round(t + w["end"], 3), "speaker": speaker, "aligned": w["aligned"]})
                    parts.append(x); t += len(x) / 16000
                    gap = rng.uniform(0.15, 0.4); parts.append(np.zeros(int(gap * 16000), np.float32)); t += gap
                turns.append({"speaker": speaker, "start": round(t_turn, 3), "end": round(t, 3)})
                i += n
                gap = rng.uniform(0.2, 0.7); parts.append(np.zeros(int(gap * 16000), np.float32)); t += gap
                speaker ^= 1
        audio = np.concatenate(parts).astype(np.float32)
        audio.tofile(out / f"{name}.f32")
        json.dump({"voices": [va, vb], "turns": turns, "words": words, "seconds": len(audio) / 16000}, open(out / f"{name}.json", "w"))
        print(f"{name}: {len(audio) / 16000:.0f} s, {len(turns)} turns, {len(words)} words ({va} / {vb})")

if __name__ == "__main__":
    main()
