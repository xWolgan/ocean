import * as THREE from 'three/webgpu';
import type { FieldState } from '../state/FieldState';
import { SONIC_COUNT, pcgHash } from '../field/ParticleField';

const _listener = new THREE.Vector3();
const _right = new THREE.Vector3();
const _rel = new THREE.Vector3();

/**
 * Main-thread bridge for the sonic-particle worklet. Must be started from
 * a user gesture (browser autoplay policy).
 *
 * Each frame the GPU readback of real particle states arrives here; this
 * class turns them into per-voice targets [ampL, ampR, freqHz, Q] using
 * the listener pose (position -> pan + distance loudness) and the
 * substance state (scale -> register, colorRandom -> scatter/bandwidth,
 * order -> ringing).
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private lastSend = 0;

  /** Latest audible voice count reported by the worklet, for the overlay. */
  voiceCount = 0;

  /** Diagnostics from the last updateVoices pass (dev hook / overlay). */
  readonly debug = { alive: 0, audibleTargets: 0, meanDist: 0 };

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  async start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule('/granular-processor.js');
    this.node = new AudioWorkletNode(this.ctx, 'ocean-granular', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (e) => {
      if (e.data.type === 'stats') this.voiceCount = e.data.grains;
    };
    this.node.connect(this.ctx.destination);
  }

  /** Call every frame; internally throttled to ~60 Hz. */
  updateParams(state: FieldState, timeMs: number): void {
    if (!this.node || timeMs - this.lastSend < 16) return;
    this.lastSend = timeMs;
    this.node.port.postMessage({
      type: 'params',
      data: { gain: state.gain, speed: state.speed },
    });
  }

  /** Turn a sonics readback (real particle states) into voice targets. */
  updateVoices(
    sonics: Float32Array,
    sonicStride: number,
    camera: THREE.Camera,
    state: FieldState,
  ): void {
    if (!this.node) return;

    camera.getWorldPosition(_listener);
    _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();

    const registerHz = 180 * Math.pow(20, 1 - state.scale);
    const qBase = 0.7 + 18 * Math.pow(1 - state.colorRandom, 2);
    const scatter = 4.4 * state.colorRandom;

    const out = new Float32Array(SONIC_COUNT * 4);
    const voices = Math.min(SONIC_COUNT, Math.floor(sonics.length / 4));
    let dbgAlive = 0;
    let dbgAudible = 0;
    let dbgDist = 0;
    for (let k = 0; k < voices; k++) {
      const o = k * 4;
      _rel.set(
        sonics[o] - _listener.x,
        sonics[o + 1] - _listener.y,
        sonics[o + 2] - _listener.z,
      );
      // unpack [order, lifeEnv] from w; recompute static per-particle
      // values from the particle index (same PCG as the GPU shaders)
      const packed = sonics[o + 3];
      const q255 = Math.floor(packed / 2);
      const order = q255 / 255;
      const lifeEnv = packed - q255 * 2;
      const src = k * sonicStride;
      const colorRand = pcgHash(src + 601);
      const alive = pcgHash(src + 303) < state.density ? 1 : 0;

      const dist = _rel.length();
      const distGain = 1 / (1 + 0.35 * dist * dist);
      const pan = dist > 0.001 ? THREE.MathUtils.clamp(_rel.dot(_right) / dist, -1, 1) : 0;
      const theta = ((pan + 1) * Math.PI) / 4; // equal-power
      const amp = alive * lifeEnv * distGain * 0.06;

      out[k * 4] = amp * Math.cos(theta);
      out[k * 4 + 1] = amp * Math.sin(theta);
      out[k * 4 + 2] = registerHz * Math.pow(2, (colorRand - 0.5) * scatter);
      out[k * 4 + 3] = qBase + (36 - qBase) * order; // captured matter rings

      if (alive > 0.5) dbgAlive++;
      if (amp > 0.0005) dbgAudible++;
      dbgDist += dist;
    }
    this.debug.alive = dbgAlive;
    this.debug.audibleTargets = dbgAudible;
    this.debug.meanDist = dbgDist / Math.max(1, voices);
    this.node.port.postMessage({ type: 'voices', data: out }, [out.buffer]);
  }
}
