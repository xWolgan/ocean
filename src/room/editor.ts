import * as THREE from 'three';
import type { RoomData, RoomItem } from './store';
import { scheduleSave, uploadAsset } from './store';
import type { Wall } from './RoomScene';
import { pointToUV } from './RoomScene';
import type { ItemView } from './items';
import type { RoomController } from './Controller';
import { toast, openLightbox, openPanel, closePanel, showAddBar } from './ui';

const MARGIN = 0.1; // meters kept between items and wall edges
const MIN_W = 0.2;
const MAX_W = 3.4;
const MAX_IMAGE_EDGE = 2048;
const VIDEO_WARN = 25_000_000;
const VIDEO_MAX = 50_000_000;

type EditorState =
  | { mode: 'idle' }
  | { mode: 'selected'; id: string }
  | { mode: 'dragging'; id: string; du: number; dv: number; moved: boolean; startX: number; startY: number };

export interface EditorHost {
  data: RoomData;
  views: Map<string, ItemView>;
  walls: Wall[];
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  controller: RoomController;
  spawnView: (item: RoomItem) => Promise<ItemView>;
  removeView: (id: string) => void;
  rebuildAll: () => Promise<void>;
}

/** All editing: selection, dragging (also wall-to-wall), resizing,
 *  captions, delete/undo, file import. Lives only in edit mode. */
export class RoomEditor {
  private state: EditorState = { mode: 'idle' };
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly undoStack: string[] = [];
  private wheelSnapshotArmed = true;
  private captionSnapshotArmed = true;

  private readonly host: EditorHost;

  constructor(host: EditorHost) {
    this.host = host;
    const dom = host.dom;
    dom.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    dom.addEventListener('pointermove', (e) => this.onPointerMove(e));
    dom.addEventListener('pointerup', (e) => this.onPointerUp(e));
    dom.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e));

    // drag & drop from the desktop
    const veil = document.getElementById('dropveil')!;
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      veil.style.display = 'block';
    });
    window.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) veil.style.display = 'none';
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      veil.style.display = 'none';
      if (e.dataTransfer?.files.length)
        void this.importFiles(e.dataTransfer.files, this.wallUnderPointer(e));
    });

    showAddBar(
      (files) => void this.importFiles(files, null),
      (url) => void this.addLink(url),
    );
  }

  // --- picking helpers ------------------------------------------------

  private setRayFromEvent(e: { clientX: number; clientY: number }): void {
    this.ndc.set(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    this.ray.setFromCamera(this.ndc, this.host.camera);
  }

  private pickItem(e: PointerEvent): ItemView | null {
    this.setRayFromEvent(e);
    const planes = [...this.host.views.values()].map((v) => v.plane);
    const hit = this.ray.intersectObjects(planes, false)[0];
    if (!hit) return null;
    const id = hit.object.userData.itemId as string;
    return this.host.views.get(id) ?? null;
  }

  private pickWall(e: { clientX: number; clientY: number }): { wall: Wall; u: number; v: number } | null {
    this.setRayFromEvent(e);
    const hit = this.ray.intersectObjects(
      this.host.walls.map((w) => w.mesh),
      false,
    )[0];
    if (!hit) return null;
    const wall = this.host.walls[hit.object.userData.wallIndex as number];
    const { u, v } = pointToUV(wall, hit.point);
    return { wall, u, v };
  }

  private wallUnderPointer(e: { clientX: number; clientY: number }): { wall: Wall; u: number; v: number } | null {
    return this.pickWall(e);
  }

  /** the wall the camera currently faces, at comfortable height */
  private facingWall(): { wall: Wall; u: number; v: number } {
    const center = { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 };
    return this.pickWall(center) ?? { wall: this.host.walls[0], u: 0.5, v: 0.55 };
  }

  private itemOf(id: string): RoomItem | undefined {
    return this.host.data.items.find((i) => i.id === id);
  }

  // --- state machine ---------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const view = this.pickItem(e);
    if (!view) {
      if (this.state.mode !== 'idle') this.deselect();
      return;
    }
    const item = view.item;
    this.select(item.id);
    const hitWall = this.pickWall(e);
    const du = hitWall && hitWall.wall.index === item.wall ? hitWall.u - item.u : 0;
    const dv = hitWall && hitWall.wall.index === item.wall ? hitWall.v - item.v : 0;
    this.state = { mode: 'dragging', id: item.id, du, dv, moved: false, startX: e.clientX, startY: e.clientY };
    try {
      this.host.dom.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events (probes) have no active pointer */
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.state.mode !== 'dragging') return;
    const s = this.state;
    if (!s.moved) {
      if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < 4) return;
      s.moved = true;
      this.pushSnapshot();
    }
    const item = this.itemOf(s.id);
    const view = this.host.views.get(s.id);
    if (!item || !view) return;
    const hit = this.pickWall(e);
    if (!hit) return;
    if (hit.wall.index !== item.wall) {
      item.wall = hit.wall.index;
      s.du = 0; // jumping walls: re-grab at the cursor
      s.dv = 0;
    }
    item.u = hit.u - s.du;
    item.v = hit.v - s.dv;
    this.clampToWall(item, view);
    view.applyTransform(this.host.walls);
    scheduleSave(this.host.data);
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button !== 0 || this.state.mode !== 'dragging') return;
    const { id, moved } = this.state;
    this.state = { mode: 'selected', id };
    if (moved) return;
    // a plain click activates the content
    const item = this.itemOf(id);
    const view = this.host.views.get(id);
    if (!item || !view) return;
    if (item.kind === 'video' && view.video) {
      if (view.video.paused) void view.video.play().catch(() => {});
      else view.video.pause();
    } else if (item.kind === 'link') {
      openLightbox(item.src);
    }
  }

  private onWheel(e: WheelEvent): void {
    if (this.state.mode === 'idle') return;
    e.preventDefault();
    const item = this.itemOf(this.state.id);
    const view = this.host.views.get(this.state.id);
    if (!item || !view) return;
    if (this.wheelSnapshotArmed) {
      this.pushSnapshot();
      this.wheelSnapshotArmed = false;
      setTimeout(() => (this.wheelSnapshotArmed = true), 800);
    }
    item.w = Math.max(MIN_W, Math.min(MAX_W, item.w * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    this.clampToWall(item, view);
    view.applyTransform(this.host.walls);
    scheduleSave(this.host.data);
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if ((e.code === 'Delete' || e.code === 'Backspace') && this.state.mode !== 'idle') {
      this.pushSnapshot();
      const id = this.state.id;
      this.deselect();
      this.host.data.items = this.host.data.items.filter((i) => i.id !== id);
      this.host.removeView(id);
      scheduleSave(this.host.data);
      toast('Usunięto — Ctrl+Z cofa');
    } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void this.undo();
    } else if ((e.code === 'Equal' || e.code === 'Minus') && this.state.mode !== 'idle') {
      this.onWheel(
        new WheelEvent('wheel', { deltaY: e.code === 'Equal' ? -1 : 1 }),
      );
    }
  }

  // --- selection & panel ----------------------------------------------

  private select(id: string): void {
    if (this.state.mode !== 'idle' && this.state.id === id) return;
    this.deselect();
    const item = this.itemOf(id);
    const view = this.host.views.get(id);
    if (!item || !view) return;
    view.setSelected(true);
    this.captionSnapshotArmed = true;
    openPanel(item, {
      onCaption: (text) => {
        if (this.captionSnapshotArmed) {
          this.pushSnapshot();
          this.captionSnapshotArmed = false;
        }
        item.caption = text;
        view.setCaption(text);
        view.applyTransform(this.host.walls);
        scheduleSave(this.host.data);
      },
      onDelete: () => {
        this.pushSnapshot();
        this.deselect();
        this.host.data.items = this.host.data.items.filter((i) => i.id !== id);
        this.host.removeView(id);
        scheduleSave(this.host.data);
        toast('Usunięto — Ctrl+Z cofa');
      },
      onFocusChange: (typing) => (this.host.controller.enabled = !typing),
      onToggleVideo:
        item.kind === 'video'
          ? () => {
              const v = this.host.views.get(id)?.video;
              if (!v) return;
              if (v.paused) void v.play().catch(() => {});
              else v.pause();
            }
          : null,
      onUnmute:
        item.kind === 'video'
          ? (muted) => {
              const v = this.host.views.get(id)?.video;
              if (v) v.muted = muted;
            }
          : null,
    });
    this.state = { mode: 'selected', id };
  }

  private deselect(): void {
    if (this.state.mode === 'idle') return;
    this.host.views.get(this.state.id)?.setSelected(false);
    this.host.controller.enabled = true;
    closePanel();
    this.state = { mode: 'idle' };
  }

  /** keep the picture (and its caption) inside the wall */
  private clampToWall(item: RoomItem, view: ItemView): void {
    const wall = this.host.walls[item.wall];
    item.w = Math.min(item.w, wall.width - 2 * MARGIN);
    const halfU = item.w / 2 / wall.width;
    const h = item.w * item.aspect;
    const capH = view.captionHeight();
    const topV = (h / 2 + MARGIN) / wall.height;
    const botV = (h / 2 + capH + MARGIN) / wall.height;
    item.u = Math.max(halfU + MARGIN / wall.width, Math.min(1 - halfU - MARGIN / wall.width, item.u));
    item.v = Math.max(botV, Math.min(1 - topV, item.v));
  }

  // --- undo -------------------------------------------------------------

  private pushSnapshot(): void {
    this.undoStack.push(JSON.stringify(this.host.data.items));
    if (this.undoStack.length > 20) this.undoStack.shift();
  }

  private async undo(): Promise<void> {
    const snap = this.undoStack.pop();
    if (!snap) {
      toast('Nie ma czego cofnąć');
      return;
    }
    this.deselect();
    this.host.data.items = JSON.parse(snap) as RoomItem[];
    await this.host.rebuildAll();
    scheduleSave(this.host.data);
    toast('Cofnięto');
  }

  // --- import ------------------------------------------------------------

  private newItem(partial: Omit<RoomItem, 'id' | 'caption'>): RoomItem {
    return { id: crypto.randomUUID(), caption: '', ...partial };
  }

  private async place(item: RoomItem): Promise<void> {
    this.host.data.items.push(item);
    const view = await this.host.spawnView(item);
    this.clampToWall(item, view);
    view.applyTransform(this.host.walls);
    scheduleSave(this.host.data);
  }

  async addLink(url: string): Promise<void> {
    const at = this.facingWall();
    await this.place(
      this.newItem({ kind: 'link', src: url, wall: at.wall.index, u: at.u, v: at.v, w: 1.2, aspect: 9 / 16 }),
    );
    toast('Link powieszony na ścianie');
  }

  async importFiles(
    files: FileList,
    dropAt: { wall: Wall; u: number; v: number } | null,
  ): Promise<void> {
    const at = dropAt ?? this.facingWall();
    let offset = 0;
    for (const file of Array.from(files)) {
      try {
        const spot = {
          wall: at.wall.index as 0 | 1 | 2 | 3,
          u: Math.min(0.95, at.u + offset),
          v: at.v,
        };
        if (file.type.startsWith('image/')) {
          const { blob, name, aspect } = await downscaleImage(file);
          const src = await uploadAsset(name, blob);
          await this.place(this.newItem({ kind: 'image', src, ...spot, w: 1.0, aspect }));
        } else if (file.type.startsWith('video/')) {
          if (file.size > VIDEO_MAX) {
            toast(`${file.name}: za duże (${Math.round(file.size / 1e6)} MB > 50 MB) — użyj linku`);
            continue;
          }
          if (file.size > VIDEO_WARN)
            toast(`${file.name}: ${Math.round(file.size / 1e6)} MB — duży plik w repo`);
          const aspect = await probeVideoAspect(file);
          const src = await uploadAsset(file.name, file);
          await this.place(this.newItem({ kind: 'video', src, ...spot, w: 1.4, aspect }));
        } else {
          toast(`${file.name}: nieobsługiwany typ (${file.type || 'nieznany'})`);
          continue;
        }
        offset += 0.05;
      } catch (err) {
        toast(`Nie udało się dodać ${file.name} — czy serwer dev działa?`);
        console.error('[room] import failed', file.name, err);
      }
    }
  }
}

/** shrink to max 2048 px long edge; JPEG q0.85 unless the source is PNG
 *  (alpha survives), so the shared repo stays lean */
async function downscaleImage(
  file: File,
): Promise<{ blob: Blob; name: string; aspect: number }> {
  const bitmap = await createImageBitmap(file);
  const aspect = bitmap.height / bitmap.width;
  const long = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, MAX_IMAGE_EDGE / long);
  const keepPng = file.type === 'image/png';
  if (scale === 1 && (keepPng || file.type === 'image/jpeg')) {
    bitmap.close();
    return { blob: file, name: file.name, aspect };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = keepPng ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, 0.85),
  );
  const stem = file.name.replace(/\.[^.]*$/, '');
  return { blob, name: `${stem}.${keepPng ? 'png' : 'jpg'}`, aspect };
}

function probeVideoAspect(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const aspect = v.videoHeight && v.videoWidth ? v.videoHeight / v.videoWidth : 9 / 16;
      URL.revokeObjectURL(url);
      resolve(aspect);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(9 / 16);
    };
    v.src = url;
  });
}
