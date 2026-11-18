const $ = (id) => document.getElementById(id);
const storage = chrome.storage.sync;

function parseWords(text) {
  return text
    .split(/[\n,]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function save(patch) {
  storage.set(patch);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function render(s) {
  $('enabled').checked = s.enabled;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === s.mode;
  $('volume-row').style.display = s.mode === 'bleep' ? '' : 'none';
  $('bleepVolume').value = s.bleepVolume;
  $('lookahead').checked = s.lookahead;
  $('autoDelay').checked = s.autoDelay;
  $('delay').value = s.delay;
  $('delay').disabled = s.autoDelay;
  if (!s.autoDelay) $('delay-value').textContent = `${Number(s.delay).toFixed(1)} s`;
  else if (!liveDelay) $('delay-value').textContent = 'Auto';
  $('delay-hint').textContent = s.autoDelay
    ? 'Measures how fast Whisper runs here and holds the video back only as long as needed. It grows if a word is ever caught late.'
    : 'How far behind the video plays, giving Whisper time to listen ahead. Raise it if words slip through.';
  $('cover').value = s.cover;
  $('cover-value').textContent = `${Number(s.cover).toFixed(2)} s`;
  $('model').value = s.model;
  if (document.activeElement !== $('words')) $('words').value = s.words.join('\n');
  $('muteUntilReady').checked = s.muteUntilReady;
  $('showBadge').checked = s.showBadge;
}

async function init() {
  for (const [key, m] of Object.entries(PF.MODELS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = m.label;
    $('model').appendChild(opt);
  }

  let s = await storage.get(PF.DEFAULTS);
  render(s);

  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener('change', () => {
      save({ mode: r.value });
      $('volume-row').style.display = r.value === 'bleep' ? '' : 'none';
    });
  }
  $('bleepVolume').addEventListener('change', (e) => save({ bleepVolume: Number(e.target.value) }));
  $('delay').addEventListener('input', (e) => {
    $('delay-value').textContent = `${Number(e.target.value).toFixed(1)} s`;
  });
  $('delay').addEventListener('change', (e) => save({ delay: Number(e.target.value) }));
  $('autoDelay').addEventListener('change', (e) => save({ autoDelay: e.target.checked }));
  $('lookahead').addEventListener('change', (e) => save({ lookahead: e.target.checked }));
  $('cover').addEventListener('input', (e) => {
    $('cover-value').textContent = `${Number(e.target.value).toFixed(2)} s`;
  });
  $('cover').addEventListener('change', (e) => save({ cover: Number(e.target.value) }));
  $('model').addEventListener('change', (e) => save({ model: e.target.value }));
  $('words').addEventListener(
    'input',
    debounce((e) => save({ words: parseWords(e.target.value) }), 400)
  );
  $('reset-words').addEventListener('click', () => {
    $('words').value = PF.DEFAULT_WORDS.join('\n');
    save({ words: PF.DEFAULT_WORDS });
  });
  $('muteUntilReady').addEventListener('change', (e) => save({ muteUntilReady: e.target.checked }));
  $('showBadge').addEventListener('change', (e) => save({ showBadge: e.target.checked }));

  chrome.storage.onChanged.addListener(async (_c, area) => {
    if (area !== 'sync') return;
    s = await storage.get(PF.DEFAULTS);
    render(s);
  });

  pollStatus();
  setInterval(pollStatus, 1000);
}

let liveDelay = null;

function setStatus(kind, text, detail = '') {
  $('status-dot').className = 'dot ' + kind;
  $('status-text').textContent = text;
  $('status-detail').textContent = detail;
}

async function pollStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let st = null;
  try {
    st = await chrome.tabs.sendMessage(tab.id, { type: 'pf:getStatus' });
  } catch {
    // Not a YouTube tab, or the page was open before the extension loaded.
  }

  const recent = $('recent');
  recent.replaceChildren();

  if (!st) {
    setStatus('', 'Open a YouTube video', 'If a video is already open, reload the page once.');
    return;
  }
  if (st.mode === 'lookahead') {
    liveDelay = 0;
    $('delay-value').textContent = 'None · reading ahead';
  } else if (st.autoDelay && st.delay) {
    liveDelay = st.delay;
    $('delay-value').textContent = `Auto · ${st.delay.toFixed(1)} s` + (st.fallbackReason ? ` (${st.fallbackReason})` : '');
  }
  if (!st.enabled) return setStatus('', 'Filter is off');
  if (!st.videos) return setStatus('', 'Waiting for a video…');
  if (st.audio === 'suspended') return setStatus('warn', 'Click the video to turn sound on');

  const device = st.device === 'webgpu' ? 'GPU (WebGPU)' : st.device === 'wasm' ? 'CPU (WASM)' : '';
  switch (st.engine) {
    case 'loading':
      setStatus('warn', st.message || `Loading speech model… ${Math.round((st.progress || 0) * 100)}%`, 'First run downloads the model; later runs load from cache.');
      return;
    case 'error':
      setStatus('err', 'Speech engine error', st.message);
      return;
    case 'ready':
      break;
    default:
      setStatus('warn', 'Starting speech engine…');
      return;
  }

  const c = st.companion;
  const companion =
    c?.state === 'ready'
      ? `Companion app · ${PF.COMPANION_MODELS[c.model]?.label || c.model}${c.device === 'mps' ? ' on GPU' : c.device ? ' on CPU' : ''}`
      : c?.state === 'loading'
        ? 'Companion app loading…'
        : '';
  const parts = [companion || device];
  if (st.processingMs) parts.push(`${Math.round(st.processingMs)} ms per pass`);
  if (st.headroom != null) parts.push(`${Math.max(0, st.headroom).toFixed(1)} s headroom`);
  if (st.missed) parts.push(`${st.missed} caught too late`);
  const behind = st.headroom != null && st.headroom < 0.25;
  setStatus(
    behind ? 'warn' : 'ok',
    behind ? 'Falling behind – raise the delay or use a smaller model' : `Filtering · ${st.caught} word${st.caught === 1 ? '' : 's'} caught`,
    parts.filter(Boolean).join(' · ')
  );

  for (const r of st.recent.slice(0, 8)) {
    const li = document.createElement('li');
    li.textContent = mask(r.word);
    li.title = `Matched “${r.rule}”` + (r.late ? ' (partly late)' : '');
    if (r.late) li.classList.add('late');
    recent.appendChild(li);
  }
}

// Show caught words without spelling them out: "f******".
function mask(word) {
  const w = word.replace(/[^\p{L}\p{N}*' -]/gu, '');
  return w.length <= 1 ? w : w[0] + w.slice(1).replace(/[\p{L}\p{N}]/gu, '*');
}

init();
