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
| **Total** | | **8.65** |
