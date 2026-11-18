"""Stem store test (roadmap step 4.2): feeds 48 kHz stereo audio in 1 s
chunks like the extension does, then checks coverage, quality at block seams,
seeks (new runs) and dropping old stems.

    .venv/bin/python tests/test_stems.py OUT_DIR   (OUT_DIR from word_timing.py
    and separation_bench.py: needs sep-mix.npy and sep-clean.npy)
"""
import subprocess, sys, time
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from separation import Separator
import stems as S

out = Path(sys.argv[1])
def to48(x):
    p = subprocess.run(['ffmpeg','-v','error','-f','f32le','-ar','44100','-ac','1','-i','-','-ar','48000','-f','f32le','-'], input=x.astype(np.float32).tobytes(), capture_output=True)
    return np.frombuffer(p.stdout, np.float32)
mix = to48(np.load(out / 'sep-mix.npy')); clean = to48(np.load(out / 'sep-clean.npy'))
n = min(len(mix), len(clean)); mix, clean = mix[:n], clean[:n]
stereo = np.stack([mix, mix])
sdr = lambda ref, est: 10 * np.log10(np.sum(ref**2) / np.sum((ref - est)**2))

store = S.StemStore(Separator('Kim_Vocal_2'))
S.IDLE_FLUSH_S = 0.2
T0 = 100.0  # media time of the first sample
t_start = time.perf_counter(); busy = 0.0
for i in range(0, n, 48000):
    store.add('v1', T0 + i / 48000, 48000, stereo[:, i:i + 48000])
    while True:
        job, run = store.next_job()
        if not job: break
        t = time.perf_counter(); store.finish(job()); busy += time.perf_counter() - t
time.sleep(0.3)
while True:
    job, run = store.next_job()
    if not job: break
    t = time.perf_counter(); store.finish(job()); busy += time.perf_counter() - t
dur = n / 48000
print('ranges', store.ranges('v1'), 'expected', [T0, round(T0 + dur, 3)])
got = store.get('v1', T0, T0 + dur - 0.01)
assert got is not None, 'stems missing'
voc, bg = got
m = voc.shape[1]
print(f'separated {dur:.1f} s in {busy:.2f} s ({dur / busy:.0f}x real time)')
print(f'vocal SDR {sdr(clean[:m], voc.mean(0)):.1f} dB;  vocals+background = mix: max err {np.abs(voc + bg - stereo[:, :m]).max():.4f}')
# seams: compare with separating everything in one go
whole_v, _ = store.sep.separate(S.resample(stereo[:, :m], round(m * 44100 / 48000)))
whole_v = S.resample(whole_v, m)
for k in range(1, int(dur // S.BLOCK_S) + 1):
    j = int(k * S.BLOCK_S * 48000); w = slice(j - 2400, j + 2400)
    e = np.sqrt(np.mean((voc[:, w] - whole_v[:, w])**2)) / (np.sqrt(np.mean(whole_v[:, w]**2)) + 1e-9)
    print(f'seam at {k * S.BLOCK_S:.1f} s: difference from one-pass separation {100 * e:.1f}% of level')
# seek: a second run elsewhere
store.add('v1', T0 + 500, 48000, stereo[:, :48000 * 3]); time.sleep(0.3)
job, run = store.next_job(); store.finish(job())
print('after seek ranges', store.ranges('v1'))
store.playhead('v1', T0 + 540)
print('after playhead at +540 s, ranges', store.ranges('v1'))
assert store.ranges('v1') == [], 'old stems should be gone'
print('stems test passed')
