"""Replacement patches for swears (first pass at roadmap 11–12).

For a swear the extension is about to mute, builds the audio to play in the
gap instead of silence: the separated background (music, effects) for that
stretch, plus a funny stand-in ("poop", "holy guacamole" — chosen by the
extension from the word and its neighbours) said by OmniVoice in the
speaker's own voice, made to fit the swear plus the pause after it, and
matched to its loudness. If the speaker
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
    ("bastard*", "rascal"), ("dick*", "jerk"), ("cock*", "jerk"), ("piss*", "miffed"), ("hell", "heck"),
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
    REF_MAX_S = 6.0  # OmniVoice clones best from 3–10 s of reference

    def __init__(self, store, voices, words_for=lambda stream: [], transcribe=None):
        self.store = store
        self.voices = voices
        self.words_for = words_for
        self.transcribe = transcribe  # 16 kHz audio -> text (the companion's Whisper)
        self.cloner = None
        self.prompts = {}  # (stream, speaker) -> (seconds of sample used, prompt)

    def _cloner(self):
        if self.cloner is None:
            from voice_clone import OmniVoiceCloner

            self.cloner = OmniVoiceCloner()
        return self.cloner

    def _speaker_voice(self, stream, speaker):
        """OmniVoice prompt from the speaker's best clean pieces (up to 6 s)
        and what they said in them; None without a ready sample."""
        from voices import READY_S

        pieces = self.voices.samples.get(stream, {}).get(speaker)
        if not pieces:
            return None
        secs = sum(p["end"] - p["start"] for p in pieces)
        if secs < READY_S:
            return None
        cached = self.prompts.get((stream, speaker))
        if cached and secs - cached[0] < 5:
            return cached[1]
        best = sorted(pieces, key=lambda p: -p.get("score", 0))
        chosen, tot = [], 0.0
        for p in best:
            d = p["end"] - p["start"]
            if tot + d > self.REF_MAX_S and chosen:
                continue
            chosen.append(p)
            tot += d
            if tot >= self.REF_MAX_S * 0.8:
                break
        chosen.sort(key=lambda p: p["start"])
        words = self.words_for(stream)
        audio, text = [], []
        for p in chosen:
            got = self.store.get(stream, p["start"], p["end"])
            if got is None:
                continue
            audio.append(got[0].mean(axis=0))
            text += [w["text"].strip() for w in words if p["start"] <= (w["start"] + w["end"]) / 2 < p["end"]]
        if not audio:
            return None
        ref48 = np.concatenate(audio)
        text = " ".join(text).strip()
        if not text and self.transcribe is not None:
            # No transcript known for these stretches (e.g. the video's words
            # came from a saved transcript): transcribe the reference here.
            text = self.transcribe(_resample(ref48, 48000, 16000)).strip()
        if not text:
            return None
        ref = _resample(ref48, 48000, 24000)
        prompt = self._cloner().prompt(ref, 24000, text)
        self.prompts[(stream, speaker)] = (secs, prompt)
        return prompt

    def build(self, stream, t0, t1, word_start, word_end, speaker, say, room_end=None):
        from voice_clone import estimate_seconds

        clip = self.store.clip(stream, t0, t1)
        if clip is None:
            return None
        start, rate, vocals, background = clip
        out = background.copy()
        result = {"start": start, "rate": rate, "replaced": False, "replacement": None, "why": ""}
        prompt = self._speaker_voice(stream, speaker) if speaker is not None else None
        if prompt is None:
            result["why"] = "no voice sample for this speaker yet" if speaker is not None else "speaker unknown"
        else:
            say = say or "fiddlesticks"
            span = max(0.05, word_end - word_start)
            room = max(span, (room_end or word_end) - word_start)
            # Its natural length, at least most of the swear, never past the pause.
            target = min(room, max(estimate_seconds(say), 0.8 * span))
            t = time.perf_counter()
            word, sr = self._cloner().say(say, prompt, duration=target)
            word = _resample(word, sr, rate)
            a = max(0, int(round((word_start - start) * rate)))
            b = min(out.shape[1], a + int(round(room * rate)))
            w = word[: b - a]
            if len(w) > int(0.05 * rate):
                f = min(len(w) // 4, int(0.01 * rate))
                w = w.copy()
                w[:f] *= np.linspace(0, 1, f)
                w[-f:] *= np.linspace(1, 0, f)
                # Loudness of the voice that's being replaced (step 11.2).
                sa, sb = a, min(out.shape[1], a + int(round(span * rate)))
                target_rms = float(np.sqrt(np.mean(vocals[:, sa:sb] ** 2))) or 0.05
                w *= target_rms / (float(np.sqrt(np.mean(w ** 2))) + 1e-9)
                out[:, a : a + len(w)] += w[None, :]
                result.update(replaced=True, replacement=say, why=f"{time.perf_counter() - t:.2f} s to make")
            else:
                result["why"] = "no room to place the word"
        # Fades at both ends to cross over with the extension's mute fades.
        f = min(out.shape[1] // 4, int(FADE_S * rate))
        if f:
            out[:, :f] *= np.linspace(0, 1, f)[None, :]
            out[:, -f:] *= np.linspace(1, 0, f)[None, :]
        result["audio"] = np.clip(out, -1, 1)
        return result
