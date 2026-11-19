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

Speed on an M4 (10 s of audio): small.en 0.67 s on GPU, base.en 0.25 s,
tiny.en 0.2 s on CPU.

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
