"""Does transcribing the separated voice help under music? (roadmap step 4.3)

Five clips: about a minute of macOS speech (exact script, a different voice
each) over a different CC0 track from tests/music/, mixed with the music 5 dB
quieter than the voice, equal, and 5 dB louder. Each mix is transcribed by
Whisper as-is and after voice separation (the same path the companion uses:
48 kHz stereo -> Kim_Vocal_2 in 10.4 s blocks -> voice -> 16 kHz). Reports
word error rate and how many swears were found.

    .venv/bin/python tests/music_asr_bench.py [--model small.en]

Audio is written to files only; nothing plays aloud.
"""
import argparse, os, re, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from separation import Separator
from stems import StemStore
import stems as S

HERE = Path(__file__).parent
SCRIPTS = [
    ("Samantha", "Komiku - 01 - Intro.ogg",
     "Okay so today we are finally fixing the old truck in my garage. The engine has been making a terrible noise for weeks and honestly it is shit. "
     "I opened the hood this morning and what the hell, there was a bird nest right on top of the battery. My neighbor came over and said damn, that is impressive. "
     "We pulled the nest out carefully, cleaned the terminals, and then the fucking wrench slipped and cracked the headlight. "
     "After lunch we replaced the belt, checked the oil, and tightened every bolt we could find. It finally started on the third try and I was so happy I almost cried."),
    ("Daniel", "Komiku - 51 - Chocolate Valley.ogg",
     "Welcome back to the kitchen. Tonight we are cooking a simple pasta with garlic, lemon and fresh herbs. "
     "First, bring a big pot of salted water to the boil. While that heats up, slice the garlic very thin. Bloody hell, this knife is dull. "
     "Warm the olive oil gently, because burnt garlic tastes like crap. Add the pasta to the water and stir it so it does not stick. "
     "Now zest the lemon right over the pan. If the sauce looks dry, add a splash of the cooking water. "
     "That is the whole trick, and anyone who tells you otherwise is full of bullshit. Taste it, season it, and serve it straight away."),
    ("Karen", "Monplaisir - 05 - Heavy Looping.ogg",
     "Let me tell you about the worst flight I have ever taken. We sat on the runway for three hours with no air conditioning. "
     "The man behind me kept kicking my seat, and when I asked him to stop he called me a bitch. "
     "Then the pilot announced that we had to go back to the gate because of a broken sensor. Everyone groaned. "
     "By the time we finally took off it was nearly midnight, and of course my bag ended up in another city. "
     "The airline gave me a voucher for a sandwich. A sandwich. What a goddamn joke. Next time I am taking the train."),
    ("Moira", "Loyalty Freak Music - No Cadillac.ogg",
     "This week in the garden the tomatoes are finally turning red. I planted them late, so I was worried they would never ripen. "
     "The squirrels have been digging up the flower beds every single night, those little bastards. "
     "I tried a fence, then a net, then a spray that smells like pepper, and none of it worked. "
     "My grandmother used to say that a garden teaches patience, and she was right, but it also teaches you to swear. "
     "Shit, I just stepped on the hose. Anyway, next week we will talk about saving seeds for the spring and building a small greenhouse."),
    ("Fred", "Loyalty Freak Music - 10 - Everyone is so alive.ogg",
     "Alright everyone, quick update on the move. We packed forty boxes yesterday and we are still not done. "
     "The truck rental place lost our reservation, so we had to drive across town to pick up a smaller one. What the fuck. "
     "My brother dropped the television on the stairs and said it was fine, but the screen has a crack right down the middle. "
     "The new apartment is great though. It has big windows, a quiet street, and a kitchen with actual counter space. "
     "Tomorrow we are unpacking the books and assembling the bed, and then I am sleeping for a week. Damn, I am tired."),
]
SWEARS = {"shit", "hell", "damn", "fucking", "bloody", "crap", "bullshit", "bitch", "goddamn", "bastards", "fuck"}
SMR = [5, 0, -5]  # speech-to-music ratio, dB

norm = lambda w: re.sub(r"[^a-z0-9']", "", w.lower())
def words_of(text): return [w for w in (norm(x) for x in text.replace("-", " ").split()) if w]

def wer(ref, hyp):
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
    return d[-1] / len(ref)

def ffmpeg_to(path_or_none, rate, ch, data=None, in_rate=None):
    if data is None:
        cmd = ["ffmpeg", "-v", "error", "-i", str(path_or_none), "-ac", str(ch), "-ar", str(rate), "-f", "f32le", "-"]
        out = subprocess.run(cmd, capture_output=True).stdout
    else:
        cmd = ["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(in_rate), "-ac", "1", "-i", "-", "-ar", str(rate), "-ac", "1", "-f", "f32le", "-"]
        out = subprocess.run(cmd, input=data.astype(np.float32).tobytes(), capture_output=True).stdout
    x = np.frombuffer(out, np.float32)
    return x.reshape(-1, ch).T if ch > 1 else x

def separate_like_companion(store, mix48):
    S.IDLE_FLUSH_S = 0.0
    key = f"clip{id(mix48)}"
    for i in range(0, mix48.shape[1], 48000):
        store.add(key, 1000.0 + i / 48000, 48000, mix48[:, i:i + 48000])
    while True:
        job, run = store.next_job()
        if not job:
            break
        store.finish(job())
    voc, _ = store.get(key, 1000.0, 1000.0 + mix48.shape[1] / 48000 - 0.001)
    store.close(key)
    return voc.mean(0)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small.en")
    args = ap.parse_args()
    from faster_whisper import WhisperModel
    asr = WhisperModel(args.model, device="mps" if args.model != "tiny.en" else "cpu", compute_type="float16" if args.model != "tiny.en" else "int8")
    store = StemStore(Separator("Kim_Vocal_2"))
    tmp = Path(tempfile.mkdtemp())
    def transcribe(x16):
        segs, _ = asr.transcribe(x16, language="en", beam_size=1, condition_on_previous_text=False)
        return words_of(" ".join(s.text for s in segs))
    totals = {}
    print(f"model {args.model}")
    for k, (voice, track, script) in enumerate(SCRIPTS, 1):
        aiff = tmp / f"s{k}.aiff"
        subprocess.run(["say", "-v", voice, "-o", str(aiff), script], check=True)
        speech = ffmpeg_to(aiff, 48000, 1)
        music = ffmpeg_to(HERE / "music" / track, 48000, 2)
        start = 30 * 48000  # skip intros
        music = music[:, start:start + len(speech)]
        ref = words_of(script)
        ref_swears = sum(1 for w in ref if w in SWEARS)
        for smr in SMR:
            gain = np.sqrt(np.mean(speech ** 2) / np.mean(music ** 2)) * 10 ** (-smr / 20)
            mix = np.stack([speech, speech]) + music * gain
            mix /= max(1.0, np.abs(mix).max() / 0.98)
            for label, x48 in (("mix", mix.mean(0)), ("voice", separate_like_companion(store, mix.astype(np.float32)))):
                hyp = transcribe(ffmpeg_to(None, 16000, 1, x48, 48000))
                e = wer(ref, hyp)
                found = min(ref_swears, sum(1 for w in hyp if w in SWEARS))
                t = totals.setdefault((smr, label), [0, 0, 0, 0])
                t[0] += e * len(ref); t[1] += len(ref); t[2] += found; t[3] += ref_swears
                print(f"clip {k} ({voice:8s}) music {-smr:+d} dB  {label:5s}  WER {100 * e:5.1f}%  swears {found}/{ref_swears}")
    print("\nTotals (music level relative to voice):")
    for smr in SMR:
        for label in ("mix", "voice"):
            t = totals[(smr, label)]
            print(f"  music {-smr:+d} dB  {label:5s}  WER {100 * t[0] / t[1]:5.1f}%   swears found {t[2]}/{t[3]}")

if __name__ == "__main__":
    main()
