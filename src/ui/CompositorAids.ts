import * as THREE from 'three/webgpu';
import type { Interaction } from '../input/Interaction';
import { ObjectManager, SLOT_COUNT } from '../objects/ObjectManager';

const SLOT_COLORS = [0x66ccff, 0xffaa55, 0x88ff88, 0xff77cc, 0xffee66, 0x9988ff, 0x66ffdd, 0xff6666];

/**
 * Visual placement aids for the compositor: a grid on the placement
 * plane + a 3D cursor with a drop-line (depth is unreadable on a flat
 * screen without one), and a small color-coded marker at every object's
 * center so instruments can't get lost in the noise.
 */
export class CompositorAids {
  readonly group = new THREE.Group();
  showMarkers = true;

  private readonly grid: THREE.GridHelper;
  private readonly cursor: THREE.Mesh;
  private readonly dropLine: THREE.Line;
  private readonly floorRing: THREE.Mesh;
  private readonly markers: THREE.Mesh[] = [];
  private readonly previewSphere: THREE.Mesh;
  private readonly previewBox: THREE.Mesh;
  private readonly previewRect: THREE.LineLoop;
  private readonly previewLine: THREE.Line;
  private readonly previewLinePositions: THREE.BufferAttribute;

  constructor() {
    this.grid = new THREE.GridHelper(6, 12, 0x335566, 0x152535);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.group.add(this.grid);

    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.06, 0.09, 24),
      new THREE.MeshBasicMaterial({ color: 0x77ddff, side: THREE.DoubleSide }),
    );
    this.cursor.rotation.x = -Math.PI / 2;
    this.group.add(this.cursor);

    this.dropLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x77ddff, transparent: true, opacity: 0.6 }),
    );
    this.group.add(this.dropLine);

    this.floorRing = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.12, 24),
      new THREE.MeshBasicMaterial({
        color: 0x77ddff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.5,
      }),
    );
    this.floorRing.rotation.x = -Math.PI / 2;
    this.group.add(this.floorRing);

    const previewMat = new THREE.MeshBasicMaterial({
      color: 0x77ddff,
      wireframe: true,
      transparent: true,
      opacity: 0.5,
    });
    this.previewSphere = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), previewMat);
    this.previewBox = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), previewMat.clone());
    const rectPts = [
      new THREE.Vector3(-1, -1, 0),
      new THREE.Vector3(1, -1, 0),
      new THREE.Vector3(1, 1, 0),
      new THREE.Vector3(-1, 1, 0),
    ];
    this.previewRect = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(rectPts),
      new THREE.LineBasicMaterial({ color: 0x77ddff, transparent: true, opacity: 0.7 }),
    );
    this.previewLinePositions = new THREE.BufferAttribute(new Float32Array(512 * 3), 3);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', this.previewLinePositions);
    lineGeo.setDrawRange(0, 0);
    this.previewLine = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.9 }),
    );
    for (const o of [this.previewSphere, this.previewBox, this.previewRect, this.previewLine]) {
      o.visible = false;
      this.group.add(o);
    }

    for (let m = 0; m < SLOT_COUNT; m++) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 10, 8),
        new THREE.MeshBasicMaterial({ color: SLOT_COLORS[m], wireframe: true }),
      );
      marker.visible = false;
      this.markers.push(marker);
      this.group.add(marker);
    }
  }

  update(interaction: Interaction, objects: ObjectManager, tSec: number): void {
    const authoring = interaction.mode !== 'play';
    this.grid.visible = authoring;
    this.grid.position.y = interaction.planeHeight;

    const c = interaction.cursorPos;
    const showCursor = authoring && c !== null;
    this.cursor.visible = showCursor;
    this.dropLine.visible = showCursor;
    this.floorRing.visible = showCursor;
    if (showCursor && c) {
      this.cursor.position.copy(c);
      this.floorRing.position.set(c.x, 0.01, c.z);
      const pts = this.dropLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      pts.setXYZ(0, c.x, 0, c.z);
      pts.setXYZ(1, c.x, c.y, c.z);
      pts.needsUpdate = true;
    }

    // live authoring preview: see what you are making before you release
    const pv = interaction.preview;
    this.previewSphere.visible = pv?.kind === 'sphere' || pv?.kind === 'point';
    this.previewBox.visible = pv?.kind === 'box';
    this.previewRect.visible = pv?.kind === 'image';
    this.previewLine.visible = pv?.kind === 'curve';
    if (pv && (pv.kind === 'sphere' || pv.kind === 'point')) {
      this.previewSphere.position.copy(pv.center);
      this.previewSphere.scale.setScalar(pv.radius);
    } else if (pv && pv.kind === 'box') {
      this.previewBox.position.copy(pv.center);
      this.previewBox.scale.setScalar(pv.radius);
    } else if (pv && pv.kind === 'image') {
      this.previewRect.position.copy(pv.center);
      this.previewRect.scale.set(pv.halfW, pv.halfH, 1);
    } else if (pv && pv.kind === 'curve') {
      const n = Math.min(512, pv.points.length);
      for (let i = 0; i < n; i++) {
        this.previewLinePositions.setXYZ(i, pv.points[i][0], pv.points[i][1], pv.points[i][2]);
      }
      this.previewLinePositions.needsUpdate = true;
      this.previewLine.geometry.setDrawRange(0, n);
    }

    for (let m = 0; m < SLOT_COUNT; m++) {
      const inst = objects.slots[m];
      const marker = this.markers[m];
      if (!this.showMarkers || !inst || !inst.cloud) {
        marker.visible = false;
        continue;
      }
      marker.visible = true;
      marker.position.copy(inst.cloud.center);
      const selected = m === objects.selected;
      const pulse = selected ? 1.3 + 0.3 * Math.sin(tSec * 5) : 1;
      marker.scale.setScalar(pulse);
      (marker.material as THREE.MeshBasicMaterial).opacity = selected ? 1 : 0.5;
      (marker.material as THREE.MeshBasicMaterial).transparent = true;
    }
  }
}
