// Taps the audio a page hands to its media player through Media Source
// Extensions (roadmap steps 1.1–1.3). Runs in the page's main world.
//
// For every audio/webm Opus SourceBuffer it builds:
//   bytes -> WebmOpusDemuxer -> OpusPcmDecoder -> PcmTimeline
// and resets the parser when the player aborts (seeks). Each stream knows
// which <video>/<audio> element it feeds, found through the blob: URL the page
// attached with URL.createObjectURL.
//
//   const tap = MseTap.install({ onStream: (s) => ..., onPcm: (s, chunk) => ..., timeline: true });
//   s.timeline, s.src(), s.element(), s.stats()
//
// With `timeline: false` decoded audio isn't stored here, only handed to
// `onPcm` (the extension's page bridge forwards it instead).
//
// Requires webm-opus-demuxer.js and opus-pcm-decoder.js (+ pcm-timeline.js
// unless `timeline: false`).
(function (root) {
  let installed = null;

  // onFullPcm(stream, { time, rate, planes }) gets the decoded audio at full
  // rate too (roadmap step 4.2); tap.onFullPcm can also be set later.
  function install({ onStream, onPcm, onFullPcm, timeline: keepTimeline = true } = {}) {
    if (installed) return installed;
    const tap = { streams: [], onStream: onStream || (() => {}), onPcm: onPcm || null, onFullPcm: onFullPcm || null };
    const urlOf = new WeakMap(); // MediaSource -> blob URL

    const origCreateURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
      const url = origCreateURL.call(this, obj);
      if (obj instanceof MediaSource) urlOf.set(obj, url);
      return url;
    };

    const origAdd = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      const sb = origAdd.call(this, mime);
      if (/^audio\/webm/i.test(mime) && /opus/i.test(mime)) {
        const mediaSource = this;
        const timeline = keepTimeline ? new PcmTimeline() : null;
        let stream = null;
        const decoder = new OpusPcmDecoder({
          onPcm: (c) => {
            if (timeline) timeline.add(c);
            if (tap.onPcm) tap.onPcm(stream, c);
          },
          onFullPcm: (c) => {
            if (tap.onFullPcm) tap.onFullPcm(stream, c);
          },
        });
        const demuxer = new WebmOpusDemuxer({
          onConfig: (c) => decoder.configure(c),
          onFrame: (f) => decoder.decode(f),
        });
        stream = {
          mime,
          timeline,
          decoder,
          demuxer,
          appends: 0,
          aborts: 0,
          errors: 0,
          created: performance.now(),
          src() {
            return urlOf.get(mediaSource) || null;
          },
          element() {
            const url = urlOf.get(mediaSource);
            return url ? [...document.querySelectorAll('video, audio')].find((el) => el.src === url) || null : null;
          },
          stats() {
            return { appends: this.appends, aborts: this.aborts, errors: this.errors, demux: demuxer.stats, decode: decoder.stats };
          },
        };
        Object.defineProperty(sb, '__tap', { value: stream });
        tap.streams.push(stream);
        try {
          tap.onStream(stream);
        } catch (e) {
          console.warn('[MseTap] onStream failed', e);
        }
      }
      return sb;
    };

    const origAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      const s = this.__tap;
      if (s) {
        s.appends++;
        try {
          s.demuxer.push(new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength));
        } catch (e) {
          s.errors++; // never break the page's player because of our parser
        }
      }
      return origAppend.call(this, data);
    };

    const origAbort = SourceBuffer.prototype.abort;
    SourceBuffer.prototype.abort = function () {
      const s = this.__tap;
      if (s) {
        s.aborts++;
        s.demuxer.reset();
        s.decoder.reset();
      }
      return origAbort.call(this);
    };

    installed = tap;
    return tap;
  }

  root.MseTap = { install };
})(typeof globalThis !== 'undefined' ? globalThis : self);
