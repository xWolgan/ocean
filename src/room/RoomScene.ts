import * as THREE from 'three/webgpu';

/** Room shell: 8 × 3 × 8 m, floor at y = 0. The room is shifted along
 *  +z so that the artwork's particle field (a 6×3×6 m box centered at
 *  (0, 1.5, 0) — bounds are baked into the field's shaders) lies just
 *  beyond the north wall: the arched window in that wall looks out at
 *  the real ocean. Four inside-facing walls act as pinboards; a Wall
 *  descriptor gives every other module one shared wall-local coordinate
 *  system. */

export const ROOM_W = 8;
export const ROOM_H = 4;
export const ROOM_D = 8;
/** room center on z: north wall inner face lands at z = 3.2, 0.2 m past
 *  the field volume (which ends at z = 3) */
export const ROOM_CZ = 7.2;
export const WALL_THICKNESS = 0.35;

// the window: a rectangle crowned with a semicircle, wall-local meters
// (slim and modest — Monika's second take after seeing the wide one)
const WIN_HALF_W = 0.55; // 1.1 m wide
const WIN_SILL = 0.9; // bottom edge above the floor
const WIN_RECT_TOP = 1.9; // where the arc takes over (apex at 2.45)

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

/** 3D-modeling-app floor: dark ground, grid lines in the wall color —
 *  a fine line every 0.5 m, a stronger one every meter. One canvas
 *  tile = 1 m, repeated. */
function floorGridTexture(bg: string, minor: string, major: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = minor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(128.5, 0);
  ctx.lineTo(128.5, 256);
  ctx.moveTo(0, 128.5);
  ctx.lineTo(256, 128.5);
  ctx.stroke();
  ctx.strokeStyle = major;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 254, 254);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** the north wall: a slab with the arched window punched through it —
 *  no frame, just the hole showing the wall's thickness */
function windowWallGeometry(): THREE.ExtrudeGeometry {
  const half = ROOM_H / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-ROOM_W / 2, -half);
  shape.lineTo(ROOM_W / 2, -half);
  shape.lineTo(ROOM_W / 2, half);
  shape.lineTo(-ROOM_W / 2, half);
  shape.closePath();

  const hole = new THREE.Path();
  hole.moveTo(-WIN_HALF_W, WIN_SILL - half);
  hole.lineTo(WIN_HALF_W, WIN_SILL - half);
  hole.lineTo(WIN_HALF_W, WIN_RECT_TOP - half);
  hole.absarc(0, WIN_RECT_TOP - half, WIN_HALF_W, 0, Math.PI, false);
  hole.closePath();
  shape.holes.push(hole);

  return new THREE.ExtrudeGeometry(shape, { depth: WALL_THICKNESS, bevelEnabled: false });
}

export function buildRoom(scene: THREE.Scene): Wall[] {
  const halfW = ROOM_W / 2;
  const halfD = ROOM_D / 2;
  const zN = ROOM_CZ - halfD; // north wall inner face
  const zS = ROOM_CZ + halfD;

  const wallTex = gridTexture('#e4e6eb', '#d6d9df');
  wallTex.repeat.set(ROOM_W / 0.5, ROOM_H / 0.5);
  const wallMat = new THREE.MeshLambertMaterial({ map: wallTex });
  // the extruded wall's UVs are in shape units (meters), not 0..1
  const winTex = gridTexture('#e4e6eb', '#d6d9df');
  winTex.repeat.set(2, 2);
  const winMat = new THREE.MeshLambertMaterial({ map: winTex });

  const walls: Wall[] = [];
  // index 0 = north (window wall, looks out at the ocean), then east,
  // south, west; uDir chosen so u runs left→right for a viewer INSIDE
  const defs: Array<{
    index: 0 | 1 | 2 | 3;
    origin: [number, number, number];
    uDir: [number, number, number];
    normal: [number, number, number];
  }> = [
    { index: 0, origin: [-halfW, 0, zN], uDir: [1, 0, 0], normal: [0, 0, 1] },
    { index: 1, origin: [halfW, 0, zN], uDir: [0, 0, 1], normal: [-1, 0, 0] },
    { index: 2, origin: [halfW, 0, zS], uDir: [-1, 0, 0], normal: [0, 0, -1] },
    { index: 3, origin: [-halfW, 0, zS], uDir: [0, 0, -1], normal: [1, 0, 0] },
  ];
  for (const d of defs) {
    let mesh: THREE.Mesh;
    if (d.index === 0) {
      // extrude runs 0..thickness along local +z (into the room for an
      // unrotated mesh); pull the slab back so its inner face sits
      // exactly on the pinboard plane z = zN
      mesh = new THREE.Mesh(windowWallGeometry(), winMat);
      mesh.position.set(0, ROOM_H / 2, zN - WALL_THICKNESS);
    } else {
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_H), wallMat);
      const yaw = d.index === 1 ? -Math.PI / 2 : d.index === 2 ? Math.PI : Math.PI / 2;
      mesh.rotation.y = yaw;
      mesh.position.set(
        (d.origin[0] + d.origin[0] + d.uDir[0] * ROOM_W) / 2,
        ROOM_H / 2,
        (d.origin[2] + d.origin[2] + d.uDir[2] * ROOM_W) / 2,
      );
    }
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

  const floorTex = floorGridTexture('#2b2e35', '#9599a3', '#c3c6cd');
  floorTex.repeat.set(ROOM_W, ROOM_D);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_W, ROOM_D),
    new THREE.MeshLambertMaterial({ map: floorTex }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = ROOM_CZ;
  scene.add(floor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_W, ROOM_D),
    new THREE.MeshLambertMaterial({ color: 0xdadce2 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, ROOM_H, ROOM_CZ);
  scene.add(ceiling);

  scene.add(new THREE.HemisphereLight(0xf2f4fa, 0x565a66, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 0.55);
  sun.position.set(2, 4, ROOM_CZ + 1);
  scene.add(sun);

  return walls;
}
