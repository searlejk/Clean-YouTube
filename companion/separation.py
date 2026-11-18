"""Vocal / background separation with UVR MDX-Net models (roadmap step 4).

Runs the ONNX models with onnxruntime and does the STFT in numpy, so no
PyTorch is needed. Mirrors UVR's MDX inference: 44.1 kHz stereo audio is cut
into overlapping ~5.9 s chunks, each chunk's spectrogram goes through the
model, and the predicted vocal spectrogram is turned back into audio.
The background is the mix minus the vocals.

    sep = Separator("Kim_Vocal_2")
    vocals, background = sep.separate(audio)   # audio: float32 [2, n] at 44.1 kHz
"""

from pathlib import Path

import numpy as np
import onnxruntime as ort

SR = 44100
MODELS_DIR = Path(__file__).parent / "models"
DOWNLOAD = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/{name}.onnx"

# Per-model settings from UVR's model data.
MODELS = {
    "Kim_Vocal_2": {"n_fft": 7680, "dim_f": 3072, "dim_t": 256, "compensate": 1.009},
    "UVR-MDX-NET-Voc_FT": {"n_fft": 7680, "dim_f": 3072, "dim_t": 256, "compensate": 1.021},
}
HOP = 1024


def _window(n):
    # Periodic Hann, as torch.hann_window(n) (the models were trained with it).
    return (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(n) / n)).astype(np.float32)


class Separator:
    def __init__(self, name="Kim_Vocal_2", providers=None, batch=1):
        cfg = MODELS[name]
        self.name = name
        self.n_fft = cfg["n_fft"]
        self.dim_f = cfg["dim_f"]
        self.dim_t = cfg["dim_t"]
        self.compensate = cfg["compensate"]
        self.n_bins = self.n_fft // 2 + 1
        self.chunk = HOP * (self.dim_t - 1)  # samples per model input
        self.trim = self.n_fft // 2  # edge samples discarded from each chunk
        self.gen = self.chunk - 2 * self.trim  # new samples produced per chunk
        self.win = _window(self.n_fft)
        self.batch = batch
        path = MODELS_DIR / f"{name}.onnx"
        if not path.exists():
            raise FileNotFoundError(f"{path} missing; download it from {DOWNLOAD.format(name=name)}")
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        # A fixed batch size lets CoreML take the whole graph in one piece
        # (with it left open, 27 of 173 steps fell back to the CPU: ~5x slower).
        opts.add_free_dimension_override_by_name("batch_size", batch)
        coreml = ("CoreMLExecutionProvider", {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL"})
        self.session = ort.InferenceSession(str(path), opts, providers=providers or [coreml, "CPUExecutionProvider"])
        self.provider = self.session.get_providers()[0]

    # ── STFT (center=True, reflect padding, like torch.stft) ──
    def _stft(self, x):
        """x: [c, chunk] -> [c, n_bins, dim_t] complex64"""
        pad = self.n_fft // 2
        xp = np.pad(x, ((0, 0), (pad, pad)), mode="reflect")
        n_frames = 1 + (xp.shape[1] - self.n_fft) // HOP
        idx = np.arange(self.n_fft)[None, :] + HOP * np.arange(n_frames)[:, None]
        frames = xp[:, idx] * self.win  # [c, T, n_fft]
        return np.fft.rfft(frames, axis=-1).transpose(0, 2, 1).astype(np.complex64)

    def _istft(self, spec, length):
        """spec: [c, n_bins, T] complex -> [c, length]"""
        frames = np.fft.irfft(spec.transpose(0, 2, 1), n=self.n_fft, axis=-1).astype(np.float32) * self.win
        c, n_frames, _ = frames.shape
        total = self.n_fft + HOP * (n_frames - 1)
        out = np.zeros((c, total), np.float32)
        norm = np.zeros(total, np.float32)
        w2 = self.win**2
        for t in range(n_frames):
            s = t * HOP
            out[:, s : s + self.n_fft] += frames[:, t]
            norm[s : s + self.n_fft] += w2
        pad = self.n_fft // 2
        out = out[:, pad : pad + length]
        norm = norm[pad : pad + length]
        return out / np.maximum(norm, 1e-8)

    def _to_model(self, spec):
        """[2, n_bins, T] complex -> [4, dim_f, T] (L re, L im, R re, R im)"""
        s = spec[:, : self.dim_f]
        return np.stack([s[0].real, s[0].imag, s[1].real, s[1].imag]).astype(np.float32)

    def _from_model(self, out):
        """[4, dim_f, T] -> [2, n_bins, T] complex (bins above dim_f are zero)"""
        spec = np.zeros((2, self.n_bins, out.shape[-1]), np.complex64)
        spec[0, : self.dim_f] = out[0] + 1j * out[1]
        spec[1, : self.dim_f] = out[2] + 1j * out[3]
        return spec

    def separate(self, audio):
        """audio: float32 [2, n] at 44.1 kHz (mono [n] is duplicated).
        Returns (vocals, background), each [2, n]."""
        audio = np.asarray(audio, np.float32)
        if audio.ndim == 1:
            audio = np.stack([audio, audio])
        n = audio.shape[1]
        pad = self.gen - n % self.gen
        mix = np.concatenate([np.zeros((2, self.trim), np.float32), audio, np.zeros((2, pad + self.trim), np.float32)], axis=1)
        starts = list(range(0, n + pad, self.gen))
        pieces = []
        for b in range(0, len(starts), self.batch):
            group = starts[b : b + self.batch]
            batch = np.stack([self._to_model(self._stft(mix[:, i : i + self.chunk])) for i in group])
            if len(group) < self.batch:  # the batch size is fixed
                batch = np.concatenate([batch, np.zeros((self.batch - len(group), *batch.shape[1:]), np.float32)])
            out = self.session.run(None, {"input": batch})[0]
            for k in range(len(group)):
                wave = self._istft(self._from_model(out[k]), self.chunk)
                pieces.append(wave[:, self.trim : -self.trim])
        vocals = np.concatenate(pieces, axis=1)[:, :n] * self.compensate
        return vocals, audio - vocals
