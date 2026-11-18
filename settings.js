// Shared defaults. Loaded by the content script, popup and background worker.
(function (root) {
  const DEFAULT_WORDS = [
    '*fuck*',
    'shit*',
    'bullshit*',
    'horseshit*',
    'bitch*',
    'ass',
    'asses',
    'asshole*',
    'jackass*',
    'dumbass*',
    'bastard*',
    'cunt*',
    'dick',
    'dicks',
    'dickhead*',
    'cock',
    'cocks',
    'cocksucker*',
    'damn*',
    'goddamn*',
    'goddam*',
    'piss',
    'pissed',
    'pissing',
    'crap',
    'crappy',
    'whore*',
    'slut*',
    'prick*',
    'twat*',
    'wanker*',
    'son of a bitch',
  ];

  const MODELS = {
    'tiny.en': {
      id: 'onnx-community/whisper-tiny.en_timestamped',
      label: 'Tiny – fastest, recommended (~120 MB download)',
      timestampLag: { start: 0.85, end: 0.55 }, // seconds its word edges run late (measured)
    },
    'base.en': {
      id: 'onnx-community/whisper-base.en_timestamped',
      label: 'Base – more accurate, slower (~210 MB download)',
      timestampLag: { start: 0.3, end: 0.1 },
    },
    'small.en': {
      id: 'onnx-community/whisper-small.en_timestamped',
      label: 'Small – most accurate, needs a strong GPU (~590 MB)',
      timestampLag: { start: 0.3, end: 0.1 },
    },
  };

  const DEFAULTS = {
    enabled: true,
    mode: 'bleep', // 'bleep' | 'silence'
    words: DEFAULT_WORDS,
    lookahead: true, // read YouTube's downloaded audio ahead of time: no delay when possible
    autoDelay: true, // pick the shortest safe delay for this computer
    delay: 3, // seconds the video and audio are held back when autoDelay is off
    model: 'tiny.en',
    bleepVolume: 0.25,
    cover: 0.25, // extra seconds muted before and after each caught word
    showBadge: true,
    muteUntilReady: false, // keep the sound off until the model has loaded
  };

  // Bumped when stored settings need a one-time migration (see background.js).
  // Models the companion app (roadmap step 2.2) may run, with how its word
  // edges are off. Positive = late, negative = early. Measured on 61 words of
  // synthetic speech with exact timings; set so the mute still covers the
  // latest start and earliest end seen.
  const COMPANION_MODELS = {
    'small.en': { label: 'Whisper small', timestampLag: { start: 0.05, end: -0.2 } },
    'base.en': { label: 'Whisper base', timestampLag: { start: -0.1, end: -0.35 } },
    'tiny.en': { label: 'Whisper tiny', timestampLag: { start: 0.25, end: -0.05 } },
  };

  const SETTINGS_VERSION = 2;

  root.PF = { DEFAULTS, DEFAULT_WORDS, MODELS, COMPANION_MODELS, SETTINGS_VERSION };
})(typeof globalThis !== 'undefined' ? globalThis : self);
