import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XRButton } from 'three/addons/webxr/XRButton.js';

import { FIELD_CENTER } from './state/FieldState';
import { ModulationBus } from './state/ModulationBus';
import { ParticleField } from './field/ParticleField';
import { AudioEngine } from './audio/AudioEngine';
import { Interaction } from './input/Interaction';
import { createPanel } from './ui/Panel';
import { ObjectManager } from './objects/ObjectManager';
import { createObjectDef } from './objects/ObjectDef';
import { CompositorAids } from './ui/CompositorAids';

const bus = new ModulationBus();
const objects = new ObjectManager();
const settings = { particleCount: 1 << 17 };

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(new THREE.Color(0x000004));
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.05,
  100,
);
camera.position.set(0, 1.7, 4.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(FIELD_CENTER).setY(1.4);
controls.enableDamping = true;
// left button belongs to the instrument; orbit with the right button
controls.mouseButtons = {
  LEFT: null as unknown as THREE.MOUSE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};

let field = new ParticleField(settings.particleCount, objects.targetTexture, objects.imageTextures);
scene.add(field.mesh);

function setParticleCount(count: number): void {
  scene.remove(field.mesh);
  field.dispose();
  field = new ParticleField(count, objects.targetTexture, objects.imageTextures);
  scene.add(field.mesh);
}

// the first instrument: a point object at the field's heart
void objects.add(createObjectDef({ kind: 'point', position: [0, 1.5, 0], sigma: 0.3 }));

const audio = new AudioEngine();
const interaction = new Interaction(camera, bus, objects, renderer.domElement);
const aids = new CompositorAids();
scene.add(aids.group);
createPanel(bus, interaction, objects, aids, controls, settings, setParticleCount);

// --- WASD fly navigation (desktop compositor) ---
const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
const _fwd = new THREE.Vector3();
const _rightDir = new THREE.Vector3();
const _move = new THREE.Vector3();

function applyMovement(dt: number): void {
  _move.set(0, 0, 0);
  camera.getWorldDirection(_fwd);
  _fwd.y = 0;
  _fwd.normalize();
  _rightDir.crossVectors(_fwd, camera.up).normalize();
  if (keys.has('KeyW')) _move.add(_fwd);
  if (keys.has('KeyS')) _move.sub(_fwd);
  if (keys.has('KeyD')) _move.add(_rightDir);
  if (keys.has('KeyA')) _move.sub(_rightDir);
  if (keys.has('KeyE')) _move.y += 1;
  if (keys.has('KeyQ')) _move.y -= 1;
  if (_move.lengthSq() === 0) return;
  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 6 : 2;
  _move.normalize().multiplyScalar(speed * dt);
  camera.position.add(_move);
  controls.target.add(_move);
}

document.body.appendChild(XRButton.createButton(renderer));

// browsers require a user gesture before audio may start; RETRY on every
// click until it actually runs (a failed first attempt must not consume
// the only chance — that made failures permanently silent)
const hint = document.getElementById('hint')!;
window.addEventListener('pointerdown', () => {
  if (!audio.running) void audio.start();
  hint.style.opacity = '0';
});

// --- stats overlay ---
const statsEl = document.getElementById('stats')!;
let fpsEma = 0;
let statsTimer = 0;

// dev hook for automated verification and console experiments
Object.assign(window, {
  __ocean: { bus, objects, state: bus.out, audio, renderer, get field() { return field; } },
  __oceanSetCount: setParticleCount,
});
console.log('[ocean] backend:', renderer.backend.constructor.name);

// --- main loop ---
// the shared clock: both the GPU field and the audio worklet render the
// same deterministic flash process on this timeline
const epoch = performance.now();
let frameLogged = false;
let last = performance.now();
renderer.setAnimationLoop((now: number) => {
  if (!frameLogged) {
    frameLogged = true;
    console.log('[ocean] first frame');
  }
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  const tSec = (performance.now() - epoch) / 1000;

  fpsEma = fpsEma * 0.95 + (dt > 0 ? 1 / dt : 0) * 0.05;
  statsTimer += dt;
  if (statsTimer > 0.25) {
    statsTimer = 0;
    statsEl.textContent =
      `fps       ${fpsEma.toFixed(0)}\n` +
      `particles ${Math.round(field.count * bus.out.density).toLocaleString()}\n` +
      `voices    ${audio.voiceCount} heroes + ~${audio.bedCount.toLocaleString()} bed\n` +
      `audio     ${audio.status}\n` +
      `backend   ${(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2'}`;
  }

  applyMovement(dt);
  interaction.update(dt);
  bus.update();
  // the touch signal gates the selected object — playing an instrument
  objects.touchGate = bus.source('playerA.touch').value;
  objects.update(dt);
  field.update(bus.out, tSec, dt);
  field.updateObjects(objects, bus.out.scale);
  aids.update(interaction, objects, tSec);
  audio.update(bus.out, camera, tSec, field.sonicStride, objects, field.count);
  controls.update();

  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
