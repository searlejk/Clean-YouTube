"""Replacement words in a speaker's voice (roadmap step 10), first try:
OpenVoice v2's tone-colour converter.

OpenVoice doesn't speak by itself here: macOS `say` speaks the replacement
word ("shoot") in a stock voice — a woman's or a man's, picked from the
speaker's pitch — and OpenVoice's converter repaints that audio with the
speaker's vocal colour, taken from their clean voice sample (step 9).

    oc = OpenVoiceCloner()
    se = oc.speaker_embedding("speaker1.wav")          # once per speaker
    audio, sr = oc.word("shoot", se, base=oc.base_for("speaker1.wav"))

Needs PyTorch and librosa, the OpenVoice code in companion/vendor/OpenVoice
(MIT licence) and the v2 converter in companion/models/openvoice_v2.
"""

import subprocess
import sys
import tempfile
import time
import types
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
VENDOR = HERE / "vendor" / "OpenVoice"
CKPT = HERE / "models" / "openvoice_v2"

# Stock voices to convert from (macOS); a longer sentence gives each a
# stable "source colour" for the converter.
BASES = {"female": "Samantha", "male": "Reed (English (US))"}
BASE_SENTENCE = ("The quick brown fox jumps over the lazy dog. She sells sea shells by the sea shore. "
                 "How much wood would a woodchuck chuck if a woodchuck could chuck wood? I really do think so.")


def _import_converter():
    sys.path.insert(0, str(VENDOR))
    import openvoice  # noqa: F401  (package first, so the stub below sticks)

    # OpenVoice's text front-end (Chinese/English text for its old voices)
    # isn't used by the converter; skip its extra dependencies.
    stub = types.ModuleType("openvoice.text")
    stub.text_to_sequence = lambda *a, **k: []
    sys.modules["openvoice.text"] = stub
    from openvoice.api import OpenVoiceBaseClass, ToneColorConverter

    def make(config, device):
        # ToneColorConverter(..., enable_watermark=False) passes the option on
        # to a base class that rejects it, and without it insists on the
        # watermark package; build it directly with the watermark off.
        conv = ToneColorConverter.__new__(ToneColorConverter)
        OpenVoiceBaseClass.__init__(conv, config, device=device)
        conv.watermark_model = None
        conv.version = getattr(conv.hps, "_version_", "v1")
        return conv

    return make


def say(text, voice, sr):
    """Speak `text` with a macOS voice into a float32 array at `sr` (silence trimmed)."""
    with tempfile.TemporaryDirectory() as d:
        a = Path(d) / "s.aiff"
        subprocess.run(["say", "-v", voice, "-o", str(a), text], check=True)
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(a), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32)
    nz = np.where(np.abs(x) > 0.005)[0]
    return x[max(0, nz[0] - int(0.02 * sr)): nz[-1] + int(0.05 * sr)] if len(nz) else x


def median_pitch(path):
    import librosa

    y, sr = librosa.load(str(path), sr=16000, mono=True)
    f0 = librosa.yin(y, fmin=60, fmax=400, sr=sr, frame_length=1024)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=256)[0][: len(f0)]
    voiced = f0[(rms > np.percentile(rms, 60))[: len(f0)]]
    return float(np.median(voiced)) if len(voiced) else 150.0


class OpenVoiceCloner:
    def __init__(self, device="cpu"):
        import torch

        make = _import_converter()
        self.torch = torch
        self.device = device
        self.conv = make(str(CKPT / "config.json"), device)
        self.conv.load_ckpt(str(CKPT / "checkpoint.pth"))
        self.sr = self.conv.hps.data.sampling_rate  # 22050
        self._base_se = {}
        self._tmp = Path(tempfile.mkdtemp())

    def speaker_embedding(self, wav_path):
        """The speaker's vocal colour from their voice sample."""
        return self.conv.extract_se([str(wav_path)])

    def base_for(self, wav_path):
        return "female" if median_pitch(wav_path) >= 165 else "male"

    def base_embedding(self, base):
        if base not in self._base_se:
            p = self._tmp / f"base-{base}.wav"
            self._write(p, say(BASE_SENTENCE, BASES[base], self.sr))
            self._base_se[base] = self.speaker_embedding(p)
        return self._base_se[base]

    def _write(self, path, x):
        import soundfile

        soundfile.write(str(path), x, self.sr)

    def word(self, text, target_se, base="male", tau=0.3):
        """`text` spoken in the target voice. Returns (audio float32, sample rate)."""
        src = self._tmp / "word.wav"
        self._write(src, say(text, BASES[base], self.sr))
        with self.torch.no_grad():
            audio = self.conv.convert(audio_src_path=str(src), src_se=self.base_embedding(base), tgt_se=target_se, tau=tau)
        return np.asarray(audio, np.float32), self.sr

    def timed_word(self, text, target_se, base="male"):
        t0 = time.perf_counter()
        audio, sr = self.word(text, target_se, base)
        return audio, sr, time.perf_counter() - t0
