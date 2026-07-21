import * as THREE from 'three/webgpu';
import { buildRoom } from './RoomScene';
import { RoomController } from './Controller';
import { loadRoom, detectEditMode, flushSave, setSaveErrorHandler } from './store';
import type { RoomData, RoomItem } from './store';
import { ItemView } from './items';
import { RoomEditor } from './editor';
import { toast } from './ui';
import { ModulationBus } from '../state/ModulationBus';
import { ObjectManager } from '../objects/ObjectManager';
import { ParticleField } from '../field/ParticleField';
import { PaperPlanes } from './planes';

/** Reference room — a dev-only shared moodboard (see intents/
 *  monika--reference-room.md). Runs on the artwork's renderer so the
 *  arched window in the north wall looks out at the REAL substance:
 *  the same deterministic particle field, mounted read-only beyond the
 *  wall. Strictly one-way — the artwork knows nothing about the room. */

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
// the artwork's void: what you see through the window past the particles
scene.background = new THREE.Color(0x000004);
const camera = new THREE.PerspectiveCamera(
  65,
  window.innerWidth / window.innerHeight,
  0.05,
  100,
);

const walls = buildRoom(scene);
const controller = new RoomController(camera, renderer.domElement);

// the ocean outside: a private, view-only instance of the substance
// (65k particles — a window view, not the full composition)
const bus = new ModulationBus();
const fieldObjects = new ObjectManager();
const field = new ParticleField(1 << 16, fieldObjects.targetTexture, fieldObjects.imageTextures);
scene.add(field.mesh);

// one paper airplane a minute drifts in through the window
const planes = new PaperPlanes(scene);

// Alegreya (SIL OFL 1.1; subset files from Google Fonts, bundled so both
// studios render identically, offline too) — the wall-writing typeface.
// Loaded BEFORE the views are built so canvas text never falls back.
try {
  const faces = [
    new FontFace('Alegreya', 'url(/src/room/alegreya-latin.woff2)', {
      unicodeRange:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    }),
    new FontFace('Alegreya', 'url(/src/room/alegreya-latin-ext.woff2)', {
      unicodeRange:
        'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
    }),
  ];
  await Promise.all(faces.map((f) => f.load().then((l) => document.fonts.add(l))));
} catch {
  /* canvas falls back to serif — the room still works */
}

const data: RoomData = await loadRoom();
const views = new Map<string, ItemView>();
const aniso =
  (renderer as unknown as { capabilities?: { getMaxAnisotropy?: () => number } }).capabilities?.getMaxAnisotropy?.() ?? 4;

async function spawnView(item: RoomItem): Promise<ItemView> {
  const view = await ItemView.create(item, aniso, (aspect) => {
    item.aspect = aspect;
    view.applyTransform(walls);
  });
  view.applyTransform(walls);
  views.set(item.id, view);
  scene.add(view.group);
  return view;
}

function removeView(id: string): void {
  const view = views.get(id);
  if (!view) return;
  view.dispose();
  views.delete(id);
}

async function rebuildAll(): Promise<void> {
  for (const id of [...views.keys()]) removeView(id);
  await Promise.all(data.items.map((i) => spawnView(i)));
}

await rebuildAll();

const editMode = await detectEditMode();
const hint = document.getElementById('hint')!;
let editor: RoomEditor | null = null;
if (editMode) {
  setSaveErrorHandler(() => toast('Nie udało się zapisać — czy serwer dev działa?'));
  editor = new RoomEditor({
    data,
    views,
    walls,
    camera,
    dom: renderer.domElement,
    controller,
    spawnView,
    removeView,
    rebuildAll,
  });
  window.addEventListener('beforeunload', flushSave);
  if (data.items.length === 0)
    toast('Pusty pokój — upuść obraz lub film na ścianę');
} else {
  hint.textContent = 'WASD: walk · shift: fast · right-drag: look (read-only view)';
}

// dev hook for automated probes, mirroring the artwork's __ocean
Object.assign(window, { __room: { data, views, camera, walls, editMode, editor, bus, field, planes } });

// the same kind of clock the artwork uses: the field is a pure function
// of time on this timeline
const epoch = performance.now();
let last = performance.now();
renderer.setAnimationLoop((now: number) => {
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  const tSec = (performance.now() - epoch) / 1000;
  controller.update(dt);
  planes.update(dt);
  bus.update();
  fieldObjects.update(dt);
  field.update(bus.out, tSec, dt);
  field.updateObjects(fieldObjects, bus.out.scale);
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
