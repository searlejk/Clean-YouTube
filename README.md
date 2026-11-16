# Clean YouTube (Clean Ears)

A Chrome extension that removes profanity from YouTube videos as they play. It
doesn't use YouTube's captions. Instead it holds the video back a moment,
transcribes the audio locally with OpenAI's Whisper model, and bleeps or
silences the words you choose before you hear them. Everything runs on your
computer; no audio leaves the browser.

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Open or refresh a YouTube video. The first run downloads the speech model
   (about 120 MB for the default Tiny model); after that it loads from cache.

## Settings (toolbar icon)

| Setting | What it does |
|---|---|
| **Bleep / Silence** | Plays a tone over caught words, or mutes them. |
| **Delay → Automatic** | Measures how fast Whisper runs on this computer and holds the video back only as long as needed. Untick to set a fixed delay. |
| **Word cover** | Extra silence before and after each caught word. |
| **Speech model** | Tiny (default, fastest), Base (more accurate, tighter cuts, slower) or Small. |
| **Words to filter** | One per line. `*` is a wildcard (`*fuck*`, `shit*`); phrases with spaces work. |
| **Mute until ready** | Keeps the sound off until the model has loaded. |

## How it works

```
<video> ─► Web Audio ─┬─► DelayNode (delay) ─► mute / bleep ─► speakers
                      └─► capture worklet ─► 16 kHz ─► Whisper (offscreen worker) ─► word timestamps
```

- **Audio** is routed through a Web Audio graph. A delay line holds it back while
  a worklet sends the undelayed audio to Whisper.
- **Video** is hidden behind a canvas that shows frames from the same delay
  ago. Frames are compressed with the hardware video encoder while they wait,
  so the buffer stays at a few MB.
- **Whisper** runs via [transformers.js](https://github.com/huggingface/transformers.js)
  (WebGPU, with a CPU fallback) in an offscreen document's worker, on a sliding
  window of audio, using the `onnx-community/whisper-*.en_timestamped` models.
- **Timing:** Whisper's word timestamps run late by a model-specific amount, so
  each caught word is shifted earlier and padded so no part of it is heard.
- **Seeking and pausing** work from what's on screen rather than from the real
  (ahead) playhead, and the model unloads when nothing has played for a few
  minutes.

## Files

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 |
| `background.js` | Creates the offscreen document; seeds and migrates settings |
| `offscreen.html/js` | Bridges tab connections to the Whisper worker |
| `whisper-worker.js` | Loads Whisper, transcribes with word timestamps, recovers from GPU errors |
| `content.js/css` | Audio delay graph, delayed-video canvas, mute/bleep scheduling, automatic delay, status label |
| `capture-worklet.js` | Taps the audio before the delay |
| `filter.js` | Word-list and wildcard matching |
| `settings.js` | Defaults, word list, model list |
| `popup.html/css/js` | Settings and live status |
| `lib/` | Bundled transformers.js 4.3.1 (Apache-2.0) and ONNX Runtime Web WASM (MIT) |
