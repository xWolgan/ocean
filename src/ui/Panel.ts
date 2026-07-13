import GUI from 'lil-gui';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ModulationBus } from '../state/ModulationBus';
import type { Interaction, AuthoringMode } from '../input/Interaction';
import type { CompositorAids } from './CompositorAids';
import { ObjectManager, SLOT_COUNT } from '../objects/ObjectManager';

export const PARTICLE_COUNTS: Record<string, number> = {
  '16k': 1 << 14,
  '65k': 1 << 16,
  '131k': 1 << 17,
  '262k': 1 << 18,
  '524k': 1 << 19,
  '1M': 1 << 20,
};

/** The compositor's front panel: ambient substance (the environment's
 *  tuning) + the objects (the instruments), + scene save/load. */
export function createPanel(
  bus: ModulationBus,
  interaction: Interaction,
  objects: ObjectManager,
  aids: CompositorAids,
  controls: OrbitControls,
  settings: { particleCount: number },
  onParticleCountChange: (count: number) => void,
): GUI {
  const gui = new GUI({ title: 'OCEAN — compositor' });
  const base = bus.base;

  // --- ambient substance ---
  const field = gui.addFolder('field');
  field.add(base, 'density', 0, 1, 0.001).name('density').listen();
  field.add(base, 'scale', 0, 1, 0.001).name('scale (pitch: big = low)').listen();
  field.add(base, 'lifespan', 0, 1, 0.001).name('lifespan (duration)').listen();
  field.add(base, 'smear', 0, 1, 0.001).name('smear').listen();
  field.add(base, 'asymmetry', -1, 1, 0.001).name('asymmetry').listen();
  field.close();

  const color = gui.addFolder('color');
  color.addColor(bus, 'baseTint').name('tint').listen();
  const rand = gui.addFolder('randomness');
  rand.add(base, 'colorRandom', 0, 1, 0.001).name('color (timbre)').listen();
  rand.add(base, 'sizeRandom', 0, 1, 0.001).name('size (pitch spread)').listen();
  color.close();
  rand.close();

  // --- authoring ---
  const author = gui.addFolder('create object');
  const modes: AuthoringMode[] = ['play', 'point', 'curve', 'sphere', 'box', 'image'];
  author
    .add(interaction, 'mode', modes)
    .name('mode (then click/draw in field)')
    .listen();
  author.add(interaction, 'planeHeight', 0.2, 2.8, 0.05).name('placement height');
  author
    .add(
      {
        loadImage() {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.onchange = () => {
            const f = input.files?.[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = () => {
              interaction.pendingImage = { src: reader.result as string };
              interaction.mode = 'image';
            };
            reader.readAsDataURL(f);
          };
          input.click();
        },
      },
      'loadImage',
    )
    .name('load image → then click to place');

  // --- objects (the instruments) ---
  const objFolder = gui.addFolder('objects');
  objFolder.add(aids, 'showMarkers').name('show object markers');
  let tuning: GUI | null = null;

  function rebuildTuning(): void {
    tuning?.destroy();
    tuning = null;
    const inst = objects.slots[objects.selected];
    if (!inst) return;
    tuning = objFolder.addFolder(`tuning: ${inst.def.name}`);
    const d = inst.def;
    tuning.add(d, 'active').name('active (latched)').listen();
    tuning.add(d, 'attack', 0.02, 10, 0.01).name('attack (attraction speed)');
    const rel = { seconds: Number.isFinite(d.release) ? d.release : 10, permanent: !Number.isFinite(d.release) };
    const apply = () => (d.release = rel.permanent ? Infinity : rel.seconds);
    tuning.add(rel, 'seconds', 0.05, 10, 0.05).name('release (trace)').onChange(apply);
    tuning.add(rel, 'permanent').name('permanent trace (∞)').onChange(apply);
    tuning.add(d, 'influenceRadius', 0, 6, 0.05).name('attraction distance');
    tuning.add(d, 'spatialSmear', 0, 0.5, 0.005).name('spatial smear');
    tuning.add(d, 'claim', 0, 1, 0.01).name('claim (pool share)');
    const p = d.patch;
    tuning.add(p.lifespan, 'value', 0, 1, 0.001).name('lifespan (pulse pitch)');
    tuning.add(p.lifespan, 'weight', 0, 1, 0.01).name('  ↳ weight');
    tuning.add(p.scale, 'value', 0, 1, 0.001).name('scale (register)');
    tuning.add(p.scale, 'weight', 0, 1, 0.01).name('  ↳ weight');
    tuning.add(p, 'octave', -3, 2, 1).name('octave (lower = slower)');
    // a persistent proxy object: lil-gui mutates it in place, onChange
    // copies into the patch (a getter returning copies never writes back)
    const tint = { color: { r: p.tintR, g: p.tintG, b: p.tintB } };
    tuning
      .addColor(tint, 'color')
      .name('tint')
      .onChange((c: { r: number; g: number; b: number }) => {
        p.tintR = c.r;
        p.tintG = c.g;
        p.tintB = c.b;
      });
    tuning.add(p, 'tintWeight', 0, 1, 0.01).name('  ↳ weight');
    tuning.add(p, 'imageColor', 0, 1, 0.01).name('image color (settings ↔ image)');
    if (d.generator.kind === 'image') {
      const g = d.generator;
      if (g.thickness === undefined) g.thickness = 0.002;
      if (g.zeroThickness === undefined) g.zeroThickness = false;
      tuning.add(g, 'thickness', 0.001, 0.2, 0.001).name('surface thickness (m)');
      tuning.add(g, 'zeroThickness').name('zero thickness (exact plane)');
    }
    tuning.add(p.colorRandom, 'value', 0, 1, 0.001).name('color random (timbre)');
    tuning.add(p.colorRandom, 'weight', 0, 1, 0.01).name('  ↳ weight');
    tuning.add(p.sizeRandom, 'value', 0, 1, 0.001).name('size random (pitch spread)');
    tuning.add(p.sizeRandom, 'weight', 0, 1, 0.01).name('  ↳ weight');
    tuning.add(p.smear, 'value', 0, 1, 0.001).name('smear');
    tuning.add(p.smear, 'weight', 0, 1, 0.01).name('  ↳ weight');
    tuning.add(p.asymmetry, 'value', -1, 1, 0.001).name('asymmetry');
    tuning.add(p.asymmetry, 'weight', 0, 1, 0.01).name('  ↳ weight');
    tuning.add(p, 'sync', 0, 1, 0.01).name('sync (cloud ↔ tone)');
    tuning.add(p, 'gain', 0, 1.5, 0.01).name('gain (this object)');
    tuning
      .add(
        {
          lookAt() {
            const c = objects.slots[objects.selected]?.cloud;
            if (c) controls.target.copy(c.center);
          },
        },
        'lookAt',
      )
      .name('look at it (find lost object)');
    tuning
      .add(
        {
          remove() {
            objects.remove(objects.selected);
            rebuildList();
          },
        },
        'remove',
      )
      .name('delete object');
  }

  const listState = { selected: '0' };
  let listController: ReturnType<GUI['add']> | null = null;

  function rebuildList(): void {
    const names: Record<string, string> = {};
    for (let m = 0; m < SLOT_COUNT; m++) {
      const inst = objects.slots[m];
      if (inst) names[`${m}: ${inst.def.name}`] = String(m);
    }
    listController?.destroy();
    listState.selected = String(objects.selected);
    listController = objFolder
      .add(listState, 'selected', names)
      .name('selected (touch plays it)')
      .onChange((v: string) => {
        objects.selected = parseInt(v, 10);
        rebuildTuning();
      });
    rebuildTuning();
  }
  rebuildList();
  interaction.onObjectsChanged = rebuildList;

  // --- scene save/load ---
  const scene = gui.addFolder('scene');
  scene
    .add(
      {
        save() {
          const data = JSON.stringify(
            { version: 1, bases: { ...base }, tint: bus.baseTint.getHex(), ...objects.serialize() },
            (_k, v) => (v === Infinity ? 'Infinity' : v),
            1,
          );
          localStorage.setItem('ocean-scene', data);
          const blob = new Blob([data], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'ocean-scene.json';
          a.click();
        },
      },
      'save',
    )
    .name('save scene (file + local)');
  scene
    .add(
      {
        load() {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'application/json';
          input.onchange = () => {
            const f = input.files?.[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = () => void applyScene(reader.result as string);
            reader.readAsText(f);
          };
          input.click();
        },
      },
      'load',
    )
    .name('load scene file');

  async function applyScene(json: string): Promise<void> {
    const data = JSON.parse(json, (_k, v) => (v === 'Infinity' ? Infinity : v));
    if (data.bases) Object.assign(base, data.bases);
    if (data.tint !== undefined) bus.baseTint.setHex(data.tint);
    await objects.deserialize(data);
    rebuildList();
  }

  const perf = gui.addFolder('performance');
  perf
    .add(settings, 'particleCount', PARTICLE_COUNTS)
    .name('particles')
    .onChange((v: number) => onParticleCountChange(v));
  perf.close();

  const audio = gui.addFolder('audio');
  audio.add(base, 'gain', 0, 1, 0.01).name('master gain').listen();
  audio.add(base, 'fieldGain', 0, 1, 0.01).name('environment gain').listen();
  audio.add(base, 'objectGain', 0, 1, 0.01).name('objects gain').listen();

  const unbound = gui.addFolder('unbound');
  unbound.add(base, 'speed', 0, 1, 0.001).name('speed (visual drift)').listen();
  unbound.close();

  return gui;
}
