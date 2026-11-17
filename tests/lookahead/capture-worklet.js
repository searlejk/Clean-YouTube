// Test capture worklet: posts 1024-sample blocks stamped with the exact
// AudioContext time of their first sample.
registerProcessor(
  'cap',
  class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.buf = new Float32Array(1024);
      this.n = 0;
      this.t = 0;
    }

    process(inputs) {
      const x = inputs[0][0];
      if (!x) return true;
      for (let i = 0; i < x.length; i++) {
        if (this.n === 0) this.t = currentTime + i / sampleRate;
        this.buf[this.n++] = x[i];
        if (this.n === this.buf.length) {
          this.port.postMessage({ t: this.t, d: this.buf }, [this.buf.buffer]);
          this.buf = new Float32Array(1024);
          this.n = 0;
        }
      }
      return true;
    }
  }
);
