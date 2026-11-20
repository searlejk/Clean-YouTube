"""IndexTTS2 in its own process and Python environment (companion/.venv-indextts),
so its pinned libraries don't clash with the companion's.

IndexTTS2 (Bilibili, vendor/index-tts) speaks text with the voice of one clip
(speaker prompt) and the emotion/delivery of another (emotion prompt). The
editor uses it to restyle an OmniVoice line: voice = what OmniVoice made,
emotion = the original sentence with the swear in it.

Talks JSON lines on stdin/stdout:
    {"spk": "a.wav", "emo": "b.wav", "text": "...", "emo_alpha": 0.6, "out": "c.wav"}
 -> {"ok": true, "seconds": 2.1}   or   {"ok": false, "error": "..."}
Lines starting with "{" on stdout are replies; everything else IndexTTS2
prints goes to stderr.
"""
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "vendor" / "index-tts"
CK = ROOT / "checkpoints"


def main():
    reply = sys.stdout
    sys.stdout = sys.stderr  # IndexTTS2's own prints must not mix with replies
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))
    from indextts.infer_v2 import IndexTTS2

    aux = {
        "w2v_bert": str(CK / "aux" / "w2v-bert-2.0"),
        "semantic_codec": str(CK / "aux" / "maskgct" / "semantic_codec" / "model.safetensors"),
        "campplus": str(CK / "aux" / "campplus" / "campplus_cn_common.bin"),
        "bigvgan": str(CK / "aux" / "bigvgan"),
    }
    tts = IndexTTS2(cfg_path=str(CK / "config.yaml"), model_dir=str(CK), use_fp16=True, use_qwen_emo=False, aux_paths=aux)
    reply.write(json.dumps({"ready": True, "device": str(tts.device)}) + "\n")
    reply.flush()
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            q = json.loads(line)
            t = time.perf_counter()
            tts.infer(spk_audio_prompt=q["spk"], text=q["text"], output_path=q["out"], emo_audio_prompt=q.get("emo"),
                      emo_alpha=float(q.get("emo_alpha", 0.6)), verbose=False,
                      num_beams=int(q.get("beams", 1)))  # 3 (its default) is ~3x slower on the Mac
            out = {"ok": True, "seconds": round(time.perf_counter() - t, 2)}
        except Exception as e:  # keep serving
            out = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        reply.write(json.dumps(out) + "\n")
        reply.flush()


if __name__ == "__main__":
    main()
