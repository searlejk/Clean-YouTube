"""Replacement patches for swears (rough first pass at roadmap 11–12).

For a swear the extension is about to mute, builds the audio to play in the
gap instead of silence: the separated background (music, effects) for that
stretch, plus a clean replacement word ("shoot") in the speaker's own voice,
stretched to the swear's length and matched to its loudness. If the speaker
has no ready voice sample, or isn't known, the patch is the background only:
the voice goes quiet but the music keeps playing (step 12.2), never a guess
at the wrong voice (12.4).

    r = Replacer(store, voices)
    patch = r.build(stream, t0, t1, word_start, word_end, speaker, swear_text)
    # -> {"start", "rate", "audio" [2, n], "replaced": bool, "replacement", "why"}
"""

import re
import tempfile
import time
from pathlib import Path

import numpy as np

FADE_S = 0.008  # matches the extension's mute fades
MAX_STRETCH = 1.8  # speed a word up or slow it down at most this much
REPLACEMENTS = [  # word-list pattern (lowercase, * wildcard) -> clean word
    ("son of a bitch", "son of a gun"), ("motherfuck*", "mother trucker"), ("*fuck*", "fudge"), ("bullshit*", "bull"),
    ("horseshit*", "nonsense"), ("shit*", "shoot"), ("goddamn*", "gosh darn"), ("goddam*", "gosh darn"), ("damn*", "dang"),
    ("bitch*", "witch"), ("asshole*", "jerk"), ("jackass*", "jerk"), ("dumbass*", "dummy"), ("ass", "butt"), ("asses", "butts"),
    ("bastard*", "rascal"), ("dick*", "jerk"), ("cock*", "jerk"), ("piss*", "miffed"), ("crap*", "crud"), ("hell", "heck"),
    ("whore*", "jerk"), ("slut*", "jerk"), ("prick*", "jerk"), ("twat*", "jerk"), ("wanker*", "jerk"), ("cunt*", "jerk"),
]


def replacement_for(text):
    import fnmatch

    t = re.sub(r"[^a-z ']", "", text.lower()).strip()
    for pat, rep in REPLACEMENTS:
        if " " in pat:
            if pat in t:
                return rep
        elif any(fnmatch.fnmatchcase(w, pat) for w in t.split()):
            return rep
    return "shoot"


def _resample(x, sr_in, sr_out):
    import librosa

    return librosa.resample(np.asarray(x, np.float32), orig_sr=sr_in, target_sr=sr_out) if sr_in != sr_out else np.asarray(x, np.float32)


def fit_to(word, sr, seconds):
    """Stretch/compress a word to `seconds` keeping its pitch (phase
    vocoder, step 11.1), within MAX_STRETCH; then trim/pad to exact length."""
    import librosa

    n = max(1, int(round(seconds * sr)))
    ratio = len(word) / n  # > 1: needs to be faster
    ratio = min(MAX_STRETCH, max(1 / MAX_STRETCH, ratio))
    y = librosa.effects.time_stretch(word, rate=ratio) if abs(ratio - 1) > 0.03 else word
    if len(y) >= n:
        y = y[:n]
    else:
        y = np.pad(y, (0, n - len(y)))
    f = min(len(y) // 4, int(0.01 * sr))
    if f:
        y[:f] *= np.linspace(0, 1, f)
        y[-f:] *= np.linspace(1, 0, f)
    return y.astype(np.float32)


class Replacer:
    def __init__(self, store, voices):
        self.store = store
        self.voices = voices
        self.cloner = None
        self.se = {}  # (stream, speaker) -> (seconds of sample used, embedding, base)
        self._tmp = Path(tempfile.mkdtemp())

    def _cloner(self):
        if self.cloner is None:
            from voice_clone import OpenVoiceCloner

            self.cloner = OpenVoiceCloner()
        return self.cloner

    def _speaker_voice(self, stream, speaker):
        """(embedding, base) for a speaker with a ready sample, else None."""
        from voices import READY_S

        pieces = self.voices.samples.get(stream, {}).get(speaker)
        if not pieces:
            return None
        secs = sum(p["end"] - p["start"] for p in pieces)
        if secs < READY_S:
            return None
        cached = self.se.get((stream, speaker))
        if cached and secs - cached[0] < 5:
            return cached[1], cached[2]
        audio = []
        for p in pieces:
            got = self.store.get(stream, p["start"], p["end"])
            if got is not None:
                audio.append(got[0].mean(axis=0))
        if not audio:
            return None
        import soundfile

        path = self._tmp / f"spk{speaker}.wav"
        soundfile.write(str(path), np.concatenate(audio), 48000)
        c = self._cloner()
        se, base = c.speaker_embedding(path), c.base_for(path)
        self.se[(stream, speaker)] = (secs, se, base)
        return se, base

    def build(self, stream, t0, t1, word_start, word_end, speaker, swear_text):
        clip = self.store.clip(stream, t0, t1)
        if clip is None:
            return None
        start, rate, vocals, background = clip
        out = background.copy()
        result = {"start": start, "rate": rate, "replaced": False, "replacement": None, "why": ""}
        voice = self._speaker_voice(stream, speaker) if speaker is not None else None
        if voice is None:
            result["why"] = "no voice sample for this speaker yet" if speaker is not None else "speaker unknown"
        else:
            se, base = voice
            rep = replacement_for(swear_text)
            t = time.perf_counter()
            word, sr = self._cloner().word(rep, se, base)
            word = _resample(word, sr, rate)
            a = max(0, int(round((word_start - start) * rate)))
            b = min(out.shape[1], int(round((word_end - start) * rate)))
            if b - a > int(0.05 * rate):
                w = fit_to(word, rate, (b - a) / rate)
                # Loudness of the voice that's being replaced (step 11.2).
                target = float(np.sqrt(np.mean(vocals[:, a:b] ** 2))) or 0.05
                w *= target / (float(np.sqrt(np.mean(w ** 2))) + 1e-9)
                out[:, a:b] += w[None, :]
                result.update(replaced=True, replacement=rep, why=f"{time.perf_counter() - t:.2f} s to make")
            else:
                result["why"] = "swear too short to place a word"
        # Fades at both ends to cross over with the extension's mute fades.
        f = min(out.shape[1] // 4, int(FADE_S * rate))
        if f:
            out[:, :f] *= np.linspace(0, 1, f)[None, :]
            out[:, -f:] *= np.linspace(1, 0, f)[None, :]
        result["audio"] = np.clip(out, -1, 1)
        return result
