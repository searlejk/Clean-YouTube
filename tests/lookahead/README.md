# Lookahead tests (roadmap step 1.2)

`fixtures/clip.webm` is 17.6 s of synthetic speech (macOS `say`) encoded as
WebM/Opus like YouTube's audio. `clip.framemd5` is ffmpeg's list of every
packet's timestamp, size and checksum.

**Demuxer (Node):** feeds the clip in many slice sizes (whole, 1 byte, random)
and after a simulated seek, and checks every packet against ffmpeg.

```bash
node tests/lookahead/test-demuxer.js
```

**Decoder (browser, WebCodecs):** decodes the clip to 16 kHz and
cross-correlates it with ffmpeg's decode. Generate the reference once, serve
the repo root, and open the page:

```bash
ffmpeg -i tests/lookahead/fixtures/clip.webm -ac 1 -ar 16000 -f f32le tests/lookahead/fixtures/ref16k.f32
python3 -m http.server 8000
```

Then open http://localhost:8000/tests/lookahead/decode-test.html. Expected:
`offsetMs: 0`, `correlation` ≈ 0.99, `gapsInTimeline: 0`.

## Step 1.3

**Timeline (Node):** out-of-order writes, coverage, `readyAhead`, eviction.

```bash
node tests/lookahead/test-timeline.js
```

**Media-time mapping (browser):** `mapping-test.html` plays
`fixtures/long.webm` (92 s of synthetic speech) through a MediaSource player
that feeds it the way YouTube does and seeks with abort + restart. The audio is
captured into a Web Audio graph whose output device is "none" with gain 0:
nothing is played. Serve the repo root, open the page, click **Start**, then in
the console:

```js
await T.segment(0, 12, 'start');
await T.segment(45, 12, 'seek past the buffer');
await T.segment(20, 12, 'seek back');
await T.segment(76, 12, 'seek forward');
```

Each segment reports, per word, how far the predicted "heard at" time was from
when it was actually heard. Expected: 0–1 ms for every word.

## Step 1.4

**Scheduler (Node):** no lost or duplicated words across window seams and a
seek; transcript ≥ 5 s ahead in a simulated 2-minute playback.

```bash
node tests/lookahead/test-lookahead-transcriber.js
```

**Transcribe ahead (browser, real Whisper Tiny):** generate the 10-minute
fixture once, serve the repo root, open `transcribe-test.html`, click
**Start**, then run `R.run()` in the console and `R.summary()` after it ends
(10 minutes; add `?rate=2` for double speed). The player is muted.

```bash
tests/lookahead/make-ten-minute-fixture.sh
```
