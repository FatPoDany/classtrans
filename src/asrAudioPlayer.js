// Streamed PCM playback for the realtime translation's spoken output.
//
// Qwen Omni-Realtime emits the translated speech as base64 PCM16 chunks
// (`response.audio.delta`). This decodes each chunk and schedules it back-to-back
// on a Web Audio clock for gap-free playback. Its own AudioContext (output rate)
// is separate from the 16 kHz capture context in BaseAsrSession.

// Qwen Omni-Realtime PCM output rate. Verify on first run — if pitch sounds
// wrong, this is the knob to adjust.
const OUTPUT_SAMPLE_RATE = 24000;

// If we ever fall this far behind real time (chunks queued faster than they
// play), snap the schedule forward to avoid unbounded latency growth.
const MAX_QUEUE_AHEAD_S = 2;

export class AsrAudioPlayer {
  constructor(sampleRate = OUTPUT_SAMPLE_RATE) {
    this.sampleRate = sampleRate;
    this.ctx = null;
    this.nextStartTime = 0;
    this._sources = new Set();
  }

  enable() {
    this._ensureCtx();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }

  // Stop scheduled playback but keep the context for quick re-enable.
  disable() {
    for (const src of this._sources) { try { src.stop(); } catch (_) {} }
    this._sources.clear();
    this.nextStartTime = 0;
  }

  reset() {
    this.disable();
  }

  dispose() {
    this.disable();
    if (this.ctx) { try { this.ctx.close(); } catch (_) {} this.ctx = null; }
  }

  _ensureCtx() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctor({ sampleRate: this.sampleRate });
      this.nextStartTime = 0;
    }
    return this.ctx;
  }

  feed(base64Pcm) {
    if (!base64Pcm) return;
    const ctx = this._ensureCtx();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    let bytes;
    try {
      const bin = atob(base64Pcm);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch (_) {
      return;
    }
    const samples = bytes.length >> 1;
    if (samples === 0) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const f32 = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      f32[i] = view.getInt16(i * 2, true) / 0x8000;
    }

    const buffer = ctx.createBuffer(1, samples, this.sampleRate);
    buffer.getChannelData(0).set(f32);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    let startAt = Math.max(now, this.nextStartTime);
    if (startAt - now > MAX_QUEUE_AHEAD_S) startAt = now; // drop runaway latency
    src.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this._sources.add(src);
    src.onended = () => this._sources.delete(src);
  }
}
