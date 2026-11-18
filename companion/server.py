"""Clean Ears companion app (roadmap step 2.2).

Runs the speech model on this computer, outside the browser, and answers the
Clean Ears extension over a WebSocket on 127.0.0.1 (never the network).

    companion/.venv/bin/python companion/server.py [--model small.en] [--port 47823]

Pairing: only Chrome extensions may connect (checked by the WebSocket Origin
header, which web pages can't fake). The first extension to connect is
remembered; others are refused until `--reset-pairing`.

Protocol (JSON text messages):
  extension -> {"type": "hello", "version": 1}
  companion -> {"type": "status", "state": "loading" | "ready" | "error", "model", "device", "message"?}
  extension -> {"type": "transcribe", "id", "offset", "pcm16": base64 16 kHz mono int16}
  companion -> {"type": "transcribed", "id", "words": [{"text", "start", "end"}], "text",
                "processingMs", "model", "engine": "companion"}
Word times are in media seconds (offset + time inside the clip), as the model
reports them; the extension corrects each model's measured timing bias.
"""

import argparse
import asyncio
import base64
import json
import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import websockets
from websockets.asyncio.server import serve
from websockets.http11 import Response
from websockets.datastructures import Headers

from stems import StemStore, resample

ASR_INPUT = "vocals"  # "vocals": transcribe the separated voice stem when ready (step 4.3); "mix": never
SPOT_THRESHOLD = 0.3  # swear spotter: gain per frame a swear must have over Whisper's word (tests/kws_eval.py)
STEM_WAIT_S = 1.0  # shortest wait for a window's stretch to be separated
STEM_WAIT_FAR_S = 8.0  # longest
SAFE_MARGIN_S = 7.0  # a window waits at most (seconds until it plays) - this

PROTOCOL = 1
SR = 16000
CONFIG = Path.home() / "Library" / "Application Support" / "CleanEars" / "companion.json"

log = logging.getLogger("clean-ears")


def load_config():
    try:
        return json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        return {}


def save_config(cfg):
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, indent=2))


class Engine:
    """One speech model, used from one worker thread so passes never overlap."""

    def __init__(self, model_name, device):
        self.model_name = model_name
        self.want_device = device
        self.device = None
        self.model = None
        self.error = None
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.loaded = asyncio.Event()
        # Voice separation (roadmap step 4.2) gets its own thread so it never
        # holds up transcription.
        self.sep_pool = ThreadPoolExecutor(max_workers=1)
        self.stems = None  # StemStore once the separation model is loaded
        self.aligner = None  # forced alignment of word timings (step 5.2)
        self.spotter = None  # swear spotting from the same letter probabilities (step 6)
        self.use_spotter = False  # off by default: measured too many false alarms (see ROADMAP 6)
        self.use_align = True
        self.stem_owners = {}  # stream -> send function of the tab's connection
        self.served = 0  # windows since the last stats line
        self.from_voice = 0  # of those, transcribed from the separated voice
        self.audio_s = 0.0
        self.busy_s = 0.0

    def _load(self):
        from faster_whisper import WhisperModel

        tries = [("mps", "float16"), ("cpu", "int8")] if self.want_device == "auto" else [(self.want_device, "int8" if self.want_device == "cpu" else "float16")]
        last = None
        for dev, ct in tries:
            try:
                m = WhisperModel(self.model_name, device=dev, compute_type=ct)
                # Warm up (the first pass compiles GPU kernels).
                list(m.transcribe(np.zeros(SR, np.float32), language="en", beam_size=1)[0])
                self.model, self.device = m, dev
                break
            except Exception as e:  # MPS is experimental in ctranslate2; fall back to CPU
                last = e
                log.warning("could not use %s: %s", dev, e)
        else:
            raise RuntimeError(f"could not load {self.model_name}: {last}")
        if self.use_align:
            try:
                from align import Aligner

                al = Aligner()
                al.emissions(np.zeros(SR, np.float32))  # warm-up
                self.aligner = al
                if self.use_spotter:
                    from kws import KeywordSpotter

                    self.spotter = KeywordSpotter(al.vocab, threshold=SPOT_THRESHOLD)
                log.info("word alignment ready (wav2vec2, %s)%s", al.provider, "; swear spotter on (experimental)" if self.spotter else "")
            except Exception as e:
                log.warning("word alignment off: %s", e)
        try:
            from separation import Separator

            sep = Separator("Kim_Vocal_2")
            sep.separate(np.zeros((2, 44100), np.float32))  # warm-up (CoreML compiles on first run)
            self.stems = StemStore(sep)
            log.info("voice separation ready (%s, %s)", sep.name, sep.provider)
        except Exception as e:
            log.warning("voice separation off: %s", e)

    async def load(self):
        try:
            t = time.time()
            await asyncio.get_running_loop().run_in_executor(self.pool, self._load)
            log.info("loaded %s on %s in %.1f s", self.model_name, self.device, time.time() - t)
        except Exception as e:
            self.error = str(e)
            log.error("%s", e)
        self.loaded.set()

    def _transcribe_aligned(self, samples, offset):
        """Whisper's words, aligned to the audio (step 5.2), plus swears the
        keyword spotter heard (step 6), from one pass of wav2vec2."""
        words, text = self._transcribe(samples, offset)
        hits = []
        if self.aligner is not None and self.aligner.usable(samples):
            try:
                em = self.aligner.emissions(samples)
                if words:
                    words = self.aligner.align(samples, offset, words, em=em)
                if self.spotter is not None and self.spotter.patterns and words:
                    # Re-check each word Whisper heard against the word list.
                    hits = self.spotter.rescore(em, len(samples) / SR / em.shape[0], offset, words)
            except Exception as e:
                log.warning("alignment/spotting failed: %s", e)
        self.last_hits = hits
        return words, text

    def _transcribe(self, samples, offset):
        segs, _ = self.model.transcribe(
            samples,
            language="en",
            beam_size=1,
            word_timestamps=True,
            condition_on_previous_text=False,
            vad_filter=False,
        )
        words, text = [], []
        for s in segs:
            text.append(s.text)
            for w in s.words or []:
                words.append({"text": w.word, "start": round(offset + w.start, 3), "end": round(offset + w.end, 3)})
        return words, "".join(text)

    async def transcribe(self, samples, offset):
        t = time.perf_counter()
        def run():
            words, text = self._transcribe_aligned(samples, offset)
            return words, text, self.last_hits

        out = await asyncio.get_running_loop().run_in_executor(self.pool, run)
        self.served += 1
        self.audio_s += len(samples) / SR
        self.busy_s += time.perf_counter() - t
        return out

    async def separate_forever(self):
        """Work through pending stem blocks, nearest to each playhead first."""
        await self.loaded.wait()
        loop = asyncio.get_running_loop()
        idle_since = None
        while True:
            job, run = self.stems.next_job() if self.stems else (None, None)
            if job is None:
                if self.stems and log.isEnabledFor(logging.DEBUG):
                    idle_since = idle_since or time.monotonic()
                    if time.monotonic() - idle_since > 5:
                        idle_since = time.monotonic()
                        for name, st in self.stems.streams.items():
                            for r in st["runs"]:
                                log.debug("idle: %s run %.2f s: received %.2f s, separated %.2f s, busy %s", name, r.start, r.total / r.rate, r.done / r.rate, r.busy)
                await asyncio.sleep(0.05)
                continue
            idle_since = None
            log.debug("separating %s run %.2f: from %.2f s", "?", run.start, run.done / run.rate)
            try:
                stream = self.stems.finish(await loop.run_in_executor(self.sep_pool, job))
            except Exception:
                log.exception("separation failed")
                self.stems.fail(run)
                await asyncio.sleep(0.5)
                continue
            maybe_dump(self.stems, stream)
            send = self.stem_owners.get(stream)
            if send:
                try:
                    await send({"type": "stems", "stream": stream, "ranges": self.stems.ranges(stream), "speech": self.stems.speech(stream)})
                except Exception:
                    pass

    async def report(self, every=60):
        while True:
            await asyncio.sleep(every)
            if self.stems and self.stems.stats["blocks"]:
                st = self.stems.stats
                log.info("separated %d blocks (%.0f s of audio) in the last %d s; busy %.0f%%", st["blocks"], st["audio_s"], every, 100 * st["busy_s"] / every)
                self.stems.stats = {"blocks": 0, "audio_s": 0.0, "busy_s": 0.0}
            if self.served:
                log.info("served %d windows (%.0f s of audio, %d from the separated voice) in the last %d s; model busy %.0f%% of the time", self.served, self.audio_s, self.from_voice, every, 100 * self.busy_s / every)
                self.served, self.audio_s, self.busy_s, self.from_voice = 0, 0.0, 0.0, 0

    def status(self):
        if not self.loaded.is_set():
            return {"type": "status", "state": "loading", "model": self.model_name}
        if self.error:
            return {"type": "status", "state": "error", "model": self.model_name, "message": self.error}
        return {"type": "status", "state": "ready", "model": self.model_name, "device": self.device, "stems": self.stems is not None}


DUMP_DIR = os.environ.get("CLEAN_EARS_DUMP_STEMS")  # debugging: save the first 30 s of stems as WAV files
_dumped = set()


def maybe_dump(store, stream):
    if not DUMP_DIR or stream in _dumped:
        return
    ranges = store.ranges(stream)
    if not ranges or ranges[0][1] - ranges[0][0] < 30:
        return
    import wave

    _dumped.add(stream)
    t0 = ranges[0][0]
    got = store.get(stream, t0, t0 + 30)
    if got is None:
        return
    Path(DUMP_DIR).mkdir(parents=True, exist_ok=True)
    tag = f"{len(_dumped):02d}"
    for name, x in zip(("vocals", "background", "mix"), (got[0], got[1], got[0] + got[1])):
        pcm = (np.clip(x.T, -1, 1) * 32767).astype("<i2")
        with wave.open(str(Path(DUMP_DIR) / f"{tag}-{name}.wav"), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(48000)
            w.writeframes(pcm.tobytes())
    log.info("saved 30 s of stems from %.1f s to %s/%s-*.wav", t0, DUMP_DIR, tag)


async def transcribe_job(engine, msg, send):
    t_wait = time.perf_counter()
    try:
        samples = pcm16_to_float32(msg["pcm16"])
        offset = float(msg.get("offset") or 0)
        voice = await voice_stem(engine, msg.get("stream"), offset, len(samples))
        t0 = time.perf_counter()
        words, text, hits = await engine.transcribe(samples if voice is None else voice, offset)
        engine.from_voice += voice is not None
        reply = {"type": "transcribed", "id": msg.get("id"), "words": words, "text": text, "source": "mix" if voice is None else "vocals", "aligned": sum(1 for w in words if w.get("aligned")), "spotted": hits}
    except Exception as e:
        log.exception("transcribe failed")
        t0 = time.perf_counter()
        reply = {"type": "transcribed", "id": msg.get("id"), "error": str(e)}
    # processingMs is the model's time only (the extension sizes its delay from it).
    reply.update(processingMs=round((time.perf_counter() - t0) * 1000), waitMs=round((t0 - t_wait) * 1000), model=engine.model_name, engine="companion", device=engine.device)
    try:
        await send(reply)
    except websockets.ConnectionClosed:
        pass


CLIP_WAIT_S = 5.0  # how long a stem clip request waits for separation
CLIP_MAX_S = 10.0


def int16_b64(x):
    """[c, n] float32 -> base64 of interleaved little-endian int16."""
    return base64.b64encode((np.clip(x.T, -1, 1) * 32767).astype("<i2").tobytes()).decode()


async def stem_clip_job(engine, msg, send):
    """Stems for a short stretch around a swear, for the mixer (step 4.4):
    {type: 'stem_clip', id, stream, from, to, vocals?} -> {type: 'stem_clip', id,
    start, rate, channels, background, vocals?} or {..., error}."""
    reply = {"type": "stem_clip", "id": msg.get("id"), "stream": msg.get("stream")}
    try:
        t0, t1 = float(msg["from"]), float(msg["to"])
        if not (0 < t1 - t0 <= CLIP_MAX_S):
            raise ValueError("bad clip length")
        deadline = time.monotonic() + CLIP_WAIT_S
        while True:
            got = engine.stems.clip(msg["stream"], t0, t1)
            if got is not None or time.monotonic() > deadline or not engine.stems.received(msg["stream"], t0, t1):
                break
            await asyncio.sleep(0.05)
        if got is None:
            reply["error"] = "not separated"
        else:
            start, rate, vocals, background = got
            reply.update(start=start, rate=rate, channels=2, background=int16_b64(background))
            if msg.get("vocals"):
                reply["vocals"] = int16_b64(vocals)
    except Exception as e:
        reply["error"] = str(e)
    try:
        await send(reply)
    except websockets.ConnectionClosed:
        pass


async def voice_stem(engine, stream, offset, n):
    """The separated voice for n samples (16 kHz) from `offset`, as mono 16 kHz,
    waiting if that stretch is still being separated; else None. A window far
    ahead of the playhead can wait longer than one about to be heard."""
    if ASR_INPUT != "vocals" or not engine.stems or not stream:
        log.debug("window %.1f s: mix (no stream id or separation off)", offset)
        return None
    t0, t1 = offset, offset + n / SR
    ph = engine.stems.streams.get(stream, {}).get("playhead")
    # The extension schedules mutes ~6 s before a word plays, so a window
    # starting `ahead` seconds out can spend about ahead - 7 s waiting.
    wait = STEM_WAIT_S if ph is None else min(STEM_WAIT_FAR_S, max(STEM_WAIT_S, t0 - ph - SAFE_MARGIN_S))
    deadline = time.monotonic() + wait
    while True:
        got = engine.stems.get(stream, t0, t1)
        if got is not None:
            log.debug("window %.1f-%.1f s: voice (playhead %s)", t0, t1, ph)
            vocals = got[0].mean(axis=0, keepdims=True)
            return resample(vocals, n)[0]
        # Its full-quality audio may arrive a moment after the window itself,
        # so only a stream we've never had stem audio for gives up at once.
        if stream not in engine.stems.streams or time.monotonic() > deadline:
            log.debug("window %.1f-%.1f s: mix (playhead %s, waited %.1f s, known stream %s, ready %s)", t0, t1, ph, wait, stream in engine.stems.streams, engine.stems.ranges(stream))
            return None
        await asyncio.sleep(0.05)


def pcm16_to_float32(b64):
    return np.frombuffer(base64.b64decode(b64), dtype="<i2").astype(np.float32) / 32768.0


LOCAL_PAGE = ("http://127.0.0.1:", "http://localhost:")


def make_origin_check(cfg, allow_any, allow_local_pages=False):
    def check(connection, request):
        origin = request.headers.get("Origin", "")
        if allow_local_pages and (origin.startswith(LOCAL_PAGE) or not origin):
            return None  # development: the extension's test pages and local test scripts
        if not origin.startswith("chrome-extension://"):
            log.warning("refused connection from origin %r", origin)
            return Response(403, "Forbidden", Headers([("Content-Type", "text/plain")]), b"Only the Clean Ears extension may connect.\n")
        if allow_any:
            return None
        paired = cfg.get("pairedOrigin")
        if not paired:
            cfg["pairedOrigin"] = origin
            save_config(cfg)
            log.info("paired with %s", origin)
        elif paired != origin:
            log.warning("refused %s (paired with %s; run with --reset-pairing to change)", origin, paired)
            return Response(403, "Forbidden", Headers([("Content-Type", "text/plain")]), b"Paired with a different extension.\n")
        return None

    return check


async def handle(ws, engine):
    log.info("extension connected")
    send_lock = asyncio.Lock()

    async def send(msg):
        async with send_lock:
            await ws.send(json.dumps(msg))

    async def announce_when_loaded():
        await engine.loaded.wait()
        await send(engine.status())

    announcer = None
    owned = set()  # streams this connection sent stem audio for
    tasks = set()  # transcriptions in flight
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            kind = msg.get("type")
            if kind == "hello":
                await send({**engine.status(), "protocol": PROTOCOL})
                if not engine.loaded.is_set() and announcer is None:
                    announcer = asyncio.create_task(announce_when_loaded())
            elif kind == "stem_audio" and engine.stems:
                ch = int(msg.get("channels") or 2)
                pcm = np.frombuffer(base64.b64decode(msg["pcm16"]), dtype="<i2").astype(np.float32) / 32768.0
                pcm = pcm[: len(pcm) // ch * ch].reshape(-1, ch).T
                engine.stems.add(msg["stream"], float(msg["time"]), int(msg["rate"]), pcm)
                engine.stem_owners[msg["stream"]] = send
                owned.add(msg["stream"])
            elif kind == "stem_playhead" and engine.stems:
                engine.stems.playhead(msg["stream"], float(msg["time"]))
            elif kind == "stem_close" and engine.stems:
                engine.stems.close(msg["stream"])
            elif kind == "kws_words":
                if engine.spotter is not None:
                    engine.spotter.set_words(msg.get("words") or [])
                    log.info("swear spotting: %d patterns from the word list", len(engine.spotter.patterns))
            elif kind == "stem_clip" and engine.stems:
                task = asyncio.create_task(stem_clip_job(engine, msg, send))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
            elif kind == "transcribe":
                if engine.model is None:
                    await send({"type": "transcribed", "id": msg.get("id"), "error": "model not ready"})
                    continue
                # Its own task: waiting for the voice stem mustn't stop this
                # loop from reading the audio that stem is made from.
                task = asyncio.create_task(transcribe_job(engine, msg, send))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
    except websockets.ConnectionClosed:
        pass
    finally:
        if announcer:
            announcer.cancel()
        for task in tasks:
            task.cancel()
        for stream in owned:
            engine.stem_owners.pop(stream, None)
            if engine.stems:
                engine.stems.close(stream)
        log.info("extension disconnected")


async def check(args):
    """Install-time self test: model downloaded, GPU (or CPU) works, fast enough."""
    engine = Engine(args.model, args.device)
    await engine.load()
    if engine.error:
        print(f"FAILED: {engine.error}")
        sys.exit(1)
    rng = np.random.default_rng(0)
    clip = (rng.standard_normal(10 * SR) * 0.01).astype(np.float32)
    t = time.perf_counter()
    await engine.transcribe(clip, 0.0)
    ms = (time.perf_counter() - t) * 1000
    where = "GPU" if engine.device == "mps" else "CPU"
    print(f"OK: {args.model} on {where}, {ms:.0f} ms for 10 s of audio ({10000 / ms:.0f}x real time)")


async def main():
    global ASR_INPUT
    p = argparse.ArgumentParser(description="Clean Ears companion app")
    p.add_argument("--model", default="small.en", choices=["tiny.en", "base.en", "small.en"])
    p.add_argument("--device", default="auto", choices=["auto", "mps", "cpu"])
    p.add_argument("--port", type=int, default=int(os.environ.get("CLEAN_EARS_PORT", 47823)))
    p.add_argument("--reset-pairing", action="store_true", help="forget the paired extension")
    p.add_argument("--allow-any-extension", action="store_true", help="skip pairing (development)")
    p.add_argument("--allow-local-test-pages", action="store_true", help="also accept pages served from 127.0.0.1/localhost (development)")
    p.add_argument("--check", action="store_true", help="download the model, time one pass, and exit")
    p.add_argument("--asr-input", default=ASR_INPUT, choices=["vocals", "mix"], help="transcribe the separated voice (default) or the full mix")
    p.add_argument("--no-align", action="store_true", help="use Whisper's own word times instead of forced alignment")
    p.add_argument("--spot-swears", action="store_true", help="experimental: also mute words the swear spotter thinks are swears (more false alarms)")
    args = p.parse_args()

    logging.basicConfig(level=logging.DEBUG if os.environ.get("CLEAN_EARS_DEBUG") else logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "faster_whisper", "websockets", "asyncio", "httpcore", "urllib3", "filelock", "huggingface_hub"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if args.check:
        return await check(args)
    ASR_INPUT = args.asr_input
    cfg = load_config()
    if args.reset_pairing:
        cfg.pop("pairedOrigin", None)
        save_config(cfg)
        log.info("pairing reset")

    engine = Engine(args.model, args.device)
    engine.use_align = not args.no_align
    engine.use_spotter = args.spot_swears
    asyncio.create_task(engine.load())
    asyncio.create_task(engine.report())
    asyncio.create_task(engine.separate_forever())
    async with serve(
        lambda ws: handle(ws, engine),
        "127.0.0.1",
        args.port,
        process_request=make_origin_check(cfg, args.allow_any_extension, args.allow_local_test_pages),
        max_size=8 * 1024 * 1024,
    ):
        log.info("listening on ws://127.0.0.1:%d (model %s)", args.port, args.model)
        await asyncio.get_running_loop().create_future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
