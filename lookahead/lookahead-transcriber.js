// Keeps the transcript ahead of the playhead (roadmap step 1.4).
//
// Repeatedly picks the first untranscribed moment at or after the playhead,
// waits until enough decoded audio is ready there, and transcribes it in
// windows of `windowSec` with `overlapSec` of extra context on each side, so
// no word is judged from a cut-off fragment. Silent windows are marked done
// without calling Whisper. After a seek it simply continues from the new
// playhead; anything already transcribed is reused.
//
//   const lt = new LookaheadTranscriber({
//     timeline,                 // PcmTimeline (decoded 16 kHz audio)
//     words,                    // WordTimeline (results)
//     transcribe,               // async (samples, offsetSec) => { words: [{text,start,end}] } in media time
//     playhead: () => video.currentTime,
//     duration: () => video.duration,
//     speech: (t0, t1) => [[a, b], ...] | null,   // optional (step 5.1): where there's
//                               // speech in [t0, t1), or null if unknown there
//   });
//
// With `speech`, a window ends in the pause nearest `windowSec` (between
// minWindowSec and windowSec + stretchSec) instead of wherever 10 s falls, so
// no word is cut in half, and a stretch with no speech is skipped without
// calling Whisper.
//   lt.start(); ... lt.stop();
(function (root) {
  const SR = 16000;

  class LookaheadTranscriber {
    constructor({
      timeline,
      words,
      transcribe,
      playhead,
      duration = () => Infinity,
      windowSec = 10,
      overlapSec = 1,
      maxAheadSec = 120,
      urgentSec = 4,
      silenceRms = 0.003,
      idleMs = 100, // how long to wait when there's nothing to do yet
      speech = null,
      minWindowSec = 5,
      stretchSec = 2,
      onWindow = () => {},
    }) {
      Object.assign(this, { timeline, words, transcribe, playhead, duration, windowSec, overlapSec, maxAheadSec, urgentSec, silenceRms, idleMs, speech, minWindowSec, stretchSec, onWindow });
      this.running = false;
      this.stats = { windows: 0, silentWindows: 0, whisperMs: 0, audioSec: 0, errors: 0, pauseCuts: 0, fixedCuts: 0, skippedNoSpeech: 0 };
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.generation = (this.generation || 0) + 1;
      this.loop(this.generation);
    }

    // A request already in flight finishes, but its loop then exits, so a
    // quick stop() + start() never leaves two loops running.
    stop() {
      this.running = false;
    }

    // The next stretch to transcribe, or null if there's nothing to do yet.
    next() {
      const p = this.playhead();
      if (p == null || Number.isNaN(p)) return null;
      const end = this.duration();
      let from = this.words.coveredUntil(p);
      const fresh = from == null; // nothing transcribed at the playhead (start/seek)
      if (fresh) from = Math.max(0, p - 0.2);
      if (from >= end - 0.05 || from - p > this.maxAheadSec) return null;

      const ready = this.timeline.readyAhead(from, this.windowSec + this.overlapSec + 0.5);
      const toEnd = end - from;
      const full = this.windowSec + this.overlapSec; // window + right-hand context
      const urgent = from - p < this.urgentSec;
      let len;
      if (ready >= full || ready >= toEnd - 0.05) len = Math.min(this.windowSec, toEnd);
      else if (urgent && ready >= 1) len = Math.max(0, ready - Math.min(this.overlapSec, ready / 4));
      else return null; // wait for more audio
      if (len < 0.2) return null;

      // Voice activity (step 5.1): end in a pause, or skip a speechless stretch.
      let cut = 'fixed';
      let noSpeech = false;
      const usable = Math.min(toEnd, ready - (ready >= toEnd - 0.05 ? 0 : this.overlapSec));
      const reach = Math.min(usable, this.windowSec + this.stretchSec);
      const segs = this.speech && reach >= this.minWindowSec ? this.speech(from, from + reach) : null;
      if (segs) {
        const inWin = segs.filter((s) => s[1] > from && s[0] < from + reach);
        if (!inWin.length || inWin[0][0] >= from + Math.min(len, reach)) {
          // Nothing said until the next speech (or the end of what's known).
          const until = inWin.length ? inWin[0][0] - 0.05 : from + Math.min(len, reach);
          if (until - from >= 0.2) {
            len = until - from;
            noSpeech = true;
            cut = 'pause';
          }
        } else {
          let best = null;
          for (let i = 0; i <= inWin.length; i++) {
            const g0 = i === 0 ? null : inWin[i - 1][1];
            const g1 = i === inWin.length ? null : inWin[i][0];
            if (g0 == null || g1 == null) continue;
            const mid = (g0 + g1) / 2;
            const l = mid - from;
            if (l < this.minWindowSec || l > reach) continue;
            if (!best || Math.abs(l - this.windowSec) < Math.abs(best - this.windowSec)) best = l;
          }
          // Speech that ends inside the known stretch is a pause too.
          const lastEnd = inWin[inWin.length - 1][1];
          if (lastEnd + 0.1 < from + reach && lastEnd - from >= this.minWindowSec) {
            const l = Math.min(reach, lastEnd - from + 0.1);
            if (!best || Math.abs(l - this.windowSec) < Math.abs(best - this.windowSec)) best = l;
          }
          if (best != null) {
            len = best;
            cut = 'pause';
          }
        }
      }

      const atEnd = from + len >= end - 0.05;
      const left = fresh ? 0 : Math.min(this.overlapSec, from); // context before
      const right = atEnd ? 0 : Math.min(this.overlapSec, Math.max(0, ready - len));
      return { from, to: from + len, audioFrom: from - left, audioTo: from + len + right, cut, noSpeech };
    }

    async loop(generation) {
      while (this.running && generation === this.generation) {
        const job = this.next();
        if (!job) {
          await new Promise((r) => setTimeout(r, this.idleMs));
          continue;
        }
        const { samples } = this.timeline.read(job.audioFrom, job.audioTo);
        let rms = 0;
        for (let i = 0; i < samples.length; i++) rms += samples[i] * samples[i];
        rms = Math.sqrt(rms / (samples.length || 1));

        const t0 = performance.now();
        if (job.cut === 'pause') this.stats.pauseCuts++;
        else this.stats.fixedCuts++;
        if (job.noSpeech) {
          this.words.addWindow(job.from, job.to, []);
          this.stats.skippedNoSpeech++;
        } else if (rms < this.silenceRms) {
          this.words.addWindow(job.from, job.to, []);
          this.stats.silentWindows++;
        } else {
          try {
            const res = await this.transcribe(samples, job.audioFrom);
            this.words.addWindow(job.from, job.to, res.words || []);
            this.stats.whisperMs += performance.now() - t0;
            this.stats.audioSec += samples.length / SR;
          } catch (e) {
            this.stats.errors++;
            await new Promise((r) => setTimeout(r, this.idleMs * 3));
            continue;
          }
        }
        this.stats.windows++;
        this.onWindow({ ...job, ms: performance.now() - t0, silent: rms < this.silenceRms });
      }
    }
  }

  root.LookaheadTranscriber = LookaheadTranscriber;
  if (typeof module !== 'undefined' && module.exports) module.exports = LookaheadTranscriber;
})(typeof globalThis !== 'undefined' ? globalThis : self);
