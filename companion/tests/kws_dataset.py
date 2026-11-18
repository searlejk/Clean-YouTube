"""Keyword-spotting test set (roadmap step 6.1).

Every swear from the default word list, and look-alike words that must NOT
be caught, each spoken inside a carrier sentence by 26 macOS voices (written
to files; nothing plays aloud). Voices are split: the first 13 for tuning,
the other 13 kept back for the final test.

    .venv/bin/python tests/kws_dataset.py   # -> tests/kws_data/{clips.json, *.f32}
"""
import json, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np

OUT = Path(__file__).parent / "kws_data"
VOICES = ["Samantha", "Daniel", "Karen", "Moira", "Fred", "Tessa", "Rishi", "Kathy", "Eddy (English (US))", "Flo (English (UK))",
          "Reed (English (US))", "Sandy (English (UK))", "Shelley (English (US))",
          "Aman", "Tara", "Eddy (English (UK))", "Flo (English (US))", "Grandma (English (US))", "Grandpa (English (UK))",
          "Reed (English (UK))", "Rocko (English (US))", "Rocko (English (UK))", "Sandy (English (US))", "Shelley (English (UK))",
          "Grandma (English (UK))", "Grandpa (English (US))"]
SWEARS = ["fuck", "fucking", "motherfucker", "shit", "shitty", "bullshit", "bitch", "ass", "asshole", "bastard", "cunt",
          "dick", "cock", "damn", "goddamn", "piss", "pissed", "crap", "whore", "slut", "prick", "twat", "wanker", "son of a bitch"]
NEAR = ["ship", "sheet", "shoot", "shift", "duck", "truck", "luck", "buck", "folk", "witch", "rich", "pitch", "beach",
        "dam", "damp", "dumb", "hello", "shell", "pass", "asked", "glass", "bass", "dock", "dig", "click", "clock",
        "crab", "crack", "prince", "price", "fudge", "shut", "sit", "fun", "cut", "kunt"[0:3] + "try", "puss", "wink", "slot", "tweet"]
TEMPLATES = ["Well, {w}, that is what she told me.", "I really did not expect him to say {w} at the meeting.",
             "Honestly the word {w} came up twice today.", "She looked at the box and said {w} quietly.",
             "Then the old man shouted {w} and walked away."]

def synth(job):
    k, voice, word, label = job
    text = TEMPLATES[k % len(TEMPLATES)].format(w=word)
    with tempfile.TemporaryDirectory() as d:
        a = Path(d) / "x.aiff"
        subprocess.run(["say", "-v", voice, "-o", str(a), text], check=True)
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(a), "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True).stdout
    name = f"c{k:04d}"
    (OUT / f"{name}.f32").write_bytes(raw)
    return {"name": name, "voice": voice, "split": "tune" if VOICES.index(voice) < 13 else "test", "word": word, "label": label, "text": text}

def main():
    OUT.mkdir(exist_ok=True)
    jobs, k = [], 0
    for voice in VOICES:
        for word in SWEARS:
            jobs.append((k, voice, word, "swear")); k += 1
        for word in NEAR:
            jobs.append((k, voice, word, "near")); k += 1
    with ThreadPoolExecutor(6) as pool:
        clips = list(pool.map(synth, jobs))
    json.dump(clips, open(OUT / "clips.json", "w"), indent=0)
    print(f"{len(clips)} clips ({sum(c['label']=='swear' for c in clips)} swears, {sum(c['label']=='near' for c in clips)} look-alikes) in {OUT}")

if __name__ == "__main__":
    main()
