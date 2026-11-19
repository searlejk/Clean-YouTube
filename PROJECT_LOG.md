# Project Log — Clean YouTube

| Date | What | Hours |
|---|---|---|
| 10/29/2026 | Build very rough initial prototype | 5 |
| 11/16/2026 | Set up GitHub repo and project roadmap; confirmed YouTube buffers audio 20–47 s ahead of playback (roadmap step 1.1); built a time tracker | 0.25 |
| 11/17/2026 | Roadmap steps 1.2–1.4: decoded YouTube's buffered audio ahead of playback, mapped it to the moment it's heard (fixed a 9 s timestamp error after seeks), and kept the Whisper transcript 9+ s ahead through a 10-minute video; planned per-speaker voices; fixed the time tracker | 1 |
| 11/17/2026 | Roadmap step 1.5: wired the lookahead into the extension so YouTube plays with no delay; tested on a real YouTube video in Chrome (0 s delay, swears muted ~4.9 s early, skip held 1.8 s) | 0.4 |
| 11/17/2026 | Reviewed what the extension can do so far; roadmap step 1.6: saved transcripts per video so rewatching plays with no delay from the first frame (tested on real YouTube in Chrome: 99.5 s ahead immediately) | 0.8 |
| 11/17/2026 | Roadmap step 1.7 (start): fallbacks for live streams, protected videos and speed changes; status label says which mode is on and why | 0.5 |
| 11/18/2026 | Roadmap step 1.7: tested live streams, Shorts, speed changes and background tabs on real YouTube in Chrome; fixed the live-stream check, the filtered counter and engine reconnects | 0.7 |
| 11/18/2026 | Roadmap step 2.1: decided on a local companion app alongside the extension for the heavy models; wrote the decision note and updated the roadmap | 0.15 |
| 11/18/2026 | Roadmap step 2.2: built the companion app (Whisper small on the Mac GPU over a local WebSocket, with pairing), connected the extension to it with fallback to the built-in model, measured word-timing accuracy; tested on real YouTube in Chrome including quitting and restarting the companion | 0.2 |
| 11/18/2026 | Roadmap step 2.3: companion install script with self-test, start-at-login option, companion status in the popup; the built-in model no longer loads while the companion runs, and live streams use the companion too; tested on real YouTube in Chrome; started a hand-testing checklist | 0.3 |
| 11/18/2026 | Lifetime "words blocked" total and "days profanity free" in the popup; roadmap step 4.1: voice/music separation in the companion (UVR MDX-Net, 10 s of audio in 0.7 s on the Mac GPU), measured speed and quality | 0.2 |
| 11/18/2026 | Roadmap step 4.2: full-quality lookahead audio sent to the companion, which separates voice and background ahead of playback; tested the audio path against ffmpeg and the separation offline and through the companion | 0.25 |
| 11/18/2026 | Roadmap step 4.3: the companion transcribes the separated voice; built a 5-clip test (speech over CC0 music at three loudness levels): every swear found with the voice stem vs 11–13 of 14 from the mix, word errors down from 18% to 11% under loud music | 0.3 |
| 11/18/2026 | Roadmap step 4.4: background clips for each upcoming swear, aligned to the sample for the mixer; built an end-to-end test page (real extension scripts + companion) that found and fixed four problems keeping separation from being used | 0.35 |
| 11/18/2026 | Roadmap step 5.1: voice activity detection in the companion and pause-aware windows in the extension; measured against fixed windows with the real transcriber (no gain, so left off) | 0.5 |
| 11/18/2026 | Roadmap step 5.2: forced alignment of word timings in the companion (wav2vec2, the WhisperX approach); word starts within ±50 ms for 98% of words with every Whisper size, up from 2–32% | 0.2 |
| 11/18/2026 | Roadmap step 5.3: tighter silence around aligned words (60 ms before / 100 ms after instead of 0.25 s each side); every test word still fully silenced, and about 0.16 s muted around each word instead of ~0.8 s | 0.3 |
| 11/18/2026 | Roadmap steps 6–7: built a 1,662-clip swear/look-alike test set (26 voices) and a swear spotter from the alignment model; measured it against Whisper (not accurate enough, so off by default); combined detectors, "never filter" allow-list, and which-detector-caught-it in the popup | 0.6 |
| 11/18/2026 | Roadmap step 8.1: speaker labels for each word (voice-fingerprint model + clustering in the companion); 100% of words right on three two-person test conversations and end to end through the extension | 0.3 |
| **Total** | | **12.3** |
