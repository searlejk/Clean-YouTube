"""A clean voice sample for each speaker (roadmap step 9), for voice cloning.

From what the companion already has for a video — the separated voice and
background (step 4), where speech is (VAD), who is speaking with a
confidence (step 8) and the transcribed words — picks, per speaker, the
best stretches of clean, swear-free speech until it has 30 s (10 s is enough
to be "ready"), and saves them as one WAV per speaker.

A stretch is used only if (step 9.2):
  - one speaker, confidently: every fingerprint in it is that person, by a
    clear margin, and no one else speaks within half a second of it;
  - it's speech (inside the voice detector's stretches), trimmed away from
    turn changes;
  - it contains no word from the word list;
  - it isn't clipped or very quiet, and the music under it is well below the
    voice (loud music leaves traces in the separated voice).

    vc = VoiceCollector()
    vc.update(store, stream, words, word_list)    # words: [{text,start,end,speaker}]
    vc.status(stream)                             # {speaker: {"seconds", "ready"}}
    vc.save(store, stream, folder)                # speaker<N>.wav + voices.json
"""

import fnmatch
import json
import re
import wave
from pathlib import Path

import numpy as np

TARGET_S = 30.0  # sample length to aim for per speaker
READY_S = 6.0  # enough to clone from (OmniVoice needs 3–10 s)
MIN_PIECE_S = 1.0
EDGE_TRIM_S = 0.25  # stay this far inside a speaker's run (turn changes)
OTHER_SPEAKER_GAP_S = 0.5
MIN_MARGIN = 0.1  # fingerprint must match its speaker this much better than anyone else
MAX_MUSIC_RATIO = 0.5  # background level / voice level (about -6 dB)
MIN_VOICE_RMS = 0.01
CLIP = 0.99
SWEAR_PAD_S = 0.3
GAP_S = 0.15  # silence between pieces in the saved WAV
VOICES = Path.home() / "Library" / "Application Support" / "CleanEars" / "voices"


def _norm(t):
    return re.sub(r"[^a-z0-9*']", "", t.lower())


def _swears(words, word_list):
    """Time spans of words matching the word list (single words; phrases by
    their words)."""
    pats = []
    for p in word_list or []:
        for part in str(p).lower().split():
            core = re.sub(r"[^a-z0-9*']", "", part)
            if core.strip("*"):
                pats.append(core)
    out = []
    for w in words:
        t = _norm(w["text"])
        if t and ("*" in t or any(fnmatch.fnmatchcase(t, p) for p in pats)):
            out.append((w["start"] - SWEAR_PAD_S, w["end"] + SWEAR_PAD_S))
    return out


def _subtract(spans, cuts):
    out = []
    for a, b in spans:
        pieces = [(a, b)]
        for c0, c1 in cuts:
            nxt = []
            for x, y in pieces:
                if c1 <= x or c0 >= y:
                    nxt.append((x, y))
                else:
                    if c0 > x:
                        nxt.append((x, c0))
                    if c1 < y:
                        nxt.append((c1, y))
            pieces = nxt
        out += pieces
    return out


def _intersect(spans, others):
    out = []
    for a, b in spans:
        for c, d in others:
            x, y = max(a, c), min(b, d)
            if y > x:
                out.append((x, y))
    return out


class VoiceCollector:
    def __init__(self):
        self.samples = {}  # stream -> {speaker: [piece dicts]}

    def candidates(self, store, stream, words, word_list):
        st = store.streams.get(stream)
        diar = st.get("diar") if st else None
        if diar is None:
            return []
        labels = diar.speakers()  # (center, start, end, speaker, margin)
        if not labels:
            return []
        labels.sort(key=lambda l: l[0])
        speech = store.speech(stream)
        swears = _swears(words, word_list)
        # Runs of consecutive confident fingerprints from one speaker.
        runs, cur = [], None
        for c, s, e, spk, m in labels:
            good = m >= MIN_MARGIN
            if cur and good and spk == cur["spk"] and s <= cur["end"] + 0.05:
                cur["end"] = max(cur["end"], e)
                cur["margins"].append(m)
            else:
                if cur:
                    runs.append(cur)
                cur = {"spk": spk, "start": s, "end": e, "margins": [m]} if good else None
        if cur:
            runs.append(cur)
        # Where anyone else is talking (any confidence), to keep clear of.
        other = {}
        for c, s, e, spk, m in labels:
            other.setdefault(spk, []).append((s, e))
        out = []
        for r in runs:
            a, b = r["start"] + EDGE_TRIM_S, r["end"] - EDGE_TRIM_S
            if b - a < MIN_PIECE_S:
                continue
            spans = _intersect([(a, b)], [tuple(x) for x in speech]) if speech else [(a, b)]
            near = [(s - OTHER_SPEAKER_GAP_S, e + OTHER_SPEAKER_GAP_S) for k, v in other.items() if k != r["spk"] for s, e in v]
            spans = _subtract(spans, near + swears)
            for x, y in spans:
                if y - x >= MIN_PIECE_S:
                    out.append({"speaker": r["spk"], "start": round(x, 3), "end": round(y, 3), "margin": float(np.mean(r["margins"]))})
        return out

    def check(self, store, stream, piece):
        """Quality numbers for a piece, or None if its stems aren't ready."""
        got = store.get(stream, piece["start"], piece["end"])
        if got is None:
            return None
        voc, bg = got[0].mean(axis=0), got[1].mean(axis=0)
        v = float(np.sqrt(np.mean(voc ** 2)))
        b = float(np.sqrt(np.mean(bg ** 2)))
        peak = float(np.abs(voc).max())
        q = {"voice_rms": round(v, 4), "music_ratio": round(b / (v + 1e-9), 3), "peak": round(peak, 3)}
        q["ok"] = v >= MIN_VOICE_RMS and peak < CLIP and q["music_ratio"] <= MAX_MUSIC_RATIO
        return q

    def update(self, store, stream, words, word_list):
        """Re-pick the best clean pieces per speaker from what's known now."""
        chosen = {}
        for p in self.candidates(store, stream, words, word_list):
            q = self.check(store, stream, p)
            if q is None or not q["ok"]:
                continue
            p.update(q)
            p["score"] = p["margin"] * (1 - min(1.0, p["music_ratio"]))
            chosen.setdefault(p["speaker"], []).append(p)
        best = {}
        for spk, pieces in chosen.items():
            pieces.sort(key=lambda p: -p["score"])
            keep, total = [], 0.0
            for p in pieces:
                if total >= TARGET_S:
                    break
                keep.append(p)
                total += p["end"] - p["start"]
            best[spk] = sorted(keep, key=lambda p: p["start"])
        self.samples[stream] = best
        return best

    def status(self, stream):
        out = {}
        for spk, pieces in self.samples.get(stream, {}).items():
            secs = float(sum(p["end"] - p["start"] for p in pieces))
            out[int(spk)] = {"seconds": round(secs, 1), "ready": bool(secs >= READY_S)}
        return out

    def save(self, store, stream, folder):
        """Write speaker<N>.wav (48 kHz mono, pieces joined by short gaps) and
        voices.json (which stretches were used and their quality)."""
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        meta = {}
        for spk, pieces in self.samples.get(stream, {}).items():
            audio, used = [], []
            rate = 48000
            for p in pieces:
                got = store.get(stream, p["start"], p["end"])
                if got is None:
                    continue
                audio += [got[0].mean(axis=0), np.zeros(int(GAP_S * rate), np.float32)]
                used.append(p)
            if not audio:
                continue
            x = np.concatenate(audio)
            x = x / max(1.0, float(np.abs(x).max()) / 0.95)
            with wave.open(str(folder / f"speaker{spk}.wav"), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(rate)
                w.writeframes((x * 32767).astype("<i2").tobytes())
            meta[int(spk)] = {"seconds": round(sum(p["end"] - p["start"] for p in used), 1), "pieces": used}
        (folder / "voices.json").write_text(json.dumps(meta, indent=1))
        return meta
