// Collects the (pre-delay) audio into mono chunks stamped with the exact
// AudioContext time of their first sample, so detections can be mapped back
// onto the delayed output precisely.
class PFCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048; // ~43 ms at 48 kHz: small chunks keep latency low
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.startTime = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const a = input[0];
      const b = input[1];
      for (let i = 0; i < a.length; i++) {
        if (this.n === 0) this.startTime = currentTime + i / sampleRate;
        this.buf[this.n++] = b ? (a[i] + b[i]) * 0.5 : a[i];
        if (this.n === this.size) {
          this.port.postMessage({ samples: this.buf, time: this.startTime }, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pf-capture', PFCapture);
