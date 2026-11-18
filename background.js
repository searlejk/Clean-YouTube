importScripts('settings.js');

// Lifetime stats shown at the top of the popup, kept on this computer:
//   blockedTotal  words and phrases blocked since installing ("son of a
//                 bitch" counts once)
//   installedAt   when counting started, for "N days profanity free"
const STATS = { blockedTotal: 0, installedAt: 0 };

async function ensureStats() {
  const s = await chrome.storage.local.get(STATS);
  if (!s.installedAt) await chrome.storage.local.set({ installedAt: Date.now(), blockedTotal: s.blockedTotal || 0 });
}

// Tabs report each blocked word here so counts from several tabs never
// overwrite each other.
let counting = Promise.resolve();
function addBlocked(n) {
  counting = counting.then(async () => {
    const s = await chrome.storage.local.get(STATS);
    await chrome.storage.local.set({ blockedTotal: (s.blockedTotal || 0) + n, installedAt: s.installedAt || Date.now() });
  });
  return counting;
}

ensureStats();

chrome.runtime.onInstalled.addListener(async () => {
  await ensureStats();
  const stored = await chrome.storage.sync.get(null);
  const patch = {};
  for (const [k, v] of Object.entries(PF.DEFAULTS)) if (!(k in stored)) patch[k] = v;
  // v2: Tiny replaced Base as the default because it's much faster. Move
  // anyone still on the old default; leave other choices alone.
  if ((stored.settingsVersion || 1) < 2 && stored.model === 'base.en') patch.model = 'tiny.en';
  patch.settingsVersion = PF.SETTINGS_VERSION;
  await chrome.storage.sync.set(patch);
});

// The Whisper model runs in an offscreen document (which hosts a Web Worker),
// because content scripts can't load extension WASM/WebGPU code and service
// workers can't host long-lived workers.
let creating = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (existing.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Runs the Whisper speech-recognition model in a Web Worker to find profanity in YouTube audio.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'pf:blocked') {
    const n = Math.max(0, Math.min(100, Math.floor(msg.count) || 0));
    if (n) addBlocked(n);
    return;
  }
  if (msg?.type === 'pf:offscreenIdle') {
    chrome.offscreen.closeDocument().catch(() => {});
    return;
  }
  if (msg?.type === 'pf:ensureOffscreen') {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});
