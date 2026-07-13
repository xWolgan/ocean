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

  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  async start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    // BASE_URL so the worklet loads when the app is hosted on a subpath
    await this.ctx.audioWorklet.addModule(
      `${import.meta.env.BASE_URL}granular-processor.js`,
    );
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

  /**
   * Stream control state; internally throttled to ~60 Hz.
   * @param tSec   the app clock also driving the GPU field
   * @param stride particle index step between sonic samples
   */
  update(
    state: FieldState,
    camera: THREE.Camera,
    tSec: number,
    stride: number,
    objects: ObjectManager,
  ): void {
    if (!this.node || !this.ctx) return;
    const nowMs = performance.now();
    if (nowMs - this.lastSend < 16) return;
    this.lastSend = nowMs;

    camera.getWorldPosition(_listener);
    _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();

    const ambientRegisterHz = 180 * Math.pow(20, 1 - state.scale);

    // ship full constellations only when they change; the worklet samples
    // per-generation targets itself with the same hashes as the GPU
    if (objects.version !== this.lastTargetsVersion) {
      this.lastTargetsVersion = objects.version;
      const clouds = objects.cloudData();
      this.node.port.postMessage(
        { type: 'clouds', data: clouds },
        clouds.filter((c): c is Float32Array => c !== null).map((c) => c.buffer),
      );
    }

    this.node.port.postMessage({
      type: 'params',
      data: {
        tau: lifespanToTau(state.lifespan),
        density: state.density,
        registerHz: ambientRegisterHz,
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
        objects: objects.audioDescriptors(ambientRegisterHz),
      },
    });
  }
}
