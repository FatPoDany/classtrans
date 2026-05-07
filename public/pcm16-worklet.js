// AudioWorklet processor: takes Float32 PCM at the AudioContext's sample rate,
// resamples to targetRate (default 16 kHz) with linear interpolation if needed,
// converts to 16-bit signed PCM, and posts fixed-size frames to the main thread
// as transferable ArrayBuffers.
//
// Loaded with: audioContext.audioWorklet.addModule("/pcm16-worklet.js")

class PCM16Worklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.frameSize = opts.frameSize || 1600; // 100 ms at 16 kHz
    this.outBuffer = new Int16Array(this.frameSize);
    this.outIdx = 0;

    this.needsResample = sampleRate !== this.targetRate;
    if (this.needsResample) {
      this.ratio = sampleRate / this.targetRate;
      this.readPos = 0;
      this.inputAccum = new Float32Array(0);
    }
  }

  emitSample(sample) {
    const s = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    this.outBuffer[this.outIdx++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.outIdx >= this.frameSize) {
      const out = new Int16Array(this.outBuffer);
      this.port.postMessage(out.buffer, [out.buffer]);
      this.outIdx = 0;
    }
  }

  processPassthrough(ch) {
    for (let i = 0; i < ch.length; i++) {
      this.emitSample(ch[i]);
    }
  }

  processResample(ch) {
    const consumed = Math.floor(this.readPos);
    const remaining = this.inputAccum.length - consumed;
    const merged = new Float32Array(remaining + ch.length);
    if (remaining > 0) merged.set(this.inputAccum.subarray(consumed), 0);
    merged.set(ch, remaining);
    this.inputAccum = merged;
    this.readPos -= consumed;

    while (this.readPos + 1 < this.inputAccum.length) {
      const idx = Math.floor(this.readPos);
      const frac = this.readPos - idx;
      const a = this.inputAccum[idx];
      const b = this.inputAccum[idx + 1];
      this.emitSample(a + frac * (b - a));
      this.readPos += this.ratio;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    if (this.needsResample) {
      this.processResample(ch);
    } else {
      this.processPassthrough(ch);
    }
    return true;
  }
}

registerProcessor("pcm16-worklet", PCM16Worklet);
