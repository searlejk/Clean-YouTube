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
  speed               how fast the made word is played (1 = as the model said
                      it; >1 faster), pitch kept: the word is made once at its
                      natural pace and stretched, so it's never cut
  engine              "omni": the word as OmniVoice makes it; "index": OmniVoice
                      says the whole sentence (with the substitute), then
                      IndexTTS2 says it again in that voice but with the
                      emotion of the original sentence, and the substitute is
                      cut out of that (forced alignment)
  emo_alpha           how strongly IndexTTS2 copies the original's emotion (0–1)
  place               where the substitute starts (seconds in the video; None:
                      at the swear, or as `take` says). Set by dragging it.
  span                [start, end] of the words replaced, when a rule swaps more
                      than the swear ("the fuck's" -> "is"; substitutes/fit.js)
  allowed, take       seconds the substitute gets (None: as long as it needs
                      at that speed). Time beyond the swear is taken from the
                      words around it: "after", "before" or "both"; whatever it
                      overlaps is covered by the background. The word is never
                      cut: if it can't fit at that speed it's said faster.
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
    "speed": 1.0, "allowed": None, "take": "after", "place": None,
    "engine": "omni", "emo_alpha": 0.6, "span": None,
}


def plan(swear, natural, speed=1.0, allowed=None, take="after", place=None):
    """Where the substitute goes. `natural`: the word's length at its natural
    pace (seconds; measured once it's made, estimated before). Returns
    (gap start, gap end, word seconds at this speed, overruns?). Same rules
    as the editor page's timeline (companion/editor/index.html planGap).
    The word is never cut: if it's longer than the time given it runs on
    (and covers what's there), which the page shows."""
    start, end = swear["start"], swear["end"]
    swear_len = end - start
    word = natural / max(0.3, float(speed or 1))
    allow = max(0.15, float(allowed)) if allowed else max(swear_len, word)
    extra = allow - swear_len
    if place is not None:
        g0, g1 = float(place), float(place) + allow
    elif extra <= 0:
        g0, g1 = start, start + allow
    elif take == "before":
        g0, g1 = end - allow, end
    elif take == "both":
        g0, g1 = start - extra / 2, end + extra / 2
    else:
        g0, g1 = start, start + allow
    g0 = max(0.0, g0)
    return g0, g1, word, word > (g1 - g0) + 0.02


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


class IndexTTSWorker:
    """companion/index_tts_worker.py running in .venv-indextts (started on
    first use, ~30 s to load, then kept)."""

    def __init__(self):
        self.proc = None

    def ready(self):
        import subprocess

        if self.proc and self.proc.poll() is None:
            return
        here = Path(__file__).resolve().parent
        py = here / ".venv-indextts" / "bin" / "python"
        if not py.exists():
            raise RuntimeError("IndexTTS2 isn't installed (companion/.venv-indextts missing)")
        log = open("/tmp/index_tts_worker.log", "a")
        self.proc = subprocess.Popen([str(py), str(here / "index_tts_worker.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
        hello = self._read()
        if not hello.get("ready"):
            raise RuntimeError("IndexTTS2 didn't start: " + str(hello))

    def _read(self):
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("IndexTTS2 stopped (see /tmp/index_tts_worker.log)")
            if line.startswith("{"):
                return json.loads(line)

    def say(self, spk, emo, text, out, emo_alpha):
        self.ready()
        self.proc.stdin.write(json.dumps({"spk": str(spk), "emo": str(emo), "text": text, "out": str(out), "emo_alpha": emo_alpha}) + "\n")
        self.proc.stdin.flush()
        r = self._read()
        if not r.get("ok"):
            raise RuntimeError(r.get("error"))
        return r["seconds"]


def sentence_around(project, sw, max_side=2.0, max_pause=0.6):
    """The words the speaker says around the swear, in one breath: indices
    (first, swear first, swear last, last) into project.words."""
    W = project.words
    inside = [i for i, w in enumerate(W) if sw["start"] - 0.02 <= (w["start"] + w["end"]) / 2 <= sw["end"] + 0.02]
    if not inside:
        return None
    a, b = inside[0], inside[-1]
    spk = sw.get("speaker")
    same = lambda w: spk is None or w.get("speaker") in (None, spk)
    lo = a
    while lo > 0 and same(W[lo - 1]) and W[lo]["start"] - W[lo - 1]["end"] < max_pause and W[a]["start"] - W[lo - 1]["start"] <= max_side:
        lo -= 1
    hi = b
    while hi + 1 < len(W) and same(W[hi + 1]) and W[hi + 1]["start"] - W[hi]["end"] < max_pause and W[hi + 1]["end"] - W[b]["end"] <= max_side:
        hi += 1
    return lo, a, b, hi


class Editor:
    def __init__(self):
        self.cloner = None
        self.prompts = {}  # (project dir, speaker, pieces) -> prompt
        self.words = {}  # (prompt key, text, steps) -> word at natural pace, 48 kHz
        self.styled = {}  # (prompt key, sentence, steps, emo_alpha) -> (word, sentence audio, info)
        self.index = IndexTTSWorker()
        self.aligner = None

    def _cloner(self):
        if self.cloner is None:
            from voice_clone import OmniVoiceCloner

            self.cloner = OmniVoiceCloner()
        return self.cloner

    def natural_word(self, project, spk, s, say):
        """The substitute in the speaker's voice at its natural pace (made
        once per word/voice/quality and kept), or (None, why)."""
        ref, text, pieces = project.reference(spk, s["ref_seconds"] if s["ref_on"] else 6.0, s["ref_pieces"] if s["ref_on"] else None)
        if ref is None or not text:
            return None, "no voice sample for this speaker", None
        key = (str(project.dir), spk, tuple(map(tuple, pieces)))
        if key not in self.prompts:
            self.prompts[key] = self._cloner().prompt(ref, 24000, text)
        steps = int(s["steps"]) if s["quality_on"] else 12
        wkey = (key, say.lower(), steps)
        made = False
        if wkey not in self.words:
            import voice_clone as V

            old = V.NUM_STEP
            V.NUM_STEP = steps
            try:
                # Its natural pace ≈ the syllable estimate. Left to choose its own
                # length, OmniVoice pads short words with extra speech ("is" ->
                # "it is", "really" -> words from the reference); a full stop
                # helps it end cleanly.
                text = say if say[-1:] in ".!?" else say + "."
                word, sr = self._cloner().say(text, self.prompts[key], duration=V.estimate_seconds(say))
            finally:
                V.NUM_STEP = old
            self.words[wkey] = _resample(word, sr, SR)
            made = True
        ref_info = {"pieces": pieces, "seconds": round(sum(b - a for a, b in pieces), 2), "text": text}
        return self.words[wkey], {"steps": steps, "made": made, "reference": ref_info}, key

    def styled_word(self, project, spk, sw, s, say):
        """The substitute restyled by IndexTTS2: OmniVoice says the whole
        sentence with the substitute in it (that's the voice), IndexTTS2 says
        the sentence again in that voice with the emotion of the original
        sentence, and the substitute is cut out of it by forced alignment.
        Returns (word 48 kHz, info, sentence 48 kHz) or (None, why, None)."""
        import hashlib
        import re
        import voice_clone as V

        span = sentence_around(project, sw)
        if span is None:
            return None, "couldn't find the sentence around the swear", None
        lo, a, b, hi = span
        W = project.words
        before = " ".join(w["text"] for w in W[lo:a]).strip()
        after = " ".join(w["text"] for w in W[b + 1:hi + 1]).strip()
        text = " ".join(x for x in (before, say, after) if x)
        text = re.sub(r"\s+", " ", text)
        ref, rtext, pieces = project.reference(spk, s["ref_seconds"] if s["ref_on"] else 6.0, s["ref_pieces"] if s["ref_on"] else None)
        if ref is None or not rtext:
            return None, "no voice sample for this speaker", None
        key = (str(project.dir), spk, tuple(map(tuple, pieces)))
        if key not in self.prompts:
            self.prompts[key] = self._cloner().prompt(ref, 24000, rtext)
        steps = int(s["steps"]) if s["quality_on"] else 12
        alpha = round(float(s["emo_alpha"]), 2)
        skey = (key, text.lower(), steps, alpha)
        if skey in self.styled:
            word, sent, info = self.styled[skey]
            return word, dict(info, made=False), sent
        cache = project.dir / "cache"
        cache.mkdir(exist_ok=True)
        h = hashlib.sha1(repr(skey).encode()).hexdigest()[:12]
        # 1. OmniVoice: the sentence in their voice (the voice IndexTTS2 copies).
        old = V.NUM_STEP
        V.NUM_STEP = steps
        try:
            omni, osr = self._cloner().say(text, self.prompts[key], duration=None)
        finally:
            V.NUM_STEP = old
        spk_path = cache / f"omni-{h}.wav"
        soundfile.write(spk_path, omni, osr)
        # 2. The original sentence (separated voice) for its emotion.
        t0, t1 = W[lo]["start"], W[hi]["end"]
        emo_path = cache / f"emo-{hashlib.sha1(f'{t0:.3f}-{t1:.3f}'.encode()).hexdigest()[:12]}.wav"
        if not emo_path.exists():
            soundfile.write(emo_path, project.slice("vocals", t0, t1).mean(axis=0), SR)
        # 3. IndexTTS2: same words, OmniVoice's voice, the original's emotion.
        out_path = cache / f"index-{h}.wav"
        took = self.index.say(spk_path, emo_path, text, out_path, alpha)
        sent, isr = soundfile.read(out_path, dtype="float32", always_2d=True)
        sent = sent.mean(axis=1)
        # 4. Find the substitute in it.
        if self.aligner is None:
            from align import Aligner

            self.aligner = Aligner()
        toks = [t for t in text.split(" ") if t]
        nb = len([t for t in before.split(" ") if t])
        ns = len([t for t in say.split(" ") if t])
        s16 = _resample(sent, isr, 16000)
        al = self.aligner.align(s16, 0.0, [{"text": t, "start": 0, "end": 0} for t in toks])
        part = al[nb:nb + ns]
        sent48 = _resample(sent, isr, SR)
        if not part or not all(w["aligned"] for w in part):
            return None, "couldn't find the substitute in IndexTTS2's sentence", sent48
        w0 = max(0.0, part[0]["start"] - 0.02)
        w1 = part[-1]["end"] + 0.03
        nxt = al[nb + ns]["start"] if nb + ns < len(al) and al[nb + ns]["aligned"] else None
        if nxt is not None:
            w1 = min(w1, max(part[-1]["end"], nxt - 0.01))
        word = sent48[int(w0 * SR):int(w1 * SR)].copy()
        ref_info = {"pieces": pieces, "seconds": round(sum(q - p for p, q in pieces), 2), "text": rtext}
        info = {"steps": steps, "made": True, "reference": ref_info, "sentence": text, "index_seconds": took,
                "cut": [round(w0, 3), round(w1, 3)], "emo_from": [round(t0, 3), round(t1, 3)]}
        self.styled[skey] = (word, sent48, info)
        return word, info, sent48

    def render(self, project, index, settings, context=2.0):
        """Returns dict with 'context' (mix with the substitute in place,
        [2, n] 48 kHz), 'original' (same stretch untouched), 'word' (the
        substitute alone) and info about what was done. Speed, timing,
        pitch, tone and loudness are applied to the kept natural-pace word,
        so changing them doesn't remake it."""
        import voice_clone as V

        s = {**DEFAULTS, **(settings or {})}
        sw = project.swears[index]
        if s["span"]:  # the auto-fit replaces more than the swear's own words
            a, b = float(s["span"][0]), float(s["span"][1])
            sw = {**sw, "start": a, "end": b, "roomEnd": max(sw["roomEnd"], b)}
        start, end, room_end, spk = sw["start"], sw["end"], sw["roomEnd"], sw["speaker"]
        say = (s["say"] or sw["say"]).strip()
        info = {"say": say, "speaker": spk}
        raw, sentence = None, None
        info["engine"] = s["engine"]
        if spk is None:
            info["why"] = "speaker unknown: background only"
        elif s["engine"] == "index":
            raw, extra, sentence = self.styled_word(project, spk, sw, s, say)
            if raw is None:
                info["why"] = extra
            else:
                info.update(extra)
        else:
            raw, extra, _ = self.natural_word(project, spk, s, say)
            if raw is None:
                info["why"] = extra
            else:
                info.update(extra)
        natural = len(raw) / SR if raw is not None else V.estimate_seconds(say)
        speed = float(s["speed"] or 1)
        gs, ge, word_len, overrun = plan(sw, natural, speed, s["allowed"], s["take"], s["place"])
        we = gs + word_len
        info.update(gap=[round(gs, 3), round(ge, 3)], natural=round(natural, 3), word=round(word_len, 3), overrun=overrun)
        cover0, cover1 = min(gs, start), max(ge, end, we if raw is not None else ge)
        c0, c1 = max(0.0, cover0 - context), max(cover1, room_end) + context
        original = project.slice("mix", c0, c1)
        out = original.copy()
        # The swear and the time the substitute uses are replaced by the background.
        g0 = max(0, int((cover0 - c0 - 0.03) * SR))
        g1 = min(out.shape[1], int((cover1 - c0 + 0.05) * SR))
        bg = project.slice("background", c0, c1)
        fade = int(0.008 * SR)
        env = np.ones(out.shape[1], np.float32)
        env[g0:g1] = 0
        env[max(0, g0 - fade):g0] = np.linspace(1, 0, g0 - max(0, g0 - fade))
        env[g1:g1 + fade] = np.linspace(0, 1, min(fade, out.shape[1] - g1))
        out = out * env[None, :] + bg[:, : out.shape[1]] * (1 - env)[None, :]

        word = np.zeros(0, np.float32)
        if raw is not None:
            import librosa

            word = raw.copy()
            if abs(speed - 1) > 0.01:  # faster/slower, same pitch
                word = librosa.effects.time_stretch(word, rate=speed).astype(np.float32)
            orig_voice = project.slice("vocals", start, end).mean(axis=0)
            if s["pitch_on"] and abs(s["pitch"]) > 0.01:
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
            a = int((gs - c0) * SR)
            b = min(out.shape[1], a + len(word))
            out[:, a:b] += word[None, : b - a]
            info["seconds"] = round(len(word) / SR, 3)
        return {"context": np.clip(out, -1, 1), "original": original, "word": word, "sentence": sentence, "info": info, "start": c0}
