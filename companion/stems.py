"""Voice / background stems for the audio the extension reads ahead
(roadmap step 4.2).

The extension streams the decoded YouTube audio (48 kHz stereo, tagged with
media time) as it's downloaded, well ahead of playback. Each video's audio is
kept as continuous "runs" (a seek starts a new one). Runs are separated in
~10 s blocks, each with 0.5 s of real audio on both sides as context so block
edges don't sound different, and the stems are stored by media time.

    store = StemStore(separator)
    store.add(stream, time, rate, pcm)      # pcm: float32 [channels, n]
    store.playhead(stream, t)               # lets old stems go
    job, run = store.next_job()             # job(): does the work (any thread); None if idle
    store.finish(job())                     # back on the main thread
    store.ranges(stream)                    # [[from, to], ...] media seconds ready
    store.speech(stream)                    # [[from, to], ...] where the separated voice has speech
                                            # (Silero VAD, step 5.1); pauses are the gaps inside ranges()
    store.get(stream, t0, t1)               # (vocals, background) [2, n] at 48 kHz, or None
    store.clip(stream, t0, t1)              # (start, rate, vocals, background): start is the exact
                                            # media time of sample 0 (t0 snapped to a sample)
"""

import time

import numpy as np

from separation import SR as MODEL_SR

# Silero VAD (bundled with faster-whisper) on the separated voice, tuned to
# find the short pauses between phrases, not just long silences.
try:
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    VAD = VadOptions(threshold=0.5, min_silence_duration_ms=120, speech_pad_ms=30)
except Exception:  # pragma: no cover
    get_speech_timestamps = None

BLOCK_S = 10.4  # seconds of output per block (two model chunks with the context)
CONTEXT_S = 0.5  # real audio on each side of a block, discarded after
IDLE_FLUSH_S = 1.0  # a run that stopped growing this long gets its tail done
KEEP_BEHIND_S = 30.0  # stems kept behind the playhead
MAX_AHEAD_S = 600.0  # audio further ahead than this is ignored
JOIN = 0.002  # seconds; closer than this counts as continuous


def resample(x, n_out):
    """FFT resampling of [c, n] to [c, n_out] (edges are inside the context)."""
    n = x.shape[-1]
    if n_out == n:
        return x
    spec = np.fft.rfft(x, axis=-1)
    bins = n_out // 2 + 1
    out = np.zeros((x.shape[0], bins), np.complex64)
    k = min(bins, spec.shape[-1])
    out[:, :k] = spec[:, :k]
    return (np.fft.irfft(out, n=n_out, axis=-1) * (n_out / n)).astype(np.float32)


class Run:
    """Continuous audio for one stream from `start` (media s) at `rate`."""

    def __init__(self, start, rate, channels):
        self.start = start
        self.rate = rate
        self.channels = channels
        self.raw = np.zeros((2, 0), np.float32)
        self.raw_offset = 0  # run sample index of raw[:, 0]
        self.total = 0  # samples received
        self.done = 0  # samples separated
        self.blocks = []  # (start_s, end_s, vocals f16 [2,n], background f16 [2,n])
        self.speech = []  # [start_s, end_s] speech in the separated voice
        self.updated = time.monotonic()
        self.busy = False

    def end_time(self):
        return self.start + self.total / self.rate

    def append(self, pcm):
        if pcm.shape[0] == 1:
            pcm = np.repeat(pcm, 2, axis=0)
        self.raw = np.concatenate([self.raw, pcm[:2]], axis=1)
        self.total += pcm.shape[1]
        self.updated = time.monotonic()

    def work(self, now):
        """(seg_from, out_from, out_to, seg_to) in run samples, or None."""
        if self.busy:
            return None
        block = int(BLOCK_S * self.rate)
        ctx = int(CONTEXT_S * self.rate)
        left = self.total - self.done
        if left <= 0:
            return None
        if left >= block + ctx:
            out_to = self.done + block
        elif now - self.updated > IDLE_FLUSH_S:
            out_to = self.total
        else:
            return None
        return max(0, self.done - ctx), self.done, out_to, min(self.total, out_to + ctx)

    def segment(self, a, b):
        return self.raw[:, a - self.raw_offset : b - self.raw_offset].copy()

    def finish(self, out_from, out_to, vocals, background, speech=()):
        self.blocks.append((self.start + out_from / self.rate, self.start + out_to / self.rate, vocals.astype(np.float16), background.astype(np.float16)))
        t0 = self.start + out_from / self.rate
        for a, b in speech:
            a, b = t0 + a, t0 + b
            if self.speech and a - self.speech[-1][1] < 0.05:  # continues over the block edge
                self.speech[-1][1] = max(self.speech[-1][1], b)
            else:
                self.speech.append([a, b])
        self.done = out_to
        # Keep only what the next block needs as left context.
        keep_from = max(self.raw_offset, self.done - int(CONTEXT_S * self.rate))
        self.raw = self.raw[:, keep_from - self.raw_offset :]
        self.raw_offset = keep_from
        self.busy = False


class StemStore:
    def __init__(self, separator):
        self.sep = separator
        self.streams = {}  # stream -> {"runs": [Run], "playhead": float|None}
        self.stats = {"blocks": 0, "audio_s": 0.0, "busy_s": 0.0}

    def _stream(self, stream):
        return self.streams.setdefault(stream, {"runs": [], "playhead": None})

    def add(self, stream, t, rate, pcm):
        st = self._stream(stream)
        if st["playhead"] is not None and t > st["playhead"] + MAX_AHEAD_S:
            return
        run = next((r for r in st["runs"] if r.rate == rate and abs(r.end_time() - t) <= JOIN), None)
        if run is None:
            run = Run(t, rate, pcm.shape[0])
            st["runs"].append(run)
        run.append(pcm)

    def playhead(self, stream, t):
        st = self._stream(stream)
        st["playhead"] = t
        for run in st["runs"]:
            run.blocks = [b for b in run.blocks if b[1] >= t - KEEP_BEHIND_S]
            run.speech = [s for s in run.speech if s[1] >= t - KEEP_BEHIND_S]
        st["runs"] = [r for r in st["runs"] if r.blocks or r.end_time() >= t - KEEP_BEHIND_S]

    def close(self, stream):
        self.streams.pop(stream, None)

    def next_job(self):
        """The most urgent pending block: nearest after its stream's playhead."""
        now = time.monotonic()
        best = None
        for stream, st in self.streams.items():
            ph = st["playhead"]
            for run in st["runs"]:
                w = run.work(now)
                if not w:
                    continue
                t = run.start + w[1] / run.rate
                urgency = abs(t - ph) if ph is not None else t
                if ph is not None and t + BLOCK_S < ph:
                    urgency += 1e6  # already played; do it last
                if best is None or urgency < best[0]:
                    best = (urgency, stream, run, w)
        if best is None:
            return None, None
        _, stream, run, (seg_a, out_a, out_b, seg_b) = best
        run.busy = True
        seg = run.segment(seg_a, seg_b)

        def job():
            t0 = time.perf_counter()
            n = seg.shape[1]
            x = resample(seg, max(1, round(n * MODEL_SR / run.rate)))
            vocals, _ = self.sep.separate(x)
            vocals = resample(vocals, n)
            background = seg - vocals  # exact: vocals + background == the original audio
            a, b = out_a - seg_a, out_b - seg_a
            speech = []
            if get_speech_timestamps is not None:
                v16 = resample(vocals[:, a:b].mean(axis=0, keepdims=True), max(1, round((b - a) * 16000 / run.rate)))[0]
                speech = [(s["start"] / 16000, s["end"] / 16000) for s in get_speech_timestamps(v16, VAD)]
            self.stats["busy_s"] += time.perf_counter() - t0
            self.stats["blocks"] += 1
            self.stats["audio_s"] += (out_b - out_a) / run.rate
            return stream, run, out_a, out_b, vocals[:, a:b], background[:, a:b], speech

        return job, run

    def finish(self, result):
        stream, run, out_a, out_b, vocals, background, speech = result
        run.finish(out_a, out_b, vocals, background, speech)
        return stream

    def fail(self, run):
        run.busy = False

    def ranges(self, stream):
        st = self.streams.get(stream)
        if not st:
            return []
        spans = sorted((b[0], b[1]) for r in st["runs"] for b in r.blocks)
        merged = []
        for a, b in spans:
            if merged and a <= merged[-1][1] + JOIN:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        return [[round(a, 3), round(b, 3)] for a, b in merged]

    def speech(self, stream):
        st = self.streams.get(stream)
        if not st:
            return []
        segs = sorted(s for r in st["runs"] for s in r.speech)
        merged = []
        for a, b in segs:
            if merged and a <= merged[-1][1] + JOIN:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        return [[round(a, 3), round(b, 3)] for a, b in merged]

    def received(self, stream, t0, t1):
        """Has the audio for [t0, t1) arrived (separated or not)?"""
        st = self.streams.get(stream)
        return bool(st) and any(r.start <= t0 + JOIN and r.end_time() >= t1 - JOIN for r in st["runs"])

    def clip(self, stream, t0, t1):
        """Like get(), but also says exactly where the clip starts: t0 rounded
        to the run's sample grid, so the mixer can line it up to the sample."""
        st = self.streams.get(stream)
        if not st:
            return None
        for run in st["runs"]:
            if not (run.start - JOIN <= t0 and t1 <= run.end_time() + JOIN):
                continue
            a = round((t0 - run.start) * run.rate)
            start = run.start + a / run.rate
            got = self.get(stream, start, start + round((t1 - t0) * run.rate) / run.rate)
            if got is not None:
                return start, run.rate, got[0], got[1]
        return None

    def get(self, stream, t0, t1):
        """Stems covering [t0, t1) at the stream's rate, or None if not all ready."""
        st = self.streams.get(stream)
        if not st:
            return None
        for run in st["runs"]:
            blocks = [b for b in run.blocks if b[1] > t0 and b[0] < t1]
            if not blocks:
                continue
            blocks.sort(key=lambda b: b[0])
            if blocks[0][0] > t0 + JOIN or blocks[-1][1] < t1 - JOIN:
                continue
            voc = np.concatenate([b[2] for b in blocks], axis=1).astype(np.float32)
            bg = np.concatenate([b[3] for b in blocks], axis=1).astype(np.float32)
            a = int(round((t0 - blocks[0][0]) * run.rate))
            n = int(round((t1 - t0) * run.rate))
            return voc[:, a : a + n], bg[:, a : a + n]
        return None
