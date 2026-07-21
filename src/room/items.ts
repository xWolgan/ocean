import * as THREE from 'three/webgpu';
import type { RoomItem } from './store';
import type { Wall } from './RoomScene';
import { wallPoint } from './RoomScene';

const CAPTION_GAP = 0.03; // meters between picture bottom and caption top

/** Extract a YouTube video id from the common URL shapes, or null. */
export function youTubeId(url: string): string | null {
  const m = url.match(
    /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/,
  );
  return m ? m[1] : null;
}

export function vimeoId(url: string): string | null {
  const m = url.match(/vimeo\.com\/(\d{6,})/);
  return m ? m[1] : null;
}

function canvasTexture(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function placeholderTexture(label: string): THREE.CanvasTexture {
  return canvasTexture(
    (ctx, w, h) => {
      ctx.fillStyle = '#565b66';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#7a8093';
      ctx.lineWidth = 4;
      ctx.strokeRect(8, 8, w - 16, h - 16);
      ctx.fillStyle = '#d5dbe6';
      ctx.font = '24px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('missing:', w / 2, h / 2 - 16);
      ctx.font = '18px monospace';
      ctx.fillText(label.slice(-40), w / 2, h / 2 + 14);
    },
    512,
    320,
  );
}

function linkCardTexture(url: string): THREE.CanvasTexture {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* keep raw */
  }
  return canvasTexture(
    (ctx, w, h) => {
      ctx.fillStyle = '#1d2230';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#e8ecf4';
      ctx.beginPath(); // play triangle
      ctx.moveTo(w / 2 - 28, h / 2 - 38);
      ctx.lineTo(w / 2 + 44, h / 2);
      ctx.lineTo(w / 2 - 28, h / 2 + 38);
      ctx.closePath();
      ctx.fill();
      ctx.font = '26px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(host, w / 2, h - 46);
      ctx.fillStyle = '#8a94a6';
      ctx.font = '15px monospace';
      ctx.fillText(url.slice(0, 60), w / 2, h - 18);
    },
    640,
    360,
  );
}

/** wrap text into lines that fit a canvas width */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const probe = line ? `${line} ${word}` : word;
      if (ctx.measureText(probe).width > maxW && line) {
        lines.push(line);
        line = word;
      } else line = probe;
    }
    lines.push(line);
  }
  return lines;
}

/** One pinned item: picture plane + selection frame + caption plane. */
export class ItemView {
  readonly group = new THREE.Group();
  readonly plane: THREE.Mesh;
  video: HTMLVideoElement | null = null;
  private frame: THREE.LineSegments;
  private captionMesh: THREE.Mesh | null = null;
  private disposed = false;

  readonly item: RoomItem;

  private constructor(item: RoomItem, material: THREE.MeshBasicMaterial) {
    this.item = item;
    this.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    this.plane.userData.itemId = item.id;
    this.group.add(this.plane);
    this.frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.plane.geometry),
      new THREE.LineBasicMaterial({ color: 0x86b3ff }),
    );
    this.frame.visible = false;
    this.frame.position.z = 0.002;
    this.group.add(this.frame);
    this.setCaption(item.caption);
  }

  /** aspect discovered at load differs from stored → caller re-saves */
  static async create(
    item: RoomItem,
    aniso: number,
    onAspect: (aspect: number) => void,
  ): Promise<ItemView> {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const view = new ItemView(item, mat);

    const applyTex = (tex: THREE.Texture) => {
      if (view.disposed) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = aniso;
      mat.map = tex;
      mat.needsUpdate = true;
    };

    if (item.kind === 'image') {
      new THREE.TextureLoader().load(
        item.src,
        (tex) => {
          applyTex(tex);
          const img = tex.image as { width: number; height: number };
          const aspect = img.height / img.width;
          if (Math.abs(aspect - item.aspect) > 1e-3) onAspect(aspect);
        },
        undefined,
        () => applyTex(placeholderTexture(item.src)),
      );
    } else if (item.kind === 'video') {
      const video = document.createElement('video');
      video.src = item.src;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.addEventListener('error', () => applyTex(placeholderTexture(item.src)));
      video.addEventListener(
        'loadedmetadata',
        () => {
          const aspect = video.videoHeight / video.videoWidth;
          if (Math.abs(aspect - item.aspect) > 1e-3) onAspect(aspect);
        },
        { once: true },
      );
      void video.play().catch(() => {});
      view.video = video;
      applyTex(new THREE.VideoTexture(video));
    } else if (item.kind === 'note') {
      // texture already painted by setCaption in the constructor
    } else {
      // link: try a YouTube thumbnail, else a generated card
      const yt = youTubeId(item.src);
      if (yt) {
        new THREE.TextureLoader().load(
          `https://img.youtube.com/vi/${yt}/hqdefault.jpg`,
          applyTex,
          undefined,
          () => applyTex(linkCardTexture(item.src)),
        );
      } else {
        applyTex(linkCardTexture(item.src));
      }
    }
    return view;
  }

  /** pose the whole group from item.{wall,u,v,w,aspect} */
  applyTransform(walls: Wall[]): void {
    const wall = walls[this.item.wall];
    const h = this.item.w * this.item.aspect;
    this.plane.scale.set(this.item.w, h, 1);
    this.frame.scale.copy(this.plane.scale);
    wallPoint(wall, this.item.u, this.item.v, this.group.position);
    this.group.quaternion.copy(wall.mesh.quaternion);
    if (this.captionMesh) {
      const ch = this.captionMesh.scale.y;
      this.captionMesh.position.y = -(h / 2 + CAPTION_GAP + ch / 2);
    }
  }

  setCaption(text: string): void {
    // a note IS its text: the caption paints the main plane (chalk on
    // the wall — transparent background), never a separate label below
    if (this.item.kind === 'note') {
      const trimmed = text.trim() || '…';
      const W = 640;
      const pad = 16;
      const probeCtx = document.createElement('canvas').getContext('2d')!;
      probeCtx.font = '34px system-ui, sans-serif';
      const lines = wrapLines(probeCtx, trimmed, W - pad * 2);
      const lineH = 44;
      const H = lines.length * lineH + pad * 2;
      const tex = canvasTexture(
        (ctx, w) => {
          ctx.clearRect(0, 0, w, H);
          ctx.fillStyle = '#eef2f8';
          ctx.shadowColor = '#00000088';
          ctx.shadowBlur = 6;
          ctx.font = '34px system-ui, sans-serif';
          lines.forEach((l, i) => ctx.fillText(l, pad, pad + (i + 0.8) * lineH));
        },
        W,
        H,
      );
      const mat = this.plane.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.map = tex;
      mat.transparent = true;
      mat.needsUpdate = true;
      this.item.aspect = H / W;
      return;
    }
    if (this.captionMesh) {
      (this.captionMesh.material as THREE.MeshBasicMaterial).map?.dispose();
      (this.captionMesh.material as THREE.MeshBasicMaterial).dispose();
      this.captionMesh.geometry.dispose();
      this.group.remove(this.captionMesh);
      this.captionMesh = null;
    }
    const trimmed = text.trim();
    if (!trimmed) return;

    const W = 512;
    const pad = 10;
    const probeCtx = document.createElement('canvas').getContext('2d')!;
    probeCtx.font = '26px system-ui, sans-serif';
    const lines = wrapLines(probeCtx, trimmed, W - pad * 2);
    const lineH = 34;
    const H = lines.length * lineH + pad * 2;
    const tex = canvasTexture(
      (ctx, w) => {
        ctx.fillStyle = '#14161c';
        ctx.fillRect(0, 0, w, H);
        ctx.fillStyle = '#dbe2ee';
        ctx.font = '26px system-ui, sans-serif';
        lines.forEach((l, i) => ctx.fillText(l, pad, pad + (i + 0.8) * lineH));
      },
      W,
      H,
    );
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.92 });
    this.captionMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    // caption width tracks the picture width; height keeps canvas aspect
    const cw = this.item.w;
    this.captionMesh.scale.set(cw, cw * (H / W), 1);
    this.group.add(this.captionMesh);
  }

  setSelected(on: boolean): void {
    this.frame.visible = on;
  }

  /** caption plane height in meters (0 when there is no caption) */
  captionHeight(): number {
    return this.captionMesh ? this.captionMesh.scale.y + CAPTION_GAP : 0;
  }

  dispose(): void {
    this.disposed = true;
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.video = null;
    }
    const mat = this.plane.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
    this.plane.geometry.dispose();
    this.frame.geometry.dispose();
    (this.frame.material as THREE.Material).dispose();
    this.setCaption('');
    this.group.removeFromParent();
  }
}
