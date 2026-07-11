import type { FieldState } from '../state/FieldState';
import { FIELD_HALF_EXTENTS } from '../state/FieldState';

/**
 * Main-thread wrapper for the granular AudioWorklet. Must be started from
 * a user gesture (browser autoplay policy). Streams FieldState to the
 * worklet at control rate with in-worklet smoothing.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private lastSend = 0;

  /** Latest grain count reported back by the worklet, for the stats overlay. */
  grainCount = 0;

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
      if (e.data.type === 'stats') this.grainCount = e.data.grains;
    };
    this.node.connect(this.ctx.destination);
  }

  /** Call every frame; internally throttled to ~60 Hz. */
  update(state: FieldState, timeMs: number): void {
    if (!this.node || timeMs - this.lastSend < 16) return;
    this.lastSend = timeMs;
    this.node.port.postMessage({
      type: 'params',
      data: {
        density: state.density,
        speed: state.speed,
        scale: state.scale,
        colorRandom: state.colorRandom,
        lifespan: state.lifespan,
        gain: state.gain,
        attractorStrength: state.attractor.strength,
        attractorPan: Math.max(
          -1,
          Math.min(1, state.attractor.position.x / FIELD_HALF_EXTENTS.x),
        ),
      },
    });
  }
}
