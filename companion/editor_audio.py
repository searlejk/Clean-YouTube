"""Audio side of the substitute-swear editor (companion/editor_server.py).

Works on a project made by companion/offline.py (media/<id>/). For one swear
and a set of settings it makes the substitute word in the speaker's voice
with OmniVoice and places it over the separated background, so the result
can be compared with the original in context.

Settings (each group can be switched off in the editor):
  say                 the substitute text
  ref_on, ref_seconds, ref_pieces
                      voice reference: the best `ref_seconds` of the
                      speaker's clean sample, or the listed pieces [[a, b], ...]
  pitch_on, pitch     shift in semitones
  tone_on, tone       match the brightness/EQ of the original swear (0–1 strength)
  loud_on, loud_db    loudness: matched to the original swear, then ± dB
  quality_on, steps   OmniVoice decoding steps (more: slower, cleaner)
  timing_on, room_use, length
                      how much of the pause after the swear the word may use
                      (0–1), and a length factor on its natural length
"""

import json
from pathlib import Path

import numpy as np
import soundfile

SR = 48000
DEFAULTS = {
    "say": None,
    "ref_on": True, "ref_seconds": 6.0, "ref_pieces": None,
    "pitch_on": False, "pitch": 0.0,
    "tone_on": False, "tone": 0.7,
    "loud_on": True, "loud_db": 0.0,
    "quality_on": False, "steps": 32,
    "timing_on": True, "room_use": 1.0, "length": 1.0,
}


def _resample(x, a, b):
    import librosa

    return librosa.resample(np.asarray(x, np.float32), orig_sr=a, target_sr=b) if a != b else np.asarray(x, np.float32)


class Project:
    """A processed video: tracks, words, swears, speakers' voice samples."""

    def __init__(self, folder):
        self.dir = Path(folder)
        self.words = json.loads((self.dir / "words.json").read_text())
        self.swears = json.loads((self.dir / "swears.json").read_text())
        vj = self.dir / "voices" / "voices.json"
        self.voices = {int(k): v for k, v in json.loads(vj.read_text()).items()} if vj.exists() else {}
        self._tracks = {}

    def track(self, name):
        """mix / vocals / background as float32 [2, n] at 48 kHz (memory-mapped read)."""
        if name not in self._tracks:
            x, sr = soundfile.read(str(self.dir / f"{name}.wav"), dtype="float32", always_2d=True)
            self._tracks[name] = x.T
        return self._tracks[name]

    def slice(self, name, t0, t1):
        x = self.track(name)
        a, b = max(0, int(t0 * SR)), min(x.shape[1], int(t1 * SR))
        return x[:, a:b]

    def text_between(self, a, b):
        return " ".join(w["text"] for w in self.words if a <= (w["start"] + w["end"]) / 2 < b)

    def reference(self, speaker, seconds=6.0, pieces=None):
        """(audio 24 kHz mono, transcript, pieces used) for a speaker."""
        if pieces is None:
            all_pieces = sorted(self.voices.get(speaker, {}).get("pieces", []), key=lambda p: -p.get("score", 0))
            pieces, tot = [], 0.0
            for p in all_pieces:
                d = p["end"] - p["start"]
                if tot + d > seconds and pieces:
                    continue
                pieces.append([p["start"], p["end"]])
                tot += d
                if tot >= seconds * 0.8:
                    break
        pieces = sorted(pieces)
        audio = [self.slice("vocals", a, b).mean(axis=0) for a, b in pieces]
        text = " ".join(self.text_between(a, b) for a, b in pieces).strip()
        if not audio:
            return None, "", []
        return _resample(np.concatenate(audio), SR, 24000), text, pieces


def _tone_match(word, target, sr, strength):
    """EQ the word towards the original swear's average spectrum (smoothed,
    limited to ±12 dB), so it sits in the same "colour" of voice."""
    import librosa

    if len(target) < 2048 or len(word) < 2048:
        return word
    n_fft = 2048
    W = np.abs(librosa.stft(word, n_fft=n_fft)).mean(axis=1) + 1e-6
    T = np.abs(librosa.stft(target, n_fft=n_fft)).mean(axis=1) + 1e-6
    ratio_db = 20 * np.log10(T / W)
    k = 24  # smooth across ~0.6 kHz so it shapes tone, not detail
    ratio_db = np.convolve(ratio_db, np.ones(k) / k, mode="same")
    ratio_db = np.clip(ratio_db, -12, 12) * strength
    S = librosa.stft(word, n_fft=n_fft)
    S *= (10 ** (ratio_db / 20))[:, None]
    return librosa.istft(S, length=len(word)).astype(np.float32)


class Editor:
    def __init__(self):
        self.cloner = None
        self.prompts = {}  # (project dir, speaker, pieces) -> prompt

    def _cloner(self):
        if self.cloner is None:
            from voice_clone import OmniVoiceCloner

            self.cloner = OmniVoiceCloner()
        return self.cloner

    def render(self, project, index, settings, context=2.0):
        """Returns dict with 'context' (mix with the substitute in place,
        [2, n] 48 kHz), 'original' (same stretch untouched), 'word' (the
        substitute alone) and info about what was done."""
        import voice_clone as V

        s = {**DEFAULTS, **(settings or {})}
        sw = project.swears[index]
        start, end, room_end, spk = sw["start"], sw["end"], sw["roomEnd"], sw["speaker"]
        say = (s["say"] or sw["say"]).strip()
        info = {"say": say, "speaker": spk}
        c0, c1 = max(0.0, start - context), room_end + context
        original = project.slice("mix", c0, c1)
        out = original.copy()
        # The swear (plus the pause the word may use) is replaced by the background.
        use = s["room_use"] if s["timing_on"] else 1.0
        avail = max(end - start, (room_end - start) * use + (end - start) * (1 - use))
        g0, g1 = int((start - c0 - 0.06) * SR), int((start - c0 + max(avail, end - start) + 0.1) * SR)
        g0, g1 = max(0, g0), min(out.shape[1], g1)
        bg = project.slice("background", c0, c1)
        fade = int(0.008 * SR)
        env = np.ones(out.shape[1], np.float32)
        env[g0:g1] = 0
        env[max(0, g0 - fade):g0] = np.linspace(1, 0, g0 - max(0, g0 - fade))
        env[g1:g1 + fade] = np.linspace(0, 1, min(fade, out.shape[1] - g1))
        out = out * env[None, :] + bg[:, : out.shape[1]] * (1 - env)[None, :]

        word = np.zeros(0, np.float32)
        if spk is None:
            info["why"] = "speaker unknown: background only"
        else:
            ref, text, pieces = project.reference(spk, s["ref_seconds"] if s["ref_on"] else 6.0, s["ref_pieces"] if s["ref_on"] else None)
            if ref is None or not text:
                info["why"] = "no voice sample for this speaker"
            else:
                key = (str(project.dir), spk, tuple(map(tuple, pieces)))
                if key not in self.prompts:
                    self.prompts[key] = self._cloner().prompt(ref, 24000, text)
                info["reference"] = {"pieces": pieces, "seconds": round(sum(b - a for a, b in pieces), 2), "text": text}
                natural = V.estimate_seconds(say)
                target = min(avail, natural * (s["length"] if s["timing_on"] else 1.0))
                target = max(target, 0.25)
                old = V.NUM_STEP
                steps = int(s["steps"]) if s["quality_on"] else 12
                V.NUM_STEP = steps
                try:
                    word, sr = self._cloner().say(say, self.prompts[key], duration=target)
                finally:
                    V.NUM_STEP = old
                word = _resample(word, sr, SR)
                orig_voice = project.slice("vocals", start, end).mean(axis=0)
                if s["pitch_on"] and abs(s["pitch"]) > 0.01:
                    import librosa

                    word = librosa.effects.pitch_shift(word, sr=SR, n_steps=float(s["pitch"])).astype(np.float32)
                if s["tone_on"]:
                    word = _tone_match(word, orig_voice, SR, float(s["tone"]))
                if s["loud_on"]:
                    rms = float(np.sqrt(np.mean(orig_voice ** 2))) or 0.05
                    word *= rms / (float(np.sqrt(np.mean(word ** 2))) + 1e-9) * 10 ** (float(s["loud_db"]) / 20)
                f = min(len(word) // 4, int(0.01 * SR))
                if f:
                    word[:f] *= np.linspace(0, 1, f)
                    word[-f:] *= np.linspace(1, 0, f)
                a = int((start - c0) * SR)
                b = min(out.shape[1], a + len(word))
                out[:, a:b] += word[None, : b - a]
                info.update(seconds=round(len(word) / SR, 2), target=round(target, 2), steps=steps)
        return {"context": np.clip(out, -1, 1), "original": original, "word": word, "info": info, "start": c0}
