# Clean Ears companion app

Runs the speech model on your Mac instead of inside Chrome (roadmap step 2.2;
why: [docs/decisions/2.1-companion-app.md](../docs/decisions/2.1-companion-app.md)).
While it's running, the extension sends it the audio it reads ahead and gets
back timed words. If it isn't running, the extension uses its built-in model.

```sh
companion/install.sh               # once: Python env, model download, self-test
companion/start.sh                 # Whisper small on the Mac GPU (default)
companion/start.sh --model base.en # faster, a little less accurate
companion/login-item.sh on         # start automatically at login (off: undo)
```

The popup's "Companion app" section shows whether it's running. While it runs
the extension doesn't load its built-in model at all; if it quits, the
built-in model loads and takes over.

- Listens only on `127.0.0.1:47823`, never the network.
- Only a Chrome extension can connect, and the first one to connect is
  remembered (pairing). To pair a different copy: `companion/start.sh --reset-pairing`.
- Settings live in `~/Library/Application Support/CleanEars/companion.json`.
- **What it stores on this Mac:** for each video watched with the companion,
  the speakers' voice profiles (`speakers/`, a few KB) and short clean voice
  samples of each person (`voices/<video>/speaker<N>.wav`), used to replace
  swears in that person's voice (roadmap steps 8–10). Nothing is uploaded or
  shared. Delete the `speakers` and `voices` folders in
  `~/Library/Application Support/CleanEars/` at any time to remove them.

Speed on an M4 (10 s of audio): small.en 0.67 s on GPU, base.en 0.25 s,
tiny.en 0.2 s on CPU.

## Substitute-swear editor

Work on a downloaded video offline and tweak how each substitute swear sounds
in the speaker's voice (personal use only; downloading is against YouTube's
terms otherwise):

```sh
companion/.venv/bin/yt-dlp -f bestaudio -o "media/%(id)s.%(ext)s" "https://www.youtube.com/watch?v=VIDEO_ID"
companion/.venv/bin/python companion/offline.py media/VIDEO_ID.webm   # ~2½ min for a 9-min video
companion/.venv/bin/python companion/editor_server.py                 # then open http://127.0.0.1:47824
```

Per swear: play the original and the substitute in context; switch on/off
and adjust the voice reference (length or hand-picked stretches of their
speech), pitch, tone match, loudness, quality (steps) and timing; change the
word; Regenerate; save settings per speaker (`media/<id>/presets.json`).

## Starting automatically

`companion/native-host.sh install` lets the extension start the companion
when you play YouTube (Chrome native messaging; the launcher is copied to
`~/Library/Application Support/CleanEars/` because macOS won't let Chrome
run programs from Desktop/Documents/Downloads). Started that way it quits
after 15 minutes with no YouTube playing. `companion/native-host.sh uninstall`
undoes it.

## Development

- `companion/server.py --allow-local-test-pages` also accepts the extension's
  test pages served from 127.0.0.1 (for `tests/extension/harness-companion.html`).
- `CLEAN_EARS_DEBUG=1` logs, for every transcription window, whether it used
  the separated voice and why not.
- Tests: `tests/word_timing.py`, `tests/separation_bench.py`,
  `tests/test_stems.py`, `tests/test_stem_clips.py`, `tests/music_asr_bench.py`,
  `tests/vad_windowing_eval.js`, `tests/alignment_accuracy.py`,
  `tests/cover_check.py`, `tests/kws_dataset.py`, `tests/kws_eval.py`,
  `tests/interview_dataset.py`, `tests/diarization_accuracy.py`.

Models (in `companion/models`, downloaded by `install.sh`): Kim_Vocal_2
(voice separation, 67 MB), wav2vec2-base-960h (word alignment, 378 MB) and
WeSpeaker ResNet34 (who's speaking, 27 MB);
the Whisper models go to the Hugging Face cache.

## IndexTTS2 (editor only, optional)

The editor's "+ IndexTTS2 emotion" voice model re-says the sentence around a
swear in the OmniVoice voice with the original line's emotion
(`index_tts_worker.py`). It runs in its own environment because its libraries
are pinned differently:

```bash
git clone --depth 1 https://github.com/index-tts/index-tts.git companion/vendor/index-tts
python3.11 -m venv companion/.venv-indextts
companion/.venv-indextts/bin/pip install "torch==2.8.*" "torchaudio==2.8.*" "transformers==4.52.1" "tokenizers==0.21.0" "accelerate==1.8.1" "librosa==0.10.2.post1" "numpy==2.2.6" "numba==0.63.0" "safetensors==0.5.2" einops omegaconf sentencepiece "g2p-en==2.1.0" "json5==0.10.0" munch "descript-audiotools==0.7.2" "cn2an==0.5.22" "jieba==0.42.1" wetext textstat "ffmpeg-python==0.2.0" huggingface_hub soundfile matplotlib tqdm openai-whisper "modelscope==1.27.0" "pandas==2.3.2"
companion/.venv-indextts/bin/pip install --no-deps -e companion/vendor/index-tts
```

Model files (~7.1 GB) go in `companion/vendor/index-tts/checkpoints/`:
IndexTeam/IndexTTS-2 (all but the `qwen0.6bemo4-merge` folder), and in
`checkpoints/aux/`: `w2v-bert-2.0` (facebook/w2v-bert-2.0: config,
preprocessor config, model.safetensors), `maskgct/semantic_codec`
(amphion/MaskGCT), `campplus` (funasr/campplus), `bigvgan`
(nvidia/bigvgan_v2_22khz_80band_256x: config, generator). On the M4 it takes
~12 s a sentence in half precision with one beam (after ~40 s to load).
