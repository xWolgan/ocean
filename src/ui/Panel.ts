import GUI from 'lil-gui';
import type { FieldState } from '../state/FieldState';
import type { Interaction } from '../input/Interaction';

export const PARTICLE_COUNTS: Record<string, number> = {
  '16k': 1 << 14,
  '65k': 1 << 16,
  '131k': 1 << 17,
  '262k': 1 << 18,
  '524k': 1 << 19,
  '1M': 1 << 20,
};

/** lil-gui control panel over the FieldState — the kernel's front panel. */
export function createPanel(
  state: FieldState,
  interaction: Interaction,
  settings: { particleCount: number },
  onParticleCountChange: (count: number) => void,
): GUI {
  const gui = new GUI({ title: 'OCEAN — substance' });

  // .listen() so sliders track state changed from elsewhere (later: composed automation)
  const field = gui.addFolder('field');
  field.add(state, 'density', 0, 1, 0.001).name('density').listen();
  field.add(state, 'speed', 0, 1, 0.001).name('speed').listen();
  field.add(state, 'scale', 0, 1, 0.001).name('scale').listen();
  field.add(state, 'lifespan', 0, 1, 0.001).name('lifespan').listen();

  const color = gui.addFolder('color');
  color.addColor(state, 'tint').name('tint').listen();
  color.add(state, 'colorRandom', 0, 1, 0.001).name('randomness').listen();

  const attractor = gui.addFolder('attractor');
  attractor.add(state.attractor, 'radius', 0.2, 3, 0.01).name('radius');
  attractor.add(interaction, 'strengthMax', 0, 1, 0.01).name('max strength');

  const audio = gui.addFolder('audio');
  audio.add(state, 'gain', 0, 1, 0.01).name('gain');

  const perf = gui.addFolder('performance');
  perf
    .add(settings, 'particleCount', PARTICLE_COUNTS)
    .name('particles')
    .onChange((v: number) => onParticleCountChange(v));

  return gui;
}
