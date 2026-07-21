import * as THREE from 'three';
import { buildRoom } from './RoomScene';
import { RoomController } from './Controller';
import { loadRoom, detectEditMode, flushSave, setSaveErrorHandler } from './store';
import type { RoomData, RoomItem } from './store';
import { ItemView } from './items';
import { RoomEditor } from './editor';
import { toast } from './ui';

/** Reference room — a dev-only shared moodboard (see intents/
 *  monika--reference-room.md). Plain WebGL on purpose: no TSL, no
 *  compute, nothing shared with the artwork's deterministic twins. */

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101014);
const camera = new THREE.PerspectiveCamera(
  65,
  window.innerWidth / window.innerHeight,
  0.05,
  50,
);

const walls = buildRoom(scene);
const controller = new RoomController(camera, renderer.domElement);

const data: RoomData = await loadRoom();
const views = new Map<string, ItemView>();

async function spawnView(item: RoomItem): Promise<ItemView> {
  const view = await ItemView.create(item, renderer, (aspect) => {
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
Object.assign(window, { __room: { data, views, camera, walls, editMode, editor } });

let last = performance.now();
renderer.setAnimationLoop((now: number) => {
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  controller.update(dt);
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
