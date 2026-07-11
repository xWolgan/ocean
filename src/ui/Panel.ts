import GUI from 'lil-gui';
import type { ModulationBus } from '../state/ModulationBus';
import type { Interaction } from '../input/Interaction';

export const PARTICLE_COUNTS: Record<string, number> = {
  '16k': 1 << 14,
  '65k': 1 << 16,
  '131k': 1 << 17,
  '262k': 1 << 18,
  '524k': 1 << 19,
  '1M': 1 << 20,
};

/**
 * The instrument's front panel. Sliders edit the bus's BASE values (the
 * patch); modulation arrives on top of them through the matrix. The
 * "max strength" slider is literally a route amount — the first visible
 * patch cord: playerA.touch → attractorStrength.
 */
export function createPanel(
  bus: ModulationBus,
  interaction: Interaction,
  settings: { particleCount: number },
  onParticleCountChange: (count: number) => void,
): GUI {
  const gui = new GUI({ title: 'OCEAN — substance' });
  const base = bus.base;

  // .listen() so sliders track values changed from elsewhere (presets, automation)
  const field = gui.addFolder('field');
  field.add(base, 'density', 0, 1, 0.001).name('density').listen();
  field.add(base, 'scale', 0, 1, 0.001).name('scale (pitch: big = low)').listen();
  field.add(base, 'lifespan', 0, 1, 0.001).name('lifespan (duration)').listen();
  field.add(base, 'smear', 0, 1, 0.001).name('smear (envelope softness)').listen();
  field.add(base, 'asymmetry', -1, 1, 0.001).name('asymmetry (appear ↔ vanish)').listen();

  const color = gui.addFolder('color');
  color.addColor(bus, 'baseTint').name('tint (hue→timbre, sat→richness)').listen();

  // dispersions: each property of the substance has a mean and a scatter
  const rand = gui.addFolder('randomness');
  rand.add(base, 'colorRandom', 0, 1, 0.001).name('color (timbre)').listen();
  rand.add(base, 'sizeRandom', 0, 1, 0.001).name('size (pitch spread)').listen();

  const attractor = gui.addFolder('attractor');
  attractor.add(base, 'attractorRadius', 0.2, 3, 0.01).name('radius').listen();
  attractor
    .add(interaction.touchRoute, 'amount', 0, 1, 0.01)
    .name('touch → strength (route)')
    .listen();

  const audio = gui.addFolder('audio');
  audio.add(base, 'gain', 0, 1, 0.01).name('gain').listen();

  const perf = gui.addFolder('performance');
  perf
    .add(settings, 'particleCount', PARTICLE_COUNTS)
    .name('particles')
    .onChange((v: number) => onParticleCountChange(v));

  // visual-only parameters with no audible twin yet
  const unbound = gui.addFolder('unbound');
  unbound.add(base, 'speed', 0, 1, 0.001).name('speed (visual drift)').listen();

  return gui;
}
