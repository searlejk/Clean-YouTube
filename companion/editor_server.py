"""Substitute-swear editor: a local page for tweaking how replacement words
sound in a speaker's voice, on a video processed by companion/offline.py.

    companion/.venv/bin/python companion/editor_server.py
    then open http://127.0.0.1:47824

Only listens on this computer. Projects are the folders in media/.
"""
import io
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import soundfile

from editor_audio import DEFAULTS, SR, Editor, Project

HERE = Path(__file__).resolve().parent
MEDIA = HERE.parent / "media"
PAGE = HERE / "editor" / "index.html"
PORT = 47824

projects = {}
editor = Editor()
render_lock = threading.Lock()
rendered = {}  # render id -> {context, original, word}


def project(pid):
    if pid not in projects:
        d = MEDIA / pid
        if not (d / "swears.json").exists():
            raise KeyError(pid)
        projects[pid] = Project(d)
    return projects[pid]


def wav_bytes(x, sr=SR):
    x = np.asarray(x, np.float32)
    buf = io.BytesIO()
    soundfile.write(buf, (x.T if x.ndim == 2 else x), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def presets_path(pid):
    return MEDIA / pid / "presets.json"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        pass

    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/":
                return self.send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
            if u.path == "/api/projects":
                items = []
                for d in sorted(MEDIA.glob("*/swears.json")):
                    meta = MEDIA / f"{d.parent.name}.txt"
                    title = meta.read_text().split("|")[0] if meta.exists() else d.parent.name
                    items.append({"id": d.parent.name, "title": title})
                return self.send(200, items)
            if u.path == "/api/project":
                p = project(q["id"])
                pr = json.loads(presets_path(q["id"]).read_text()) if presets_path(q["id"]).exists() else {}
                speakers = {}
                for w in p.words:
                    if w.get("speaker") is not None:
                        speakers[w["speaker"]] = speakers.get(w["speaker"], 0) + 1
                words = [{"text": w["text"], "start": w["start"], "end": w["end"]} for w in p.words]
                return self.send(200, {"swears": p.swears, "words": words, "speakers": speakers, "voices": p.voices, "presets": pr, "defaults": DEFAULTS})
            if u.path == "/api/audio":
                p = project(q["id"])
                return self.send(200, wav_bytes(p.slice(q.get("track", "mix"), float(q["start"]), float(q["end"]))), "audio/wav")
            if u.path == "/api/rendered":
                r = rendered[q["rid"]]
                return self.send(200, wav_bytes(r[q.get("which", "context")]), "audio/wav")
            return self.send(404, {"error": "not found"})
        except KeyError as e:
            return self.send(404, {"error": f"unknown {e}"})
        except Exception as e:
            return self.send(500, {"error": str(e)})

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        try:
            if u.path == "/api/render":
                p = project(body["id"])
                t = time.perf_counter()
                with render_lock:  # one OmniVoice run at a time
                    r = editor.render(p, int(body["index"]), body.get("settings") or {})
                rid = uuid.uuid4().hex[:12]
                rendered[rid] = {"context": r["context"], "original": r["original"], "word": r["word"] if len(r["word"]) else np.zeros(SR // 10, np.float32)}
                while len(rendered) > 40:
                    rendered.pop(next(iter(rendered)))
                return self.send(200, {"rid": rid, "info": r["info"], "start": r["start"], "seconds": round(time.perf_counter() - t, 2)})
            if u.path == "/api/presets":
                path = presets_path(body["id"])
                pr = json.loads(path.read_text()) if path.exists() else {}
                pr[str(body["speaker"])] = body["settings"]
                path.write_text(json.dumps(pr, indent=1))
                return self.send(200, {"ok": True, "presets": pr})
            return self.send(404, {"error": "not found"})
        except Exception as e:
            return self.send(500, {"error": str(e)})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Substitute-swear editor: http://127.0.0.1:{PORT}  (projects in {MEDIA})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
