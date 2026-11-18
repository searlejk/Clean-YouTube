"""Word-timing bias of each companion model (roadmap step 2.2).

Builds speech with exact word timings by synthesizing words one at a time
with macOS `say` (written to files; nothing plays aloud), then measures how
early/late Whisper times each word.

    .venv/bin/python tests/word_timing.py OUT_DIR

Writes OUT_DIR/lag-audio.npy and lag-truth.json (used by separation_bench.py).
"""
import subprocess, numpy as np, os, sys, random, tempfile
from faster_whisper import WhisperModel
random.seed(1)
text = ("well this is a really good test of the system and honestly it is shit . "
        "you son of a bitch get out of my kitchen right now . "
        "the sauce is fucking raw and the fish is damn cold . "
        "I told you this morning that the chef would be here at noon . "
        "what the hell is going on with these plates today").split()
d = tempfile.mkdtemp()
def synth(w, voice):
    a = os.path.join(d, 'w.aiff')
    subprocess.run(['say', '-v', voice, '-o', a, w], check=True)
    raw = subprocess.run(['ffmpeg','-v','error','-i',a,'-ac','1','-ar','16000','-f','f32le','-'],capture_output=True).stdout
    x = np.frombuffer(raw, np.float32)
    env = np.abs(x) > 0.01
    i = np.argmax(env); j = len(x) - np.argmax(env[::-1])
    return x[i:j]
truth = []; parts = []; t = 0.5; parts.append(np.zeros(8000, np.float32))
voices = ['Samantha', 'Daniel']
vi = 0
for w in text:
    if w == '.':
        vi ^= 1; g = 0.6
        parts.append(np.zeros(int(g*16000), np.float32)); t += g; continue
    x = synth(w, voices[vi])
    truth.append((w, t, t + len(x)/16000)); parts.append(x); t += len(x)/16000
    g = random.uniform(0.05, 0.2); parts.append(np.zeros(int(g*16000), np.float32)); t += g
audio = np.concatenate(parts)
np.save(os.path.join(sys.argv[1], 'lag-audio.npy'), audio)
import json; json.dump(truth, open(os.path.join(sys.argv[1], 'lag-truth.json'), 'w'))
print('seconds', len(audio)/16000, 'words', len(truth))
norm = lambda s: ''.join(c for c in s.lower() if c.isalnum())
for name, dev, ct in [('small.en','mps','float16'), ('base.en','mps','float16'), ('tiny.en','cpu','int8')]:
    m = WhisperModel(name, device=dev, compute_type=ct)
    # 10 s windows like the extension
    words = []
    for off in np.arange(0, len(audio)/16000, 9.0):
        seg = audio[int(off*16000): int((off+10)*16000)]
        segs,_ = m.transcribe(seg, language='en', word_timestamps=True, beam_size=1, condition_on_previous_text=False, vad_filter=False)
        for s in segs:
            for w in s.words: words.append((norm(w.word), off + w.start, off + w.end))
    ds, de = [], []
    for w, a, b in truth:
        c = [x for x in words if x[0] == norm(w) and abs(x[1]-a) < 1.0]
        if c:
            x = min(c, key=lambda x: abs(x[1]-a)); ds.append(x[1]-a); de.append(x[2]-b)
    ds, de = np.array(ds), np.array(de)
    print(f"{name}: matched {len(ds)}/{len(truth)}  start late by median {np.median(ds):+.3f} p95 {np.percentile(ds,95):+.3f} p5 {np.percentile(ds,5):+.3f} | end late median {np.median(de):+.3f} p95 {np.percentile(de,95):+.3f} p5 {np.percentile(de,5):+.3f}")
