import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { XRButton } from 'three/addons/webxr/XRButton.js';

import { createFieldState, FIELD_CENTER } from './state/FieldState';
import { ParticleField } from './field/ParticleField';
import { AudioEngine } from './audio/AudioEngine';
import { Interaction } from './input/Interaction';
import { createPanel } from './ui/Panel';

const state = createFieldState();
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

let field = new ParticleField(settings.particleCount);
scene.add(field.mesh);

function setParticleCount(count: number): void {
  scene.remove(field.mesh);
  field.dispose();
  field = new ParticleField(count);
  scene.add(field.mesh);
}

const audio = new AudioEngine();
const interaction = new Interaction(camera, state, renderer.domElement);
createPanel(state, interaction, settings, setParticleCount);

document.body.appendChild(XRButton.createButton(renderer));

// browsers require a user gesture before audio may start
const hint = document.getElementById('hint')!;
window.addEventListener(
  'pointerdown',
  () => {
    void audio.start();
    hint.style.opacity = '0';
  },
  { once: true },
);

// --- stats overlay ---
const statsEl = document.getElementById('stats')!;
let fpsEma = 0;
let statsTimer = 0;

// dev hook for automated verification and console experiments
Object.assign(window, { __ocean: { state, audio, renderer, get field() { return field; } } });
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
      `particles ${Math.round(field.count * state.density).toLocaleString()}\n` +
      `voices    ${audio.voiceCount}\n` +
      `backend   ${renderer.backend.constructor.name.replace('Backend', '')}`;
  }

  interaction.update(dt);
  field.update(state, tSec, dt);
  audio.update(state, camera, tSec, field.sonicStride);
  controls.update();

  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
