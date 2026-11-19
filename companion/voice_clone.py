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


def trim_silence(x, sr, level=0.08, max_gap=0.15):
    """Keep just the spoken word: the stretch of sound around the loudest
    part, joining pieces less than `max_gap` apart, and dropping padding and
    stray breaths/clicks separated from it by a pause."""
    if not len(x):
        return x
    hop = max(1, int(0.01 * sr))
    n = len(x) // hop
    if n < 3:
        return x
    env = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
    active = env > level * float(env.max() or 1)
    peak = int(np.argmax(env))
    gap = int(max_gap / 0.01)
    a = b = peak
    while True:  # grow left over short gaps
        nxt = next((k for k in range(a - 1, max(-1, a - 1 - gap), -1) if active[k]), None)
        if nxt is None:
            break
        a = nxt
    while True:  # grow right
        nxt = next((k for k in range(b + 1, min(n, b + 1 + gap)) if active[k]), None)
        if nxt is None:
            break
        b = nxt
    s0 = max(0, a * hop - int(0.015 * sr))
    s1 = min(len(x), (b + 1) * hop + int(0.03 * sr))
    return x[s0:s1]


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
