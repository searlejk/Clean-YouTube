"""Stem clips line up to the sample (roadmap step 4.4).

Starts a companion on a spare port, streams 25 s of a test file to it as
stem audio (media times starting at 100.0 s, like a video that began
mid-way), asks for clips at awkward times, and checks that each clip's
voice + background equals the original audio at the reported start, with a
best-match offset of exactly 0 samples.

    companion/.venv/bin/python companion/tests/test_stem_clips.py REF48K_F32
    (REF48K_F32: tests/lookahead/fixtures/long-ref48k.f32, see tests/lookahead/README.md)
"""
import asyncio, base64, json, os, subprocess, sys, time
from pathlib import Path
import numpy as np, websockets

ROOT = Path(__file__).resolve().parents[1]
PORT = 47997
ref = np.fromfile(sys.argv[1], np.float32).reshape(-1, 2)
T0 = 100.0

def decode(b64):
    return np.frombuffer(base64.b64decode(b64), "<i2").astype(np.float32).reshape(-1, 2) / 32767

async def main():
    srv = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--allow-any-extension"], env={**os.environ, "CLEAN_EARS_PORT": str(PORT)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(120):
            try:
                ws = await websockets.connect(f"ws://127.0.0.1:{PORT}", origin="chrome-extension://test", max_size=None); break
            except OSError:
                await asyncio.sleep(0.5)
        async with ws:
            await ws.send(json.dumps({"type": "hello", "version": 1}))
            while True:
                m = json.loads(await ws.recv())
                if m.get("type") == "status" and m["state"] != "loading": break
            assert m.get("stems"), "separation not available"
            for i in range(25):
                pcm = (np.clip(ref[i * 48000:(i + 1) * 48000], -1, 1) * 32767).astype("<i2")
                await ws.send(json.dumps({"type": "stem_audio", "stream": "blob:t", "time": T0 + i, "rate": 48000, "channels": 2, "pcm16": base64.b64encode(pcm.tobytes()).decode()}))
            await ws.send(json.dumps({"type": "stem_playhead", "stream": "blob:t", "time": T0}))
            asks = [(103.123456, 104.5), (110.39, 110.42), (110.35, 111.0), (119.9999, 121.25), (124.0, 124.9)]  # 110.4 is a block edge
            t_start = time.time()
            for k, (a, b) in enumerate(asks):
                await ws.send(json.dumps({"type": "stem_clip", "id": k, "stream": "blob:t", "from": a, "to": b, "vocals": True}))
            await ws.send(json.dumps({"type": "stem_clip", "id": 99, "stream": "blob:t", "from": 300.0, "to": 301.0}))
            ok = True
            for _ in range(len(asks) + 1):
                m = json.loads(await ws.recv())
                while m.get("type") != "stem_clip":
                    m = json.loads(await ws.recv())
                if m["id"] == 99:
                    print(f"clip outside the audio: {m.get('error')!r} (expected an error)"); ok &= "error" in m; continue
                a, b = asks[m["id"]]
                bg, voc = decode(m["background"]), decode(m["vocals"])
                s = round((m["start"] - T0) * 48000)
                n = len(bg)
                # Silence matches at every offset; prefer 0 on a tie.
                best = min(range(-5, 6), key=lambda lag: (round(float(np.abs(bg + voc - ref[s + lag:s + lag + n]).mean()), 6), abs(lag)))
                level = float(np.sqrt(np.mean(ref[s:s + n] ** 2)))
                err = np.abs(bg + voc - ref[s:s + n]).max()
                good = abs(m["start"] - a) <= 0.5 / 48000 + 1e-9 and best == 0 and err < 0.002 and abs(n - round((b - a) * 48000)) <= 1
                ok &= good
                print(f"clip {a:.6f}-{b}: start {m['start']:.6f}, {n} samples, level {level:.3f}, best offset {best} samples, max error {err:.4f}  {'OK' if good else 'FAIL'}  ({time.time() - t_start:.1f} s)")
            print("stem clip test", "passed" if ok else "FAILED")
            sys.exit(0 if ok else 1)
    finally:
        srv.terminate()

asyncio.run(main())
