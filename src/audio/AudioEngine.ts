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

  /** Latest audible voice count reported by the worklet, for the overlay. */
  voiceCount = 0;
  /** Latest bed (non-hero) voice count reported by the worklet, for the overlay. */
  bedCount = 0;
  /** Human-readable engine state for the overlay (remote debugging). */
  status = 'off (click to start)';

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  async start(): Promise<void> {
    try {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        this.status = this.ctx.state;
        return;
      }
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      // ?audio=legacy loads the frozen pre-tile engine for A/B comparison
      const engineFile =
        new URLSearchParams(location.search).get('audio') === 'legacy'
          ? 'granular-legacy.js'
          : 'granular-processor.js';
      await this.ctx.audioWorklet.addModule(
        `${import.meta.env.BASE_URL}${engineFile}`,
      );
      this.node = new AudioWorkletNode(this.ctx, 'ocean-granular', {
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
      this.node.connect(this.ctx.destination);
      this.status = this.ctx.state;
    } catch (err) {
      // reset so the next click retries from scratch instead of reusing
      // a half-built context; surface the reason in the stats overlay
      this.status = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
      this.node = null;
      void this.ctx?.close();
      this.ctx = null;
    }
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
