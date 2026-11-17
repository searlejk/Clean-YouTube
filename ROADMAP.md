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
- [ ] **1.4 Transcribe ahead of the playhead.** Queue decoded audio by media
      time; Whisper works through it nearest-first; results are stored as a
      per-video timeline of words.
      *Done when:* the transcript stays ≥ 5 s ahead of playback for a 10-minute
      video on Tiny.
- [ ] **1.5 Zero-delay playback when ahead.** If the timeline already covers
      the next few seconds, play with no delay and schedule mutes against
      `currentTime`. Fall back to the existing delay line only when it doesn't
      (just after a seek, live streams, DRM).
      *Done when:* steady-state delay is 0 s and no swear is heard in the test set.
- [ ] **1.6 Transcript cache per video.** Save the word timeline by video ID
      (IndexedDB) so rewatching and seeking back are instant.
      *Done when:* a second viewing starts with 0 s delay from the first frame.
- [ ] **1.7 Fallbacks and edge cases.** Live streams, ads, Shorts, DRM videos,
      playback-speed changes, background tabs.
      *Done when:* each case either works with lookahead or falls back cleanly
      to the delay line, with the status label saying which.

---

## 2. Audio in (`yt-dlp → ffmpeg, 16 kHz`)

The diagram's entry point. In the extension, step 1's lookahead capture plays
this role. `yt-dlp` only comes into play if we add a local companion app
(decision 2.1).

- [ ] **2.1 Architecture decision: browser-only vs. browser + local companion
      app.** WhisperX, pyannote, F5-TTS/XTTS and MDX-Net are Python/PyTorch
      tools; some have ONNX ports that could run in the browser, others don't.
      Write down which steps run where.
      *Done when:* a short decision note is in the repo.
- [ ] 2.2 (If companion) Extension ↔ companion link (localhost WebSocket or
      Chrome native messaging); audio in, words out.
- [ ] 2.3 (If companion) `yt-dlp → ffmpeg` 16 kHz mono stream for a video ID,
      for personal use only (note YouTube's terms).

## 3. Delay buffer (2–3 s lookahead)

- [x] 3.1 Delay line for audio and video
- [x] 3.2 Automatic, per-computer delay
- [ ] 3.3 Shrinks to 0 when step 1's lookahead covers playback

## 4. Source separation (MDX-Net small / Spleeter)

- [ ] 4.1 Pick a model with an ONNX build (UVR MDX-Net small / Spleeter
      2-stem); measure speed on WebGPU vs. companion.
      *Done when:* separating 10 s of audio takes < 1 s on this Mac.
- [ ] 4.2 Run it on the lookahead audio; produce vocal and background stems.
- [ ] 4.3 Feed the vocal stem to ASR; check that transcription improves on
      videos with music (word error rate on 5 test clips).
- [ ] 4.4 Keep both stems time-aligned for the mixer (step 12).

## 5. WhisperX ASR + Silero VAD → alignment (word timings)

- [ ] 5.1 Silero VAD (ONNX) to skip silence and cut audio at pauses rather
      than mid-word.
- [ ] 5.2 Forced alignment with a wav2vec2 CTC model (the WhisperX approach)
      to replace the hand-measured timestamp lag.
      *Done when:* word starts land within ±50 ms on the waveform-labelled
      test clips, for every model size.
- [ ] 5.3 Shrink the "word cover" padding once timings are accurate.
- [ ] 5.4 Decide WhisperX proper (companion) vs. an in-browser equivalent
      (Whisper + wav2vec2 ONNX).

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
      e.g. pyannote via the companion app, or a small ONNX embedding model in
      the browser).
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
      or any TTS + an RVC voice converter; prefer ONNX/WebGPU-capable ones.
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
- [ ] 13.3 With step 1 done: no visible delay in steady state

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
