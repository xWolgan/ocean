import * as THREE from 'three/webgpu';
import type { FieldState } from '../state/FieldState';
import { FIELD_CENTER, FIELD_HALF_EXTENTS } from '../state/FieldState';
import { lifespanToTau } from '../field/ParticleField';
import type { ObjectManager } from '../objects/ObjectManager';

const _listener = new THREE.Vector3();
const _right = new THREE.Vector3();

/**
 * Main-thread bridge for the twin-scheduler worklet. Must be started from
 * a user gesture (browser autoplay policy).
 *
 * No audio data crosses this bridge — only control state at ~60 Hz. The
 * worklet evaluates the same deterministic flash process as the GPU
 * (same PCG hashes, same shared clock) and schedules every grain
 * sample-accurately itself. `timeOffset` maps the worklet's audio clock
 * onto the app clock so both renderings agree on generation phase.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private lastSend = 0;
  private lastTargetsVersion = -1;
  /** Resolved once in start(), same pattern as the ?audio=legacy picker:
   *  ?transport=off ships 0 (bit-sacred Stage-1 behavior), else 1. */
  private transportFlag: 0 | 1 = 1;
  /** Previous tick's listener world position, for the velocity finite
   *  difference below. Null until the first tick that isn't throttled away. */
  private prevListenerPos: THREE.Vector3 | null = null;
  private prevListenerT = 0;
  /** EMA-smoothed listener velocity (alpha=0.2), pre-clamp. */
  private listenerVelEma: [number, number, number] = [0, 0, 0];

  /** Latest audible voice count reported by the worklet, for the overlay. */
  voiceCount = 0;
  /** Latest bed (non-hero) voice count reported by the worklet, for the overlay. */
  bedCount = 0;
  /** Human-readable engine state for the overlay (remote debugging). */
  status = 'off (click to start)';
  /** 'off' when ?transport=off, else 'on' — for the overlay. */
  transportMode: 'on' | 'off' = 'on';

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  async start(): Promise<void> {
    if (this.ctx) {
      try {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        this.status = this.ctx.state;
      } catch (err) {
        this.status = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
        this.reset();
      }
      return;
    }
    // ?audio=legacy loads the frozen pre-tile engine for A/B comparison
    const urlParams = new URLSearchParams(location.search);
    const requested =
      urlParams.get('audio') === 'legacy' ? 'granular-legacy.js' : 'granular-processor.js';
    // ?transport=off keeps the bit-sacred Stage-1 behavior; resolved once,
    // same pattern as `requested` above.
    const transportOff = urlParams.get('transport') === 'off';
    this.transportFlag = transportOff ? 0 : 1;
    this.transportMode = transportOff ? 'off' : 'on';
    try {
      const ctx = await this.initContext(requested);
      this.status = ctx.state;
    } catch (err) {
      // reset so a retry (below or on the next click) starts from
      // scratch instead of reusing a half-built context
      this.reset();
      // graceful degradation: the tile engine is an ES-module worklet
      // (it imports './dsp.js'), and AudioWorklet implementations that
      // can't load module imports reject addModule — non-Chromium
      // browsers would otherwise fail closed with silence. The legacy
      // engine is a single self-contained file: retry ONCE with it.
      if (requested !== 'granular-legacy.js') {
        try {
          await this.initContext('granular-legacy.js');
          this.status = 'running (legacy engine — reduced voices)';
          return;
        } catch {
          this.reset();
        }
      }
      // surface the original failure in the stats overlay
      this.status = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Build the AudioContext + worklet node for one engine file. Throws on
   *  failure with `this.ctx`/`this.node` possibly half-built — callers
   *  must reset() before retrying. */
  private async initContext(engineFile: string): Promise<AudioContext> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(
      `${import.meta.env.BASE_URL}${engineFile}`,
    );
    this.node = new AudioWorkletNode(ctx, 'ocean-granular', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (e) => {
      if (e.data.type === 'stats') {
        this.voiceCount = e.data.grains;
        this.bedCount = e.data.bed ?? 0;
      }
    };
    this.node.connect(ctx.destination);
    return ctx;
  }

  private reset(): void {
    this.node = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  /**
   * Stream control state; internally throttled to ~60 Hz.
   * @param tSec   the app clock also driving the GPU field
   * @param stride particle index step between sonic samples
   * @param count  total live particle count (the field's true size, for
   *               the worklet's bed weighting and loudness normalization)
   */
  update(
    state: FieldState,
    camera: THREE.Camera,
    tSec: number,
    stride: number,
    objects: ObjectManager,
    count: number,
  ): void {
    if (!this.node || !this.ctx) return;
    const nowMs = performance.now();
    if (nowMs - this.lastSend < 16) return;
    this.lastSend = nowMs;

    camera.getWorldPosition(_listener);
    _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();

    // listener velocity: finite difference of the world position between
    // update ticks (this method is already throttled to ~60Hz above),
    // EMA-smoothed (alpha=0.2) so one noisy tick can't slam a grain's
    // Doppler shift, each component clamped to |v| <= 20 m/s. Scaffolding
    // only in Task 1 — nothing on the audio side reads listenerVel yet
    // (Task 5 will, under the freeze-per-generation rule). First tick (no
    // previous position yet) sends [0, 0, 0].
    if (this.prevListenerPos) {
      const dt = tSec - this.prevListenerT;
      if (dt > 0) {
        const alpha = 0.2;
        const vx = (_listener.x - this.prevListenerPos.x) / dt;
        const vy = (_listener.y - this.prevListenerPos.y) / dt;
        const vz = (_listener.z - this.prevListenerPos.z) / dt;
        this.listenerVelEma[0] += alpha * (vx - this.listenerVelEma[0]);
        this.listenerVelEma[1] += alpha * (vy - this.listenerVelEma[1]);
        this.listenerVelEma[2] += alpha * (vz - this.listenerVelEma[2]);
      }
      this.prevListenerPos.copy(_listener);
    } else {
      this.prevListenerPos = _listener.clone();
    }
    this.prevListenerT = tSec;
    const clampVel = (v: number) => Math.max(-20, Math.min(20, v));
    const listenerVel: [number, number, number] = [
      clampVel(this.listenerVelEma[0]),
      clampVel(this.listenerVelEma[1]),
      clampVel(this.listenerVelEma[2]),
    ];

    // ship full constellations only when they change; the worklet samples
    // per-generation targets itself with the same hashes as the GPU
    if (objects.version !== this.lastTargetsVersion) {
      this.lastTargetsVersion = objects.version;
      const clouds = objects.cloudData();
      this.node.port.postMessage(
        { type: 'clouds', data: clouds },
        clouds.filter((c): c is Float32Array => c !== null).map((c) => c.buffer),
      );
      const images = objects.audioImages();
      this.node.port.postMessage(
        { type: 'audioImages', data: images },
        images.filter((i): i is { size: number; data: Uint8Array } => i !== null).map((i) => i.data.buffer),
      );
    }

    this.node.port.postMessage({
      type: 'params',
      data: {
        tau: lifespanToTau(state.lifespan),
        density: state.density,
        scale: state.scale,
        colorRandom: state.colorRandom,
        sizeRandom: state.sizeRandom,
        smear: state.smear,
        asymmetry: state.asymmetry,
        tint: [state.tint.r, state.tint.g, state.tint.b],
        gain: state.gain,
        fieldGain: state.fieldGain,
        objectGain: state.objectGain,
        // worklet time = currentTime + timeOffset  ==  app tSec
        timeOffset: tSec - this.ctx.currentTime,
        listener: [_listener.x, _listener.y, _listener.z],
        right: [_right.x, _right.y, _right.z],
        transport: this.transportFlag,
        listenerVel,
        boundsMin: [
          FIELD_CENTER.x - FIELD_HALF_EXTENTS.x,
          FIELD_CENTER.y - FIELD_HALF_EXTENTS.y,
          FIELD_CENTER.z - FIELD_HALF_EXTENTS.z,
        ],
        boundsSize: [
          FIELD_HALF_EXTENTS.x * 2,
          FIELD_HALF_EXTENTS.y * 2,
          FIELD_HALF_EXTENTS.z * 2,
        ],
        stride,
        particleCount: count,
        heroCount: 32,
        objects: objects.audioDescriptors(state.scale),
      },
    });
  }
}
