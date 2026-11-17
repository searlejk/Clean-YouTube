// Roadmap step 1.1 spike: can we see YouTube's audio before it plays?
//
// Wraps MediaSource.addSourceBuffer and SourceBuffer.appendBuffer in the page
// (main world) and logs every media segment YouTube hands to the player: its
// codec, size, container type, and how far the buffer reaches ahead of the
// playhead. Nothing is changed; data is passed through untouched.
//
// Usage: run in the YouTube tab's page context, then start a new video (a
// MediaSource is only created per video load). Read results with
// `__mseProbe.summary()`.
(() => {
  if (window.__mseProbe) return window.__mseProbe;

  const probe = {
    buffers: [], // one entry per SourceBuffer created after injection
    log: [], // one row per append
    samples: [], // first few raw audio segments, kept for step 1.2 (decoding)
    workerMse: typeof MediaSource !== 'undefined' && MediaSource.canConstructInDedicatedWorker === true,
  };

  const MAX_LOG = 2000;
  const MAX_SAMPLES = 12;

  function container(bytes) {
    const u = new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, Math.min(12, bytes.byteLength));
    const hex = [...u.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const ascii = String.fromCharCode(...u.slice(4, 8));
    if (hex === '1a45dfa3') return 'webm-init';
    if (hex === '1f43b675') return 'webm-cluster';
    if (ascii === 'ftyp') return 'mp4-init';
    if (ascii === 'moof' || ascii === 'styp' || ascii === 'sidx') return 'mp4-fragment';
    return 'unknown:' + hex + '/' + ascii;
  }

  // Each MediaSource is attached to a <video> through a blob: URL. Track that
  // URL so every SourceBuffer is measured against its own player (Shorts and
  // ads use different <video> elements than the main watch player).
  const urlOf = new WeakMap(); // MediaSource -> blob URL
  const origCreateURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origCreateURL.call(this, obj);
    if (obj instanceof MediaSource) urlOf.set(obj, url);
    return url;
  };

  function videoFor(mediaSource) {
    const url = mediaSource && urlOf.get(mediaSource);
    const own = url && [...document.querySelectorAll('video')].find((v) => v.src === url);
    return own || document.querySelector('#movie_player video, video.html5-main-video') || document.querySelector('video');
  }

  function mainVideo() {
    return [...document.querySelectorAll('video')].find((v) => !v.paused) || videoFor(null);
  }

  const origAdd = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = origAdd.call(this, mime);
    const info = {
      id: probe.buffers.length,
      mime,
      kind: /^audio/i.test(mime) ? 'audio' : /^video/i.test(mime) ? 'video' : 'other',
      appends: 0,
      bytes: 0,
      maxAhead: 0,
      created: Math.round(performance.now()),
    };
    probe.buffers.push(info);
    Object.defineProperty(sb, '__probe', { value: info });
    Object.defineProperty(sb, '__mediaSource', { value: this });
    return sb;
  };

  const origChange = SourceBuffer.prototype.changeType;
  if (origChange) {
    SourceBuffer.prototype.changeType = function (mime) {
      if (this.__probe) this.__probe.mime += ' → ' + mime;
      return origChange.call(this, mime);
    };
  }

  const origAppend = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const info = this.__probe;
    if (info) {
      const size = data.byteLength;
      const kind = container(data);
      info.appends++;
      info.bytes += size;
      if (info.kind === 'audio' && probe.samples.length < MAX_SAMPLES) {
        // Copy: YouTube may reuse the underlying buffer after appending.
        const src = new Uint8Array(data.buffer || data, data.byteOffset || 0, size);
        probe.samples.push({ buffer: info.id, mime: info.mime, container: kind, bytes: src.slice() });
      }
      const sb = this;
      sb.addEventListener(
        'updateend',
        () => {
          const v = videoFor(sb.__mediaSource);
          const now = v ? v.currentTime : NaN;
          let end = NaN;
          try {
            const b = sb.buffered;
            for (let i = 0; i < b.length; i++) if (b.start(i) <= now + 0.5 && b.end(i) >= now) end = b.end(i);
            if (Number.isNaN(end) && b.length) end = b.end(b.length - 1);
          } catch {
            // SourceBuffer removed (new video); ignore
          }
          const ahead = end - now;
          if (ahead > info.maxAhead) info.maxAhead = ahead;
          probe.log.push({
            t: Math.round(performance.now()),
            buffer: info.id,
            kind: info.kind,
            container: kind,
            bytes: size,
            playhead: +now.toFixed(2),
            bufferedEnd: +end.toFixed(2),
            ahead: +ahead.toFixed(2),
          });
          if (probe.log.length > MAX_LOG) probe.log.shift();
        },
        { once: true }
      );
    }
    return origAppend.call(this, data);
  };

  // Readable overview of what's been seen so far.
  probe.summary = () => {
    const v = mainVideo();
    const now = v ? v.currentTime : NaN;
    return {
      workerMseSupported: probe.workerMse,
      videoSrcIsBlob: !!(v && /^blob:/.test(v.src)),
      playhead: +now.toFixed(2),
      duration: v ? +v.duration.toFixed(1) : null,
      buffers: probe.buffers.map((b) => ({
        id: b.id,
        kind: b.kind,
        mime: b.mime,
        appends: b.appends,
        kB: Math.round(b.bytes / 1024),
        maxAheadSeconds: +b.maxAhead.toFixed(1),
      })),
      containers: [...new Set(probe.log.map((r) => r.kind + ':' + r.container))],
      audioSamplesKept: probe.samples.length,
    };
  };

  window.__mseProbe = probe;
  return probe;
})();
