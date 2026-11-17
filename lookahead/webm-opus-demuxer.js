// Streaming WebM demuxer for YouTube's audio (roadmap step 1.2).
//
// YouTube appends its audio to the player as raw byte slices that can start
// or end anywhere, even in the middle of a block. This parser takes those
// slices in any size, keeps whatever is incomplete until the next push, and
// emits each Opus packet with its media timestamp.
//
//   const d = new WebmOpusDemuxer({ onConfig, onFrame });
//   d.push(uint8Array);   // as many times as needed, any slice sizes
//   d.reset();            // after the player aborts/seeks: resync on the next cluster
//
// onConfig({ codec, sampleRate, channels, codecPrivate, codecDelayUs, track })
// onFrame({ timestampUs, data, track })
//
// Works in browsers and Node (no DOM APIs).
(function (root) {
  const ID = {
    EBML: 0x1a45dfa3,
    Segment: 0x18538067,
    SeekHead: 0x114d9b74,
    Info: 0x1549a966,
    TimecodeScale: 0x2ad7b1,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    CodecID: 0x86,
    CodecPrivate: 0x63a2,
    CodecDelay: 0x56aa,
    Audio: 0xe1,
    SamplingFrequency: 0xb5,
    Channels: 0x9f,
    Cluster: 0x1f43b675,
    Timecode: 0xe7,
    SimpleBlock: 0xa3,
    BlockGroup: 0xa0,
    Block: 0xa1,
  };

  // Containers we step into rather than read whole: their children follow
  // directly, so a flat parser can handle them without tracking nesting.
  const MASTERS = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Audio, ID.Cluster, ID.BlockGroup]);
  // Elements we read in full. Anything else with a known size is skipped.
  const LEAVES = new Set([
    ID.TimecodeScale,
    ID.TrackNumber,
    ID.CodecID,
    ID.CodecPrivate,
    ID.CodecDelay,
    ID.SamplingFrequency,
    ID.Channels,
    ID.Timecode,
    ID.SimpleBlock,
    ID.Block,
  ]);
  const MAX_LEAF_BYTES = 4 * 1024 * 1024; // a sane upper bound for one element

  function readVint(buf, pos, keepMarker) {
    if (pos >= buf.length) return null;
    const first = buf[pos];
    if (first === 0) return { error: true };
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (pos + len > buf.length) return null;
    let value = keepMarker ? first : first & (0xff >> len);
    let allOnes = value === (0xff >> len);
    for (let i = 1; i < len; i++) {
      value = value * 256 + buf[pos + i];
      if (buf[pos + i] !== 0xff) allOnes = false;
    }
    return { value, len, unknown: !keepMarker && allOnes };
  }

  function readUint(bytes) {
    let v = 0;
    for (const b of bytes) v = v * 256 + b;
    return v;
  }

  function readFloat(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return bytes.length === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
  }

  class WebmOpusDemuxer {
    constructor({ onConfig, onFrame } = {}) {
      this.onConfig = onConfig || (() => {});
      this.onFrame = onFrame || (() => {});
      this.buf = new Uint8Array(0);
      this.skip = 0; // bytes of an ignored element still to discard
      this.syncing = false; // looking for the next Cluster/EBML header
      this.timecodeScale = 1e6; // ns per timecode unit (WebM default)
      this.clusterTimecode = null;
      this.track = null; // the Opus track number
      this.entry = {}; // TrackEntry being read
      this.stats = { frames: 0, resyncs: 0, lacedBlocksSkipped: 0, bytes: 0 };
    }

    // After SourceBuffer.abort() or a seek, the next bytes start somewhere new.
    reset() {
      this.buf = new Uint8Array(0);
      this.skip = 0;
      this.syncing = true;
      this.clusterTimecode = null;
    }

    push(chunk) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer || chunk, chunk.byteOffset || 0, chunk.byteLength);
      this.stats.bytes += bytes.length;
      if (this.buf.length) {
        const merged = new Uint8Array(this.buf.length + bytes.length);
        merged.set(this.buf);
        merged.set(bytes, this.buf.length);
        this.buf = merged;
      } else {
        this.buf = bytes.slice();
      }
      this.parse();
    }

    parse() {
      let pos = 0;
      const buf = this.buf;

      while (pos < buf.length) {
        if (this.skip) {
          const n = Math.min(this.skip, buf.length - pos);
          pos += n;
          this.skip -= n;
          continue;
        }
        if (this.syncing) {
          const at = this.findSyncPoint(buf, pos);
          if (at < 0) {
            pos = Math.max(pos, buf.length - 3); // keep a possible partial ID
            break;
          }
          pos = at;
          this.syncing = false;
        }

        const id = readVint(buf, pos, true);
        if (id === null) break;
        const size = id.error ? null : readVint(buf, pos + id.len, false);
        if (id.error || (size && size.error)) {
          this.resync();
          pos += 1;
          continue;
        }
        if (size === null) break;
        const header = id.len + size.len;
        const elementId = id.value;

        if (MASTERS.has(elementId)) {
          if (elementId === ID.TrackEntry) this.entry = {};
          if (elementId === ID.Cluster) this.clusterTimecode = null;
          pos += header; // step inside; children follow
          continue;
        }
        if (elementId === ID.EBML) {
          if (size.unknown) {
            this.resync();
            pos += 1;
            continue;
          }
          this.skip = size.value; // header contents aren't needed
          pos += header;
          continue;
        }
        if (size.unknown) {
          // Only containers may have unknown size; anything else means we lost sync.
          this.resync();
          pos += 1;
          continue;
        }
        if (!LEAVES.has(elementId)) {
          this.skip = size.value; // Cues, SeekHead, Void, Tags, ...
          pos += header;
          continue;
        }
        if (size.value > MAX_LEAF_BYTES) {
          this.resync();
          pos += 1;
          continue;
        }
        if (pos + header + size.value > buf.length) break; // wait for the rest
        this.leaf(elementId, buf.subarray(pos + header, pos + header + size.value));
        pos += header + size.value;
      }

      this.buf = pos >= buf.length ? new Uint8Array(0) : buf.slice(pos);
    }

    findSyncPoint(buf, from) {
      for (let i = from; i + 3 < buf.length; i++) {
        const b0 = buf[i];
        if (b0 === 0x1f && buf[i + 1] === 0x43 && buf[i + 2] === 0xb6 && buf[i + 3] === 0x75) return i;
        if (b0 === 0x1a && buf[i + 1] === 0x45 && buf[i + 2] === 0xdf && buf[i + 3] === 0xa3) return i;
      }
      return -1;
    }

    resync() {
      this.stats.resyncs++;
      this.syncing = true;
      this.skip = 0;
    }

    leaf(id, data) {
      switch (id) {
        case ID.TimecodeScale:
          this.timecodeScale = readUint(data);
          break;
        case ID.TrackNumber:
          this.entry.number = readUint(data);
          break;
        case ID.CodecID:
          this.entry.codec = String.fromCharCode(...data);
          this.maybeConfig();
          break;
        case ID.CodecPrivate:
          this.entry.codecPrivate = data.slice();
          this.maybeConfig();
          break;
        case ID.CodecDelay:
          this.entry.codecDelayNs = readUint(data);
          break;
        case ID.SamplingFrequency:
          this.entry.sampleRate = readFloat(data);
          this.maybeConfig();
          break;
        case ID.Channels:
          this.entry.channels = readUint(data);
          this.maybeConfig();
          break;
        case ID.Timecode:
          this.clusterTimecode = readUint(data);
          break;
        case ID.SimpleBlock:
        case ID.Block:
          this.block(data);
          break;
      }
    }

    maybeConfig() {
      const e = this.entry;
      if (e.codec !== 'A_OPUS' || !e.codecPrivate || e.number == null || e.configured) return;
      // OpusHead carries the channel count and input rate; Opus always decodes at 48 kHz.
      const head = e.codecPrivate;
      const channels = e.channels || head[9] || 2;
      e.configured = true;
      this.track = e.number;
      this.onConfig({
        codec: 'opus',
        sampleRate: 48000,
        channels,
        codecPrivate: head,
        codecDelayUs: e.codecDelayNs ? e.codecDelayNs / 1000 : 0,
        track: e.number,
      });
    }

    block(data) {
      const tn = readVint(data, 0, false);
      if (!tn || tn.error || this.clusterTimecode == null) return;
      if (this.track != null && tn.value !== this.track) return;
      const p = tn.len;
      const rel = (data[p] << 8) | data[p + 1];
      const relative = rel & 0x8000 ? rel - 0x10000 : rel;
      const flags = data[p + 2];
      if (flags & 0x06) {
        // Laced blocks (several packets in one block) aren't used by YouTube's
        // Opus streams; count them so a test would show it if that changes.
        this.stats.lacedBlocksSkipped++;
        return;
      }
      const timestampNs = (this.clusterTimecode + relative) * this.timecodeScale;
      this.stats.frames++;
      this.onFrame({ timestampUs: Math.round(timestampNs / 1000), data: data.slice(p + 3), track: tn.value });
    }
  }

  root.WebmOpusDemuxer = WebmOpusDemuxer;
  if (typeof module !== 'undefined' && module.exports) module.exports = WebmOpusDemuxer;
})(typeof globalThis !== 'undefined' ? globalThis : self);
