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
