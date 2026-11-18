"""Separation speed and quality (roadmap step 4.1).

Mixes the synthetic speech from word_timing.py with synthetic music at 0 dB,
separates it with each MDX-Net model, and reports time for 10 s of audio and
the vocal stem's SDR against the clean speech.

    .venv/bin/python tests/separation_bench.py OUT_DIR   (run from companion/)
"""
import sys, time, json, subprocess, numpy as np
sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parents[1]))
from separation import Separator, SR
S = sys.argv[1]
def resample(x, sr_in, sr_out):
    p = subprocess.run(['ffmpeg','-v','error','-f','f32le','-ar',str(sr_in),'-ac','1','-i','-','-ar',str(sr_out),'-f','f32le','-'], input=x.astype(np.float32).tobytes(), capture_output=True)
    return np.frombuffer(p.stdout, np.float32)
# 1. round trip
sep = Separator('Kim_Vocal_2', providers=['CPUExecutionProvider'])
x = np.random.default_rng(0).standard_normal((2, sep.chunk)).astype(np.float32) * 0.1
y = sep._istft(sep._stft(x), sep.chunk)
print('stft round trip max err', float(np.abs(x - y)[:, 4000:-4000].max()))
# 2. test mix: synthetic speech (exact) + synthetic music
speech16 = np.load(f'{S}/lag-audio.npy')
speech = resample(speech16, 16000, SR)
n = len(speech); t = np.arange(n) / SR
rng = np.random.default_rng(1)
music = np.zeros(n, np.float32)
chords = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 311.1]]
beat = 0.5
for k in range(int(n / SR / 2) + 1):
    seg = (t >= 2 * k) & (t < 2 * k + 2)
    for f in chords[k % 4]:
        for h, a in [(1, 1), (2, .5), (3, .25), (4, .12)]:
            music[seg] += a * np.sin(2 * np.pi * f * h * t[seg]) * 0.05
    music[seg] += 0.12 * np.sin(2 * np.pi * chords[k % 4][0] / 2 * t[seg])
for b in np.arange(0, n / SR, beat):
    i = int(b * SR); L = int(0.12 * SR)
    env = np.exp(-np.arange(L) / (0.03 * SR))
    music[i:i+L] += (0.5 * np.sin(2 * np.pi * 60 * np.arange(L) / SR) * env)[: n - i]
    j = int((b + beat / 2) * SR); L2 = int(0.05 * SR)
    music[j:j+L2] += (rng.standard_normal(L2) * 0.15 * np.exp(-np.arange(L2) / (0.01 * SR)))[: max(0, n - j)]
music *= np.sqrt(np.mean(speech**2) / np.mean(music**2))  # 0 dB speech-to-music
mix = np.stack([speech + music, speech + 0.9 * music])
peak = np.abs(mix).max(); mix /= peak * 1.05; speech_n = speech / (peak * 1.05)
def sdr(ref, est):
    return 10 * np.log10(np.sum(ref**2) / np.sum((ref - est)**2))
print('mix SDR vs clean speech %.1f dB' % sdr(speech_n, mix.mean(0)))
results = {}
for name in ['Kim_Vocal_2', 'UVR-MDX-NET-Voc_FT']:
    for prov in [None]:
        try:
            s = Separator(name)
        except Exception as e:
            print(name, 'failed', e); continue
        ten = mix[:, : 10 * SR]
        s.separate(ten)  # warm-up
        times = []
        for _ in range(2):
            t0 = time.perf_counter(); s.separate(ten); times.append(time.perf_counter() - t0)
        voc, bg = s.separate(mix)
        print(f'{name:20s} {s.provider:26s} 10 s audio: {min(times)*1000:.0f} ms   vocal SDR {sdr(speech_n, voc.mean(0)):.1f} dB')
        results[name] = voc.mean(0)
np.save(f'{S}/sep-mix.npy', mix.mean(0)); np.save(f'{S}/sep-clean.npy', speech_n)
for k, v in results.items(): np.save(f'{S}/sep-{k}.npy', v)
