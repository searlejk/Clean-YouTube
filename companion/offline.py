"""Process a downloaded video's audio offline, the way the companion does
live, into a folder an editor can work from.

    companion/.venv/bin/python companion/offline.py media/<id>.webm

Writes media/<id>/:
  mix.wav, vocals.wav, background.wav   48 kHz stereo (separated, step 4)
  words.json    every word: text, start, end (aligned, step 5), speaker (step 8)
  swears.json   each swear: its words' span, the pause after, the funny
                stand-in (same logic as the extension), speaker
  voices/speaker<N>.wav + voices.json   clean voice sample per speaker (step 9)
"""
import json, subprocess, sys, time
from pathlib import Path
import numpy as np
import soundfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stems as S
from separation import Separator
from diarize import Embedder
from align import Aligner
from voices import VoiceCollector
from stems import resample

SR = 48000


def main():
    src = Path(sys.argv[1])
    out = src.with_suffix("")
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(src), "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    mix = np.frombuffer(raw, np.float32).reshape(-1, 2).T.copy()
    dur = mix.shape[1] / SR
    print(f"decoded {dur:.0f} s")

    # Separation, voice detection and speaker fingerprints (as live).
    S.IDLE_FLUSH_S = 0.0
    store = S.StemStore(Separator("Kim_Vocal_2"), Embedder.shared())
    stream = "offline"
    for i in range(0, mix.shape[1], SR):
        store.add(stream, i / SR, SR, mix[:, i:i + SR])
    while True:
        job, run = store.next_job()
        if not job:
            break
        store.finish(job())
    voc, bg = store.get(stream, 0.0, dur - 0.01)
    soundfile.write(out / "mix.wav", mix[:, : voc.shape[1]].T, SR)
    soundfile.write(out / "vocals.wav", voc.T, SR)
    soundfile.write(out / "background.wav", bg.T, SR)
    print(f"separated in {time.time() - t0:.0f} s")

    # Transcribe the separated voice in 10 s windows, align, label speakers.
    from faster_whisper import WhisperModel
    asr = WhisperModel("small.en", device="mps", compute_type="float16")
    al = Aligner()
    v16 = resample(voc.mean(axis=0, keepdims=True), int(round(voc.shape[1] * 16000 / SR)))[0]
    words = []
    for off in np.arange(0, len(v16) / 16000, 9.0):
        a, b = int(off * 16000), int(min(len(v16), (off + 10) * 16000))
        seg = v16[a:b]
        if len(seg) < 3200:
            continue
        segs, _ = asr.transcribe(seg, language="en", beam_size=1, word_timestamps=True, condition_on_previous_text=False)
        ws = [{"text": w.word, "start": off + w.start, "end": off + w.end} for s in segs for w in s.words]
        ws = al.align(seg, off, ws)
        # Keep words starting in this window's own 9 s (the last second overlaps the next).
        words += [w for w in ws if off <= w["start"] < off + 9.0 or off + 9.0 >= len(v16) / 16000]
    words.sort(key=lambda w: w["start"])
    store.streams[stream]["diar"].label_words(words)
    for w in words:
        w["text"] = w["text"].strip()
        w["start"], w["end"] = round(w["start"], 3), round(w["end"], 3)
        w.pop("aligned", None)
    (out / "words.json").write_text(json.dumps(words, indent=0))
    print(f"transcribed {len(words)} words in {time.time() - t0:.0f} s")

    swears = json.loads(subprocess.run(["node", str(HERE / "tools" / "match.js"), str(out / "words.json")], capture_output=True, check=True, text=True).stdout)
    (out / "swears.json").write_text(json.dumps(swears, indent=1))

    vc = VoiceCollector()
    vc.update(store, stream, words, json.loads(subprocess.run(["node", "-e", "require(process.argv[1]); console.log(JSON.stringify(globalThis.PF.DEFAULT_WORDS))", str(HERE.parent / "settings.js")], capture_output=True, text=True).stdout))
    meta = vc.save(store, stream, out / "voices")
    speakers = sorted({w.get("speaker") for w in words if w.get("speaker") is not None})
    print(f"{len(swears)} swears, {len(speakers)} speakers; voice samples: " + ", ".join(f"speaker {k}: {v['seconds']} s" for k, v in meta.items()))
    print(f"done in {time.time() - t0:.0f} s -> {out}")


if __name__ == "__main__":
    main()
