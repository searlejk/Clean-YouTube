// Runs Whisper (via transformers.js) on a sliding window of each tab's audio
// and reports every word with its timestamp. Matching against the user's word
// list happens in the content script so list edits apply instantly.
import './settings.js';
import { pipeline, env } from './lib/transformers.min.js';

env.allowLocalModels = false;
// Extension pages can't import blob: URLs, so load the ONNX runtime straight
// from the bundled files instead of letting transformers.js cache it as a blob.
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('./lib/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
  wasm: new URL('./lib/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
};
// The multi-threaded runtime can hang forever while creating a session inside
// a Web Worker (seen with both the WebGPU and CPU backends). One thread costs
// the GPU path nothing; it only makes the CPU fallback slower.
env.backends.onnx.wasm.numThreads = 1;

const SR = 16000;
let windowS = 4; // audio context handed to Whisper on each pass (seconds)
const MIN_NEW_S = 0.25; // don't re-run until at least this much new audio arrived
const MAX_BUFFER_S = 20;
const SILENCE_RMS = 0.003;
const MAX_WORD_S = 1.2;

const sessions = new Map();
let transcriber = null;
let loadedModel = null;
let wantedModel = null;
let loading = false;
let device = null;
let forcedDevice = null; // 'webgpu' | 'wasm' | null (auto)
let running = false;
let currentPass = null; // the transcription in flight, if any
let failures = 0; // consecutive failed passes
let rebuilds = []; // times the model was rebuilt after errors

function status(state, extra = {}) {
  postMessage({ type: 'status', state, model: wantedModel, device, ...extra });
}

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { buf: new Float32Array(MAX_BUFFER_S * SR), len: 0, startIndex: 0, processedUntil: 0 };
    sessions.set(id, s);
  }
  return s;
}

function append(s, samples) {
  const cap = s.buf.length;
  if (samples.length >= cap) {
    s.startIndex += s.len + samples.length - cap;
    s.len = 0;
    samples = samples.subarray(samples.length - cap);
  }
  const overflow = s.len + samples.length - cap;
  if (overflow > 0) {
    s.buf.copyWithin(0, overflow, s.len);
    s.len -= overflow;
    s.startIndex += overflow;
  }
  s.buf.set(samples, s.len);
  s.len += samples.length;
}

async function pickDevice() {
  try {
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) return 'webgpu';
  } catch {
    // fall through to WASM
  }
  return 'wasm';
}

const DTYPES = {
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
};

// transformers.js bug: when word timestamps are requested, generate() runs
// with return_dict_in_generate and hands back the decoder's key/value cache
// without disposing it. On WebGPU that cache lives in GPU buffers, so every
// pass leaked ~40 MB (≈100 MB/s while a video played). Whisper's own
// generate() never reads it, so free it as soon as the base generate returns.
function patchKvCacheLeak(model) {
  let owner = Object.getPrototypeOf(model);
  while (owner && !Object.hasOwn(owner, 'generate')) owner = Object.getPrototypeOf(owner);
  let base = owner && Object.getPrototypeOf(owner);
  while (base && !Object.hasOwn(base, 'generate')) base = Object.getPrototypeOf(base);
  if (!base || base.generate.__pfPatched) return;
  const original = base.generate;
  base.generate = async function (...args) {
    const out = await original.apply(this, args);
    const cache = out?.past_key_values;
    if (cache && typeof cache.dispose === 'function') {
      await cache.dispose();
      delete out.past_key_values;
    }
    return out;
  };
  base.generate.__pfPatched = true;
}

async function createPipeline(modelId, dev) {
  const files = new Map();
  let lastSent = 0;
  return pipeline('automatic-speech-recognition', modelId, {
    device: dev,
    dtype: DTYPES[dev],
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      const now = performance.now();
      if (now - lastSent < 250) return;
      lastSent = now;
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      status('loading', { progress: total ? loaded / total : 0 });
    },
  });
}

async function ensureModel() {
  if (loading) return;
  loading = true;
  try {
    while (wantedModel && wantedModel !== loadedModel) {
      const key = wantedModel;
      const modelId = PF.MODELS[key]?.id || PF.MODELS[PF.DEFAULTS.model].id;
      if (transcriber) {
        // Stop new passes, and let one that's running finish before freeing its
        // GPU buffers. Disposing mid-pass is what caused "Buffer was unmapped
        // before mapping was resolved".
        const old = transcriber;
        transcriber = null;
        loadedModel = null;
        await currentPass?.catch(() => {});
        try {
          await old.dispose?.();
        } catch (err) {
          console.warn('dispose failed', err);
        }
      }
      device = forcedDevice || device || (await pickDevice());
      status('loading', { progress: 0 });
      let t;
      try {
        t = await createPipeline(modelId, device);
      } catch (err) {
        if (device !== 'webgpu') throw err;
        console.warn('WebGPU load failed, falling back to WASM', err);
        device = 'wasm';
        status('loading', { progress: 0, message: 'WebGPU unavailable, using CPU' });
        t = await createPipeline(modelId, device);
      }
      patchKvCacheLeak(t.model);
      status('loading', { progress: 1, message: 'Warming up…' });
      await t(new Float32Array(SR), { return_timestamps: 'word' });
      transcriber = t;
      loadedModel = key;
    }
    status('ready');
    queueMicrotask(kick);
  } catch (err) {
    console.error(err);
    status('error', { message: String(err?.message || err) });
  } finally {
    loading = false;
  }
}

function rms(a) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / (a.length || 1));
}

function pickSession() {
  let best = null;
  let bestNew = MIN_NEW_S * SR;
  for (const [id, s] of sessions) {
    const fresh = s.startIndex + s.len - s.processedUntil;
    if (fresh >= bestNew) {
      best = id;
      bestNew = fresh;
    }
  }
  return best;
}

async function processSession(id, t) {
  const s = sessions.get(id);
  const end = s.startIndex + s.len;
  const winStart = Math.max(s.startIndex, end - windowS * SR);
  const audio = s.buf.slice(winStart - s.startIndex, s.len);
  s.processedUntil = end;
  if (audio.length < 0.3 * SR) return;

  if (rms(audio) < SILENCE_RMS) {
    postMessage({ type: 'words', session: id, words: [], windowEnd: end / SR, processingMs: 0 });
    return;
  }

  const t0 = performance.now();
  const out = await t(audio, { return_timestamps: 'word' });
  const processingMs = performance.now() - t0;
  if (!sessions.has(id)) return;

  const words = wordsFrom(out, winStart / SR, audio.length / SR);
  postMessage({ type: 'words', session: id, words, windowEnd: end / SR, processingMs, text: out.text });
}

// Whisper pads input to 30 s, so the last word's end can drift far past the
// real audio. Clamp to the window and to a sane single-word length.
function wordsFrom(out, base, len) {
  return (out.chunks || [])
    .filter((c) => c.timestamp && c.timestamp[0] != null && c.timestamp[0] < len)
    .map((c) => {
      const start = c.timestamp[0];
      let end = Math.min(c.timestamp[1] ?? start + 0.4, len);
      if (end - start > MAX_WORD_S) end = start + MAX_WORD_S;
      if (end <= start) end = start + 0.2;
      return { text: c.text, start: base + start, end: base + end };
    });
}

// Lookahead mode (roadmap step 1.4): transcribe an exact stretch of decoded
// audio and reply with its words. Requests are served before streaming
// sessions, in the order they arrive.
const jobs = [];

async function processJob(job, t) {
  const t0 = performance.now();
  const out = await t(job.samples, { return_timestamps: 'word' });
  const words = wordsFrom(out, job.offset, job.samples.length / SR);
  postMessage({ type: 'transcribed', id: job.id, words, text: out.text, processingMs: performance.now() - t0 });
}

function kick() {
  if (running || !transcriber || loading) return;
  running = true;
  (async () => {
    try {
      let id;
      while (transcriber && !loading && (jobs.length || (id = pickSession()) != null)) {
        const job = jobs.length ? jobs.shift() : null;
        currentPass = job ? processJob(job, transcriber) : processSession(id, transcriber);
        try {
          await currentPass;
          if (failures) {
            failures = 0;
            status('ready');
          }
        } catch (err) {
          if (job) postMessage({ type: 'transcribed', id: job.id, error: String(err?.message || err) });
          await recover(err);
        }
      }
    } finally {
      currentPass = null;
      running = false;
    }
  })();
}

// A failed pass (GPU hiccup, lost device, driver reset…) shouldn't stop the
// filter. Retry once; if it keeps failing, rebuild the model; if rebuilding
// keeps failing on the GPU, fall back to the CPU.
async function recover(err) {
  failures++;
  console.warn(`Transcription failed (${failures} in a row)`, err);
  if (failures < 2) {
    await new Promise((r) => setTimeout(r, 300));
    return;
  }
  const now = Date.now();
  rebuilds = rebuilds.filter((t) => now - t < 5 * 60 * 1000);
  rebuilds.push(now);
  if (rebuilds.length >= 3 && device === 'webgpu' && !forcedDevice) {
    device = 'wasm';
    rebuilds = [];
    status('loading', { progress: 0, message: 'GPU keeps failing – switching to CPU (slower)' });
  } else {
    status('loading', { progress: 1, message: 'Restarting speech engine…' });
  }
  failures = 0;
  loadedModel = null; // ensureModel() rebuilds the pipeline
  ensureModel();
}

onmessage = ({ data }) => {
  switch (data.type) {
    case 'config':
      getSession(data.session);
      if (data.device !== undefined && (data.device || null) !== forcedDevice) {
        forcedDevice = data.device || null;
        device = null;
        loadedModel = null; // force a reload on the new device
      }
      if (data.windowS) windowS = data.windowS;
      if (data.model) wantedModel = data.model;
      if (wantedModel !== loadedModel) ensureModel();
      else if (transcriber) status('ready');
      break;
    case 'audio': {
      append(getSession(data.session), data.samples);
      kick();
      break;
    }
    case 'reset': {
      const s = getSession(data.session);
      s.startIndex += s.len;
      s.len = 0;
      s.processedUntil = s.startIndex;
      break;
    }
    case 'close':
      sessions.delete(data.session);
      break;
    case 'transcribe':
      // { id, samples: Float32Array (16 kHz), offset: media time of samples[0] }
      jobs.push({ id: data.id, samples: data.samples, offset: data.offset || 0 });
      kick();
      break;
  }
};
