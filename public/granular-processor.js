/**
 * OCEAN sonic-particle engine — the substance, audible rendering.
 *
 * The identity is literal: a sample of REAL particles from the GPU
 * simulation is read back each frame, and each sampled particle owns one
 * continuous voice here — a stream of white noise through a bandpass
 * filter, alive exactly as long as the particle is alive.
 *
 *   particle position -> stereo placement + distance loudness
 *   particle birth/death (lifespan) -> voice fades in/out
 *   particle color -> spectral band (colorRandom scatters both)
 *   particle order (attractor capture) -> bandwidth: ordered matter rings
 *   scale -> register (big = low), applied on the main thread
 *   speed -> per-voice frequency wobble (restlessness)
 *   density -> which particles exist at all
 *
 * The main thread sends, ~30 Hz, a Float32Array of per-voice targets
 * [ampL, ampR, freqHz, Q] computed from the readback + listener pose.
 * No separate "attractor sound" exists: what you hear near the attractor
 * is the actual captured particles ringing.
 */

const VOICES = 256;
const REPORT_INTERVAL_BLOCKS = 40; // ~0.1s at 128-sample blocks

class Voice {
  constructor(seed) {
    this.rngState = seed | 1;
    // smoothed currents
    this.ampL = 0;
    this.ampR = 0;
    this.freq = 440;
    this.q = 1;
    // targets (set by main-thread message)
    this.tAmpL = 0;
    this.tAmpR = 0;
    this.tFreq = 440;
    this.tQ = 1;
    // restlessness LFO — per-voice random rate and phase
    this.lfoPhase = ((seed >>> 8) & 1023) / 1023 * 6.28318;
    this.lfoRate = 0.5 + ((seed >>> 18) & 255) / 255 * 2.5; // Hz
    // biquad state
    this.b0 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }

  noise() {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x;
    return (x >>> 0) / 2147483648 - 1;
  }

  /** Per-block parameter smoothing + coefficient update. */
  tick(blockDur, wobbleOct) {
    this.ampL += (this.tAmpL - this.ampL) * 0.2;
    this.ampR += (this.tAmpR - this.ampR) * 0.2;
    this.freq += (this.tFreq - this.freq) * 0.15;
    this.q += (this.tQ - this.q) * 0.15;

    this.lfoPhase += 6.28318 * this.lfoRate * blockDur;
    const wobble = wobbleOct === 0 ? 1 : Math.pow(2, Math.sin(this.lfoPhase) * wobbleOct);

    const f = Math.min(Math.max(this.freq * wobble, 30), sampleRate * 0.45);
    const w0 = (2 * Math.PI * f) / sampleRate;
    const alpha = Math.sin(w0) / (2 * this.q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w0)) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  get audible() {
    return this.ampL + this.ampR > 0.0005 || this.tAmpL + this.tAmpR > 0.0005;
  }

  process(outL, outR, n) {
    // narrow bands pass less noise energy; compensate so tones stay present
    const comp = Math.min(3.5, 0.55 * Math.sqrt(this.q) + 0.45);
    const gL = this.ampL * comp;
    const gR = this.ampR * comp;
    for (let i = 0; i < n; i++) {
      const x = this.noise();
      const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      outL[i] += y * gL;
      outR[i] += y * gR;
    }
  }
}

class OceanGranularProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    let seed = 22222;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed;
    };
    this.voices = [];
    for (let i = 0; i < VOICES; i++) this.voices.push(new Voice(next()));

    this.gain = 0.5;
    this.speed = 0.5;
    this.blockCounter = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'voices') {
        // Float32Array [ampL, ampR, freqHz, Q] × VOICES
        const v = d.data;
        const n = Math.min(VOICES, v.length / 4);
        for (let i = 0; i < n; i++) {
          const voice = this.voices[i];
          voice.tAmpL = v[i * 4];
          voice.tAmpR = v[i * 4 + 1];
          voice.tFreq = v[i * 4 + 2];
          voice.tQ = v[i * 4 + 3];
        }
      } else if (d.type === 'params') {
        if (d.data.gain !== undefined) this.gain = d.data.gain;
        if (d.data.speed !== undefined) this.speed = d.data.speed;
      }
    };
  }

  process(_inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] || outputs[0][0];
    const n = outL.length;
    const blockDur = n / sampleRate;
    const wobbleOct = Math.pow(this.speed, 2) * 0.5;

    let active = 0;
    for (let i = 0; i < VOICES; i++) {
      const v = this.voices[i];
      if (!v.audible) continue;
      v.tick(blockDur, wobbleOct * (1 - Math.min(1, v.q / 40))); // ordered voices hold still
      v.process(outL, outR, n);
      active++;
    }

    const gain = this.gain * 2.2;
    for (let i = 0; i < n; i++) {
      outL[i] = Math.tanh(outL[i] * gain);
      outR[i] = Math.tanh(outR[i] * gain);
    }

    if (++this.blockCounter >= REPORT_INTERVAL_BLOCKS) {
      this.blockCounter = 0;
      this.port.postMessage({ type: 'stats', grains: active });
    }
    return true;
  }
}

registerProcessor('ocean-granular', OceanGranularProcessor);
