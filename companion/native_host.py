#!/usr/bin/env python3
"""Lets Chrome start the companion (Chrome "native messaging").

Chrome runs this when the Clean Ears extension asks for it
(chrome.runtime.sendNativeMessage). It starts the companion in the
background if it isn't already running, answers, and exits; the companion
then quits by itself after a while with no YouTube playing.

Registered with Chrome by `companion/native-host.sh install`, which copies
this file to ~/Library/Application Support/CleanEars/ (macOS won't let
Chrome run programs kept in Desktop/Documents/Downloads) with COMPANION_DIR
filled in.
"""
import json
import os
import socket
import struct
import subprocess
import sys
from pathlib import Path

COMPANION_DIR = None  # filled in by native-host.sh install
HERE = Path(COMPANION_DIR) if COMPANION_DIR else Path(__file__).resolve().parent
LOG = Path.home() / "Library" / "Logs" / "CleanEars" / "companion.log"
PORT = 47823


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return {}
    n = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(n) or b"{}")


def send(msg):
    data = json.dumps(msg).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def running():
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
            return True
    except OSError:
        return False


def main():
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG.parent / "native-host.log", "a") as f:
        f.write(__import__("time").strftime("%Y-%m-%d %H:%M:%S") + " started by Chrome\n")
    msg = read_message()
    if msg.get("cmd") != "start":
        return send({"ok": False, "error": "unknown command"})
    if running():
        return send({"ok": True, "started": False})
    if not (HERE / ".venv" / "bin" / "python").exists():
        return send({"ok": False, "error": "companion not installed: run companion/install.sh"})
    env = dict(os.environ, PATH="/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", "/usr/bin:/bin"))
    with open(LOG, "ab") as log:
        subprocess.Popen(
            [str(HERE / ".venv" / "bin" / "python"), str(HERE / "server.py"), "--idle-exit", "900"],
            cwd=str(HERE), stdout=log, stderr=log, stdin=subprocess.DEVNULL, env=env,
            start_new_session=True,  # keeps running after Chrome closes this launcher
        )
    send({"ok": True, "started": True})


if __name__ == "__main__":
    main()
