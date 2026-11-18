# Roadmap

The long-term checklist for Clean YouTube, following the pipeline diagram from
top (audio in) to bottom (player). We work through it one step at a time and
only tick a box once its **Done when** check has passed.

Legend: `[x]` done · `[~]` partly done / stand-in exists · `[ ]` not started

**Testing rule:** test audio never plays through the speakers. Harness pages
route Web Audio to a silent output (`setSinkId({ type: 'none' })`) and confirm
that before pressing play.

---

## Where we are today

The extension already runs a simplified version of the pipeline entirely in the
browser:

```
YouTube <video> ─► delay line ─► Whisper (transformers.js, WebGPU) ─► word list ─► mute/bleep ─► delayed video + audio
```

What it skips compared to the diagram: source separation, WhisperX alignment,
VAD, the keyword spotter, diarization and voice replacement. Its word timings
come from Whisper's own attention-based timestamps plus a hand-measured,
per-model lag correction. Alignment (step 5) is meant to replace that.

---

## 0. Foundation (done)

- [x] Manifest V3 extension: content script, offscreen document, Whisper worker, popup
- [x] Whisper Tiny/Base/Small running locally on WebGPU with a CPU fallback
- [x] Word list with wildcards and phrases; catches pre-censored `f***` forms
- [x] Mute or bleep with fades; whole word covered (measured against waveforms)
- [x] Delayed video via a hardware-compressed frame buffer (a few MB of memory)
- [x] Automatic delay measured per computer; grows if a word is ever late
- [x] Seek/skip and pause work from what's on screen
- [x] Fixed: WebGPU KV-cache leak (~100 MB/s), model-swap race, worker thread hang
- [x] Private GitHub repo

---

## 1. Near-real-time transcription ← **current focus**

Goal: the viewer can't tell the filter is there. Ideally zero playback delay
in steady state, with a short wait only right after a seek. See "Making it
feel real-time" below for the options and why lookahead capture was chosen.

- [x] **1.1 Spike: can we see YouTube's audio before it plays?** Hook
      `MediaSource` / `SourceBuffer.appendBuffer` from a main-world content
      script; log the audio buffer's codec, segment sizes and how far ahead of
      the playhead YouTube buffers.
      *Done when:* a log shows audio segments arriving ≥ 10 s ahead of
      `currentTime` on 3 different videos (including one long video and one
      Short).
      **Result (2026-11-16), probe: [`spikes/mse-probe.js`](spikes/mse-probe.js):**

      | Video | Audio ahead of playhead |
      |---|---|
      | 1:03:30 MIT lecture | 47 s after 25 s of play; **20 s within 1 s** of seeking to 30:00 |
      | 3:33 music video | 34 s at 7.5 s in |
      | 10 s and 35 s Shorts | whole clip buffered within ~70 ms of the first chunk |

      Findings for the next steps:
      - Appends happen in the page's main thread (not an MSE worker), so a
        main-world content script can see them.
      - Audio is always `audio/webm; codecs="opus"` (video was AV1 in MP4).
      - After the first init segment and cluster, YouTube appends **raw byte
        slices** that don't start on WebM element boundaries. 1.2 needs a
        streaming WebM parser that concatenates bytes before demuxing.
      - Each video, ad and Short gets its **own MediaSource and `<video>`**;
        map them via the `blob:` URL from `URL.createObjectURL`. A pre-roll ad
        showed up as a separate MediaSource ahead of the main video, which
        matters for 1.7.
      - Lookahead after a seek is near-instant, so the delay-line fallback
        should only be needed for a second or so.
- [x] **1.2 Decode captured segments to PCM.** WebM/Opus and fMP4/AAC → 16 kHz
      mono (WebCodecs `AudioDecoder` plus a small demuxer, or `decodeAudioData`
      on init + media segments).
      *Done when:* decoded audio for a known 10 s span matches the audio heard
      through the player (cross-correlation offset < 20 ms).
      **Result (2026-11-17):** [`lookahead/webm-opus-demuxer.js`](lookahead/webm-opus-demuxer.js)
      (streaming WebM parser) + [`lookahead/opus-pcm-decoder.js`](lookahead/opus-pcm-decoder.js)
      (WebCodecs Opus → 16 kHz mono, 63-tap low-pass), tests in [`tests/lookahead/`](tests/lookahead/).

      | Check | Result |
      |---|---|
      | Parser vs ffmpeg, 881 packets, slices from 1 byte to whole file | every packet byte-identical, same timestamps |
      | Parser after a simulated seek (reset + jump mid-cluster) | resyncs on the next cluster, all later packets correct |
      | Decoder vs ffmpeg decode | **0.0 ms offset**, correlation 0.99, no gaps |
      | Live YouTube (MIT lecture): 6,000 packets decoded ahead | 0 errors, 0 gaps, 0 resyncs; ~80–100 s ahead of the playhead |
      | Live YouTube: decoded audio vs the player's actual output | loudness envelopes match (r 0.87–1.00 per second, 0.94 overall) at **19 ms** offset |

      Notes:
      - The live offset was measured by capturing the player's output into a
        silent Web Audio graph. On a throttled page that capture loses ~0.7% of
        samples, which makes the instrument itself drift ~±10 ms over 6 s, so
        treat "19 ms" as "within about 10–30 ms". Precise alignment is 1.3.
      - YouTube's Opus streams: stereo, 48 kHz, `timestampOffset` 0, no
        CodecDelay element. Chrome's Opus decoder drops the pre-skip without
        shifting timestamps, so block timestamps are used as-is.
      - An AudioWorklet loaded from a `blob:` URL is blocked by YouTube's CSP
        (the extension loads its worklet from `chrome-extension://` instead).
- [x] **1.3 Media-time mapping.** Map each decoded sample to video time
      (`timestampOffset`, segment timestamps), across seeks and quality switches.
      *Done when:* for words at known positions (measured from the waveform),
      the predicted moment each is heard lands within 50 ms of when it's
      actually heard, after 3 seeks. (Whisper's own timestamp error is step 5.)
      **Result (2026-11-17):** new modules
      [`lookahead/mse-tap.js`](lookahead/mse-tap.js) (hooks a page's player
      buffers → parser → decoder → timeline),
      [`lookahead/pcm-timeline.js`](lookahead/pcm-timeline.js) (decoded audio by
      media time, "how far ahead is ready", eviction) and
      [`lookahead/clock-sync.js`](lookahead/clock-sync.js) (media clock ↔ Web
      Audio clock, self-calibrating the player's fixed offset by matching
      loudness envelopes of decoded vs. captured audio).
      Test: [`tests/lookahead/mapping-test.html`](tests/lookahead/mapping-test.html),
      a MediaSource player that feeds a 92 s speech track the way YouTube does
      (random 8–40 KB slices ~20 s ahead; abort + restart at a cluster on seek),
      captured into a silent Web Audio graph.

      | Segment | Words | Prediction error | Calibration match |
      |---|---|---|---|
      | Start at 0 s | 5 | 0 ms each | r 0.994 |
      | Seek forward to 45 s (past the buffer) | 7 | 0 ms each | r 0.997 |
      | Seek back to 20 s (inside the buffer) | 5 | 0 ms each | r 0.990 |
      | Seek forward to 76 s | 5 | 0 ms each | r 0.988 |

      (Errors are at the test's 1 ms resolution; 6,261 packets, 0 decoder
      errors, 0 gaps.)
      **Bug found and fixed:** Chrome's `AudioDecoder` ignores jumps in input
      timestamps and keeps counting from where it was, so after a seek from
      35.8 s to 45 s every decoded sample was stamped 9.1 s early. The decoder
      now matches each output to its own packet (container timestamp − Opus
      pre-skip + any trimmed start, from the packet's TOC header), counts
      samples while packets are continuous, and fully resets on seek.
      Still to confirm on real YouTube once the extension uses this (1.5): the
      offset measured there in 1.2 was ~19 ms, which self-calibration absorbs.
- [x] **1.4 Transcribe ahead of the playhead.** Queue decoded audio by media
      time; Whisper works through it nearest-first; results are stored as a
      per-video timeline of words.
      *Done when:* the transcript stays ≥ 5 s ahead of playback for a 10-minute
      video on Tiny.
      **Result (2026-11-17):** [`lookahead/lookahead-transcriber.js`](lookahead/lookahead-transcriber.js)
      (always transcribes the first untranscribed stretch at/after the
      playhead, 10 s windows with 1 s of context each side, skips silence,
      reuses earlier work after seeks) and [`lookahead/word-timeline.js`](lookahead/word-timeline.js)
      (words + transcribed stretches by media time); the Whisper worker gained
      an exact-range `transcribe` request.
      Test: [`tests/lookahead/transcribe-test.html`](tests/lookahead/transcribe-test.html),
      10:00 of speech through the YouTube-like player at normal speed, real
      Whisper Tiny on WebGPU:

      | Measure | Result |
      |---|---|
      | Lowest lead before the last 10 s | **9.0 s** (never below 5 s) |
      | Median lead | 15.5 s |
      | Whisper time per 12 s window | 0.89 s (~13× faster than real time) |
      | Transcript reached | the end of the video (600.02 s) |
      | Words transcribed / real words from the script | 1,797 / 98.9% |
      | Decoder | 30,001 packets, 0 errors, 0 gaps |

      The lead is capped by how far ahead the player buffers (20 s in this
      test; YouTube buffered 34–80 s in 1.1–1.2). Node test
      [`test-lookahead-transcriber.js`](tests/lookahead/test-lookahead-transcriber.js)
      also checks that no word is lost or duplicated at window seams or after
      a seek. That bug was found and fixed here: a word right on a seam could
      be timed just outside both windows.
- [x] **1.5 Zero-delay playback when ahead.** If the timeline already covers
      the next few seconds, play with no delay and schedule mutes against
      `currentTime`. Fall back to the existing delay line only when it doesn't
      (just after a seek, live streams, DRM).
      *Done when:* steady-state delay is 0 s and no swear is heard in the test set.
      **Result (2026-11-17):** wired into the extension (v1.1.0):
      [`lookahead/main-bridge.js`](lookahead/main-bridge.js) runs in YouTube's
      page ("world": "MAIN") and streams the decoded buffered audio to the
      content script, which transcribes ahead through the offscreen worker and
      plays with **no delay** when the transcript covers ≥ 3 s ahead
      (real video shown, mutes timed by ClockSync). After a seek it holds
      playback briefly (≤ 4 s, like buffering) until the transcript catches up,
      else falls back to the delay line. A video that starts in delay mode
      (model still loading) switches once by seeking back to what's on screen.
      Popup: "Read ahead – no delay when the transcript is ready" (on by default).

      **Real YouTube, in Chrome with the installed extension** (silent output
      via the `#cleanears-silent-test` hook; a 33-min Kitchen Nightmares clip):

      | Measure | Result |
      |---|---|
      | Delay during playback | **0 s** throughout |
      | Transcript lead | 26–103 s (limited by YouTube's download bursts) |
      | Skip to 10:00 (not yet downloaded) | YouTube had 20 s within 1 s; held 1.8 s, then no delay |
      | Pause, model unloaded while idle, resume | reconnected and continued with no delay |
      | Swears caught (unbleeped: "ass", "pissed", "fucking") | 3, each mute scheduled ~4.9 s early; 0 late, 0 missed |
      | Self-calibration vs the player's real audio | r 0.996–0.998, offset 0 ms |

      Local harness ([`tests/extension/harness.html`](tests/extension/harness.html),
      real content script + bridge, stubbed chrome APIs): 16 swears over a
      start, a model-loading switch and a skip, 0 late, 0 missed. Found and
      fixed there: resuming inside a swear's cover now mutes immediately, and
      the first hold allows 4 s because the first Whisper pass after loading
      is slow.
      Not yet tested: live streams and DRM videos (1.7), ads mid-video.
- [x] **1.6 Transcript cache per video.** Save the word timeline by video ID
      (IndexedDB) so rewatching and seeking back are instant.
      *Done when:* a second viewing starts with 0 s delay from the first frame.
      **Result (2026-11-17, extension v1.2.0):** [`lookahead/transcript-cache.js`](lookahead/transcript-cache.js)
      saves each video's words and transcribed stretches in the extension's
      own storage (`chrome.storage.local`, not the page's IndexedDB, so
      YouTube can't read or clear it), keyed `videoId:model`, about 25 bytes
      per word, capped at 8 MB (~35 h of video) with least-recently-watched
      eviction. Saved every 15 s and when leaving the page; never during ads.
      A video with a saved transcript plays with no delay as soon as the cache
      loads, without waiting for Whisper; Whisper only fills untranscribed
      gaps.

      | Test | Result |
      |---|---|
      | Node: save/load, partial coverage, no clobbering, LRU eviction | pass |
      | Harness, fresh page, second viewing | no delay from media time 0 while Whisper was still loading; 41.6 s ahead at once; mutes ~4.9 s early, 0 late |
      | **Real YouTube in Chrome**, full reload at 11:30 | no delay from the first frame (0.5 s before it while the cache loaded); **99.5 s ahead immediately** vs ~4 s on first viewing; swear muted 4.9 s early |
- [x] **1.7 Fallbacks and edge cases.** Live streams, ads, Shorts, DRM videos,
      playback-speed changes, background tabs.
      *Done when:* each case either works with lookahead or falls back cleanly
      to the delay line, with the status label saying which.
      *Result (v1.3.0, real YouTube in Chrome, player muted):*
      | Case | What happens | Label |
      |---|---|---|
      | Live stream (at or behind the live edge) | delay line, transcribing | "6.0 s delay (live stream)" |
      | Finished live stream (now a recording) | reads ahead, no delay (34 s ahead) | "no delay" |
      | Shorts, and swiping to the next one | reads ahead; next Short back to no delay in 0.4 s, own cache key | "no delay" |
      | Speed 2×, 1.5×, 0.5×, back to 1× | stays no delay; mutes re-timed on each change, still 3.4–4.8 s early | "no delay" |
      | Background tab (45 s hidden) | kept muting 3.5–4.9 s early, 0 missed | "no delay" |
      | Ads | own audio source, so handled like any video; not saved to the cache. No ad appeared during testing | — |
      | DRM (protected) video | skips the read-ahead tap, uses the delay line. Not tested live (needs a paid film) | "delay (protected video)" |
      Fixes found while testing: the "N filtered" count didn't update in no-delay
      mode; a live stream watched behind the live edge wasn't seen as live; a
      stalled engine start could block reconnecting.

---

## 2. Audio in (`yt-dlp → ffmpeg, 16 kHz`)

The diagram's entry point. Step 1's lookahead capture supplies the audio; the
extension sends it to a local companion app that runs the heavy models.

- [x] **2.1 Architecture decision: browser-only vs. browser + local companion
      app.** *Decided 11/18/2026:* extension + local companion app (Python,
      PyTorch on the Mac GPU) for steps 4–6 and 8–11; the extension keeps the
      audio tap, profanity decision, mixer and player. Packaging everything
      into the extension can be revisited once quality is good. See
      [docs/decisions/2.1-companion-app.md](docs/decisions/2.1-companion-app.md).
- [x] **2.2 Extension ↔ companion link.** Localhost-only WebSocket with a
      pairing token (or Chrome native messaging); lookahead audio in, timed
      words out. If the companion isn't running, the extension falls back to
      in-browser Whisper and the label says which is in use.
      *Done when:* a real YouTube video is transcribed by the companion with
      no delay, and quitting the companion mid-video falls back cleanly.
      *Result (v1.4.0, [companion/](companion/)):* Python server
      (faster-whisper small.en on the M4 GPU, 0.67 s per 10 s of audio) on
      `ws://127.0.0.1:47823`. Pairing is by the WebSocket Origin: web pages are
      refused, and the first extension to connect is remembered. The offscreen
      page sends lookahead windows to it and falls back to the in-browser model
      for anything it doesn't answer. Each engine's word-timing bias was
      measured on 61 words of synthetic speech with exact timings, and words
      are stored corrected (transcript cache format 2).
      Real YouTube in Chrome (player muted): "no delay · companion app",
      35–45 s read ahead, swears muted 5.3–5.7 s early. Quitting the companion
      mid-video switched to the in-browser model within ~4 s with no pause or
      delay, and the label dropped "companion app". Restarting it reconnected
      in ~2 s.
- [x] 2.3 Companion setup: one install script (Python environment, model
      downloads), a start command, and a status check in the popup.
      *Result (v1.5.1):* `companion/install.sh` (Python env + model + a
      self-test; from scratch it took 23 s with packages cached and reported
      "small.en on GPU, 467 ms for 10 s of audio"), `companion/start.sh`, and
      `companion/login-item.sh on|off|status` to start it at login (a per-user
      LaunchAgent; not turned on). The popup asks the companion directly
      whether it's running, so it works on any page. While the companion
      runs, the built-in model isn't loaded at all. Delay-mode streaming (live
      streams) goes to the companion too, and the built-in model loads only if
      the companion is off or quits.
      Real YouTube: normal video at no delay via the companion with the
      built-in model never loaded; quitting the companion loaded the built-in
      model in < 1 s and stayed at no delay; a live stream was transcribed by
      the companion (15 windows a minute, per its log). Remaining hand checks
      are in [TESTING.md](TESTING.md).
- [ ] 2.4 (Optional, later) `yt-dlp → ffmpeg` 16 kHz mono stream for a video
      ID, to process a whole video before it plays. Personal use only; off by
      default (against YouTube's terms).

## 3. Delay buffer (2–3 s lookahead)

- [x] 3.1 Delay line for audio and video
- [x] 3.2 Automatic, per-computer delay
- [x] 3.3 Shrinks to 0 when step 1's lookahead covers playback (step 1.5)

## 4. Source separation (MDX-Net small / Spleeter)

- [x] 4.1 Pick a model (UVR MDX-Net small / Demucs / Spleeter 2-stem) for
      the companion; measure speed on this Mac.
      *Done when:* separating 10 s of audio takes < 1 s on this Mac.
      *Result:* **Kim_Vocal_2** (UVR MDX-Net, ONNX, 67 MB) via onnxruntime +
      numpy STFT, no PyTorch ([companion/separation.py](companion/separation.py)).
      10 s of 44.1 kHz stereo audio in **705 ms** on the M4 (CoreML MLProgram,
      batch size fixed to 1 so the whole graph runs in CoreML; left open, 27
      of 173 steps fell back to the CPU and it took 3.2 s; CPU-only 6.8 s).
      UVR-MDX-NET-Voc_FT was the same speed and quality. On speech mixed with
      synthetic music at 0 dB, the vocal stem scored 23.4 dB SDR against the
      clean speech (the mix: 0.4 dB). Whisper already copes with that
      synthetic music (small.en 8.2% word errors on the mix), so the real
      ASR benefit has to be measured on real music in 4.3. Benchmarks:
      `companion/tests/word_timing.py`, `companion/tests/separation_bench.py`.
- [~] 4.2 Run it on the lookahead audio; produce vocal and background stems.
      *Built (v1.7.0), awaiting the hand check on real YouTube in
      [TESTING.md](TESTING.md):* while the companion runs, the page bridge also
      sends the decoded audio at full quality (48 kHz stereo, ~1 s per
      message) through the content script and offscreen page. The companion
      keeps it per video as continuous runs (a seek starts a new one) and
      separates ~10.4 s blocks with 0.5 s of real audio on each side
      ([companion/stems.py](companion/stems.py)), nearest the playhead first,
      on its own thread so transcription never waits. Stems are kept from
      30 s behind the playhead; it reports which stretches are ready.
      Checks: the bridge's full-rate audio matches ffmpeg exactly (92 s, no
      gaps, 0 ms offset, correlation 1.000); offline, 33 s of speech + music
      separated 9× faster than real time with vocal SDR 23.2 dB, voice +
      background = the original (float16 rounding), block seams within 4–6%
      of a one-pass separation; through the companion's WebSocket, a 40 s
      burst was all separated within 4.2 s, and on speech alone the
      background stem was 41 dB quieter than the voice. Debugging:
      `CLEAN_EARS_DUMP_STEMS=dir companion/start.sh` saves 30 s of stems as WAV.
- [x] 4.3 Feed the vocal stem to ASR; check that transcription improves on
      videos with music (word error rate on 5 test clips).
      *Result:* the companion now transcribes the separated voice for any
      stretch that's been separated, else the full mix (`--asr-input mix`
      turns it off). A window more than 12 s ahead of the playhead waits up
      to 8 s for its stretch to be separated; one about to be heard waits at
      most 1 s. Transcriptions run as their own tasks so waiting never holds
      up the incoming audio (a first version deadlocked on that in testing). Test: 5 clips, each about a minute
      of macOS speech with an exact script (5 voices) over a different CC0
      track from Wikimedia Commons, at three music levels
      ([companion/tests/music_asr_bench.py](companion/tests/music_asr_bench.py)),
      Whisper small.en:

      | Music vs voice | Word errors: mix → voice stem | Swears found: mix → voice stem |
      |---|---|---|
      | 5 dB quieter | 1.1% → 1.7% | 13/14 → **14/14** |
      | equal | 5.6% → **2.6%** | 12/14 → **14/14** |
      | 5 dB louder | 18.1% → **11.4%** | 11/14 → **14/14** |

      The voice stem found every swear at every level. Word errors are a
      little higher with quiet music (separation adds slight artifacts), much
      lower when music is loud. Synthetic voices are cleaner than real ones;
      the real-video check is in [TESTING.md](TESTING.md).
- [x] 4.4 Keep both stems time-aligned for the mixer (step 12).
      *Result (v1.9.0):* for each swear it schedules, the extension asks the
      companion for the separated background (music/effects without the
      voice) for that stretch plus 50 ms each side, and keeps it as an
      AudioBuffer whose first sample is at a known media time, so the mixer
      can play it in place of the muted mix using the same clock mapping as
      the mutes. Offline: clips start exactly where asked (to the sample) and
      voice + background equal the original with 0 samples of offset,
      including across block edges. End to end in a test page running the
      real page bridge, content script and offscreen page against a test
      companion ([tests/extension/harness-companion.html](tests/extension/harness-companion.html)):
      9/9 clips ready 5.0–5.6 s before their swear played, and a built-in
      check put each clip at **0 ms** from the audio the transcript came from
      (correlation ≥ 0.997). That test also found and fixed four problems:
      the "separation available" flag was dropped on its way to the tab (so
      4.2 and 4.3 would never have turned on), transcription gave up on its
      voice stem when the full-quality audio arrived a moment late, waited
      too little for windows ~10 s ahead (now waits up to "seconds until it
      plays − 7"), and the first ~27 s of each video were never separated
      (the page bridge now keeps what it has decoded ahead and sends it when
      the companion starts listening). After the fixes every window except
      the very first used the separated voice.

## 5. WhisperX ASR + Silero VAD → alignment (word timings)

- [~] 5.1 Silero VAD (ONNX) to skip silence and cut audio at pauses rather
      than mid-word.
      *Built and measured; pause cuts left off.* The companion runs Silero
      VAD (bundled with faster-whisper) on each separated voice block and
      reports speech stretches with the stems; on the exact-timing test
      speech none of its 14 pauses fell inside a word. The transcriber can end
      each window in the pause nearest 10 s (5–12 s) and skip stretches with
      no speech (`speech` option, `PAUSE_CUTS` in content.js). Measured with
      the real JS transcriber against the companion on the 10 music mixes
      ([companion/tests/vad_windowing_eval.js](companion/tests/vad_windowing_eval.js)):
      fixed 10 s windows with 1 s overlap 6.1% word errors, 27/28 swears;
      pause cuts 7.9%, 26/28, and slightly more Whisper work (no silent
      stretches to skip in these clips). The overlap already protects words
      at window edges, so pause cuts stay off. Worth re-testing on real
      videos with long silences, where skipping could save work.
- [x] 5.2 Forced alignment with a wav2vec2 CTC model (the WhisperX approach)
      to replace the hand-measured timestamp lag.
      *Done when:* word starts land within ±50 ms on the waveform-labelled
      test clips, for every model size.
      *Result:* [companion/align.py](companion/align.py) runs
      wav2vec2-base-960h (the model WhisperX uses for English; ONNX, 378 MB,
      no PyTorch) and a numpy Viterbi CTC alignment on each window's audio
      (the separated voice when available), then moves each edge to where
      the word's sound begins/fades in the loudness envelope (CTC fires a
      letter at its peak, so vowel-first words came out ~150 ms late before
      this). On the exact-timing speech, word starts: median 5 ms off, 95%
      within 20 ms, **98.4% within ±50 ms for tiny, base and small alike**
      (the one miss is a transcription error); with real music under it,
      through separation, 96.7–98.3%. Before: 1.6–31.7% within ±50 ms. Ends
      land −28…+7 ms (5–95%). Costs ~0.7 s per 12 s window on the CPU
      (CoreML can't take the model's variable length). The companion now
      aligns every window; the extension applies its old per-model lag only
      to words that couldn't be aligned. `--no-align` turns it off.
      Tests: `companion/tests/alignment_accuracy.py`.
- [ ] 5.3 Shrink the "word cover" padding once timings are accurate.
- [x] 5.4 Decide WhisperX proper (companion) vs. an in-browser equivalent
      (Whisper + wav2vec2 ONNX). *Decided in 2.1: WhisperX in the companion.*

## 6. Keyword-spotting model (swear words)

- [ ] 6.1 Build a labelled dataset: swear-word clips plus near-miss words
      ("ship", "duck", "witch"), from many voices.
- [ ] 6.2 Train a small model (log-mel + small CNN/CRNN), export to ONNX.
- [ ] 6.3 Run it on the vocal stem in parallel with ASR.
      *Done when:* recall ≥ 95% on the test set, with a measured false-positive
      rate.

## 7. Profanity decision (word list + KWS score)

- [x] 7.1 Word list with wildcards, phrases, pre-censored forms
- [ ] 7.2 Combine: cut if either detector is confident; extra-sure if both
- [ ] 7.3 Per-word confidence shown in the popup's "recently caught" list
- [ ] 7.4 Allow-list for false positives (e.g. "Dick Van Dyke")

## 8. Diarization (who's speaking)

Needed so that in a podcast or interview, a swear by speaker B is replaced in
**B's** voice, never in speaker A's.

- [ ] 8.1 Label each word with a speaker (speaker embeddings + clustering,
      pyannote in the companion app).
      *Done when:* on a 2-person interview, ≥ 95% of words get the right speaker.
- [ ] 8.2 Stable identities: the same person keeps the same label for the
      whole video, including after pauses, seeks, and when someone returns
      after a long gap.

## 9. Voice sample (10–30 s clip per speaker)

- [ ] 9.1 Automatically collect 10–30 s of clean, swear-free speech for each
      speaker from the vocal stem
- [ ] 9.2 Quality checks: no overlap, no music bleed, enough length

## 10. Voice clone (small model, one voice profile per speaker)

- [ ] 10.1 Pick a **small** voice-cloning model that runs on a normal laptop
      without overwhelming it. Candidates: F5-TTS small, XTTS-v2, OpenVoice,
      or any TTS + an RVC voice converter, run in the companion.
      Write down download size, memory use, and speed on this Mac.
      *Done when:* one placeholder word in a sampled voice generates in
      under 1 s, using under ~1 GB of memory.
- [ ] 10.2 One shared model, one profile per speaker: each speaker gets their
      own voice sample/embedding, not a separate full model. Cap at a few
      voices (e.g. 4) to protect the user's computer.
- [ ] 10.3 Generate placeholder words ("shoot", "fudge", …) once per speaker
      and cache them
- [ ] 10.4 Measure generation time; this has to finish within the lookahead
- [ ] 10.5 Personal viewing only; no export or sharing of cloned audio

## 11. Fit to gap (time-stretch)

- [ ] 11.1 Stretch or compress the cached word to the swear's exact length
      (WSOLA / phase vocoder), keeping pitch
- [ ] 11.2 Match loudness to the surrounding speech

## 12. Mixer (mute or swap vocals, crossfade, add background back)

- [x] 12.1 Mute / bleep the full mix with fades (current version)
- [ ] 12.2 Mute only the vocal stem so music keeps playing
- [ ] 12.3 Swap in the replacement word with crossfades, using the cached
      word **of the speaker who said the swear** (step 8's label)
- [ ] 12.4 When unsure, don't guess: if the speaker is uncertain, voices
      overlap, or a new speaker has no profile yet, fall back to silence or a
      bleep rather than risk the wrong voice.
      *Done when:* on 3 multi-speaker test videos, no swear is replaced in the
      wrong person's voice.
- [ ] 12.5 Mode setting: silence / bleep / replacement word

## 13. Player (delayed video + clean audio)

- [x] 13.1 Delayed video canvas in sync with the filtered audio
- [x] 13.2 Pause, seek and skip relative to what's on screen
- [x] 13.3 With step 1 done: no visible delay in steady state (step 1.5)

---

## Making it feel real-time (step 1 design notes)

| Idea | How it works | Delay the viewer sees | Verdict |
|---|---|---|---|
| **A. Delay line** (today) | Hold audio and video back a couple of seconds while Whisper listens ahead | ~1.5–3 s always, plus a wait after every seek | Works today; the safety net |
| **B. Lookahead capture** | Read the audio YouTube has already downloaded (via `SourceBuffer.appendBuffer`), usually 10 s to minutes ahead, and transcribe it before it plays | 0 s in steady state; short wait only right after a seek into unbuffered video | **Chosen** |
| C. Shadow player | A second hidden, muted player runs ahead (e.g. at 2×) and its audio is transcribed | 0 s once ahead | Doubles bandwidth and decoding; ads and YouTube limits make it fragile |
| D. Companion app + `yt-dlp` | Download the full audio and transcribe the whole video in the background (10 min in < 1 min on a GPU) | 0 s after the first few seconds | Very robust, and needed later for WhisperX/voice cloning; needs a separate app and runs against YouTube's terms |
| E. Transcript cache | Save every transcript by video ID | 0 s on rewatch | Cheap add-on to any of the above |

**Plan:** B for steady state, A as the automatic fallback, E on top. D stays
on the table for the heavier models in steps 4–10.
