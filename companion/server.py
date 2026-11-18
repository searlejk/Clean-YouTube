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
        self.served = 0  # windows since the last stats line
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
                return
            except Exception as e:  # MPS is experimental in ctranslate2; fall back to CPU
                last = e
                log.warning("could not use %s: %s", dev, e)
        raise RuntimeError(f"could not load {self.model_name}: {last}")

    async def load(self):
        try:
            t = time.time()
            await asyncio.get_running_loop().run_in_executor(self.pool, self._load)
            log.info("loaded %s on %s in %.1f s", self.model_name, self.device, time.time() - t)
        except Exception as e:
            self.error = str(e)
            log.error("%s", e)
        self.loaded.set()

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
        out = await asyncio.get_running_loop().run_in_executor(self.pool, self._transcribe, samples, offset)
        self.served += 1
        self.audio_s += len(samples) / SR
        self.busy_s += time.perf_counter() - t
        return out

    async def report(self, every=60):
        while True:
            await asyncio.sleep(every)
            if self.served:
                log.info("served %d windows (%.0f s of audio) in the last %d s; model busy %.0f%% of the time", self.served, self.audio_s, every, 100 * self.busy_s / every)
                self.served, self.audio_s, self.busy_s = 0, 0.0, 0.0

    def status(self):
        if not self.loaded.is_set():
            return {"type": "status", "state": "loading", "model": self.model_name}
        if self.error:
            return {"type": "status", "state": "error", "model": self.model_name, "message": self.error}
        return {"type": "status", "state": "ready", "model": self.model_name, "device": self.device}


def pcm16_to_float32(b64):
    return np.frombuffer(base64.b64decode(b64), dtype="<i2").astype(np.float32) / 32768.0


def make_origin_check(cfg, allow_any):
    def check(connection, request):
        origin = request.headers.get("Origin", "")
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
            elif kind == "transcribe":
                if engine.model is None:
                    await send({"type": "transcribed", "id": msg.get("id"), "error": "model not ready"})
                    continue
                t0 = time.perf_counter()
                try:
                    samples = pcm16_to_float32(msg["pcm16"])
                    words, text = await engine.transcribe(samples, float(msg.get("offset") or 0))
                    reply = {"type": "transcribed", "id": msg.get("id"), "words": words, "text": text}
                except Exception as e:
                    log.exception("transcribe failed")
                    reply = {"type": "transcribed", "id": msg.get("id"), "error": str(e)}
                reply.update(processingMs=round((time.perf_counter() - t0) * 1000), model=engine.model_name, engine="companion", device=engine.device)
                await send(reply)
    except websockets.ConnectionClosed:
        pass
    finally:
        if announcer:
            announcer.cancel()
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
    p = argparse.ArgumentParser(description="Clean Ears companion app")
    p.add_argument("--model", default="small.en", choices=["tiny.en", "base.en", "small.en"])
    p.add_argument("--device", default="auto", choices=["auto", "mps", "cpu"])
    p.add_argument("--port", type=int, default=int(os.environ.get("CLEAN_EARS_PORT", 47823)))
    p.add_argument("--reset-pairing", action="store_true", help="forget the paired extension")
    p.add_argument("--allow-any-extension", action="store_true", help="skip pairing (development)")
    p.add_argument("--check", action="store_true", help="download the model, time one pass, and exit")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "faster_whisper"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if args.check:
        return await check(args)
    cfg = load_config()
    if args.reset_pairing:
        cfg.pop("pairedOrigin", None)
        save_config(cfg)
        log.info("pairing reset")

    engine = Engine(args.model, args.device)
    asyncio.create_task(engine.load())
    asyncio.create_task(engine.report())
    async with serve(
        lambda ws: handle(ws, engine),
        "127.0.0.1",
        args.port,
        process_request=make_origin_check(cfg, args.allow_any_extension),
        max_size=8 * 1024 * 1024,
    ):
        log.info("listening on ws://127.0.0.1:%d (model %s)", args.port, args.model)
        await asyncio.get_running_loop().create_future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
