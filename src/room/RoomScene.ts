import * as THREE from 'three';

/** Room shell: 8 × 3 × 8 m, floor at y = 0, centered on the origin.
 *  Four inside-facing walls act as pinboards; a Wall descriptor gives
 *  every other module one shared wall-local coordinate system. */

export const ROOM_W = 8;
export const ROOM_H = 3;
export const ROOM_D = 8;

export interface Wall {
  index: 0 | 1 | 2 | 3;
  mesh: THREE.Mesh;
  /** inside-face bottom-left corner (as seen facing the wall) */
  origin: THREE.Vector3;
  /** unit vector along the wall's width, left → right facing it */
  uDir: THREE.Vector3;
  /** unit vector up the wall */
  vDir: THREE.Vector3;
  /** into the room */
  normal: THREE.Vector3;
  width: number;
  height: number;
}

/** world point for wall-local (u, v) in 0..1, lifted off the surface a hair */
export function wallPoint(w: Wall, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
  return out
    .copy(w.origin)
    .addScaledVector(w.uDir, u * w.width)
    .addScaledVector(w.vDir, v * w.height)
    .addScaledVector(w.normal, 0.01);
}

export function pointToUV(w: Wall, p: THREE.Vector3): { u: number; v: number } {
  const rel = p.clone().sub(w.origin);
  return { u: rel.dot(w.uDir) / w.width, v: rel.dot(w.vDir) / w.height };
}

/** faint 0.5 m alignment grid, drawn once onto a tiny repeated texture */
function gridTexture(base: string, line: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, 127.5, 127.5);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildRoom(scene: THREE.Scene): Wall[] {
  const halfW = ROOM_W / 2;
  const halfD = ROOM_D / 2;

  const wallTex = gridTexture('#3a3f4a', '#434959');
  wallTex.repeat.set(ROOM_W / 0.5, ROOM_H / 0.5);
  const wallMat = new THREE.MeshLambertMaterial({ map: wallTex });

  const walls: Wall[] = [];
  // index 0 = north (−z), then east (+x), south (+z), west (−x);
  // uDir chosen so u runs left→right for a viewer INSIDE facing the wall
  const defs: Array<{
    index: 0 | 1 | 2 | 3;
    center: [number, number, number];
    yaw: number;
    origin: [number, number, number];
    uDir: [number, number, number];
    normal: [number, number, number];
  }> = [
    { index: 0, center: [0, ROOM_H / 2, -halfD], yaw: 0, origin: [-halfW, 0, -halfD], uDir: [1, 0, 0], normal: [0, 0, 1] },
    { index: 1, center: [halfW, ROOM_H / 2, 0], yaw: -Math.PI / 2, origin: [halfW, 0, -halfD], uDir: [0, 0, 1], normal: [-1, 0, 0] },
    { index: 2, center: [0, ROOM_H / 2, halfD], yaw: Math.PI, origin: [halfW, 0, halfD], uDir: [-1, 0, 0], normal: [0, 0, -1] },
    { index: 3, center: [-halfW, ROOM_H / 2, 0], yaw: Math.PI / 2, origin: [-halfW, 0, halfD], uDir: [0, 0, -1], normal: [1, 0, 0] },
  ];
  for (const d of defs) {
    const geo = new THREE.PlaneGeometry(ROOM_W, ROOM_H);
    const mesh = new THREE.Mesh(geo, wallMat);
    mesh.position.set(...d.center);
    mesh.rotation.y = d.yaw;
    mesh.userData.wallIndex = d.index;
    scene.add(mesh);
    walls.push({
      index: d.index,
      mesh,
      origin: new THREE.Vector3(...d.origin),
      uDir: new THREE.Vector3(...d.uDir),
      vDir: new THREE.Vector3(0, 1, 0),
      normal: new THREE.Vector3(...d.normal),
      width: ROOM_W,
      height: ROOM_H,
    });
  }

  const floorTex = gridTexture('#22252d', '#2a2e38');
  floorTex.repeat.set(ROOM_W / 0.5, ROOM_D / 0.5);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_W, ROOM_D),
    new THREE.MeshLambertMaterial({ map: floorTex }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_W, ROOM_D),
    new THREE.MeshLambertMaterial({ color: 0x4a4f5c }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_H;
  scene.add(ceiling);

  scene.add(new THREE.HemisphereLight(0xf2f4fa, 0x565a66, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 0.55);
  sun.position.set(2, 4, 1);
  scene.add(sun);

  return walls;
}
