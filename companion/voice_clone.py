"""Replacement words in a speaker's own voice (roadmap step 10): OmniVoice.

OmniVoice (k2-fsa, Apache-2.0; ~3.3 GB, downloaded to the Hugging Face cache
on first use) is a zero-shot text-to-speech model: from 3–10 s of someone's
voice plus what they said in it, it speaks new text in that voice. It
replaced OpenVoice v2, whose results didn't sound like the speaker.

    oc = OmniVoiceCloner()
    prompt = oc.prompt(audio, sr, "what they said in it")   # once per speaker
    audio, sr = oc.say("holy guacamole", prompt, duration=0.8)
"""

import re
import time

import numpy as np

MODEL = "k2-fsa/OmniVoice"
NUM_STEP = 12  # decoding steps (default 32): ~3 s per phrase on the M4 GPU with a 6 s reference


def estimate_seconds(text):
    """Natural length of a short phrase: ~0.2 s per syllable."""
    words = re.findall(r"[a-z']+", text.lower())
    syll = sum(max(1, len(re.findall(r"[aeiouy]+", w))) for w in words)
    return 0.12 + 0.2 * syll


def trim_silence(x, sr, level=0.02):
    """Drop quiet padding at both ends (OmniVoice adds ~0.1 s each side)."""
    if not len(x):
        return x
    env = np.abs(x)
    thr = level * float(env.max() or 1)
    nz = np.where(env > thr)[0]
    if not len(nz):
        return x
    a, b = max(0, nz[0] - int(0.01 * sr)), min(len(x), nz[-1] + int(0.02 * sr))
    return x[a:b]


class OmniVoiceCloner:
    def __init__(self, device=None):
        import torch
        from omnivoice import OmniVoice

        self.torch = torch
        device = device or ("mps" if torch.backends.mps.is_available() else "cpu")
        dtype = torch.float16 if device != "cpu" else torch.float32
        self.model = OmniVoice.from_pretrained(MODEL, device_map=device, dtype=dtype)
        self.sr = self.model.sampling_rate  # 24 kHz
        self.device = device

    def prompt(self, audio, sr, text):
        """Reusable voice prompt from a clean sample and its transcript. The
        transcript is required: without it OmniVoice would download and run
        its own large Whisper model."""
        if not (text or "").strip():
            raise ValueError("a transcript of the reference audio is needed")
        wav = self.torch.from_numpy(np.asarray(audio, np.float32))[None, :]
        return self.model.create_voice_clone_prompt(ref_audio=(wav, sr), ref_text=text)

    def say(self, text, prompt, duration=None):
        """`text` in the prompt's voice, about `duration` seconds long."""
        with self.torch.no_grad():
            out = self.model.generate(text=text, voice_clone_prompt=prompt, duration=duration, num_step=NUM_STEP)
        return trim_silence(np.asarray(out[0], np.float32), self.sr), self.sr

    def timed_say(self, text, prompt, duration=None):
        t = time.perf_counter()
        audio, sr = self.say(text, prompt, duration)
        return audio, sr, time.perf_counter() - t
