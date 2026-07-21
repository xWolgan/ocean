/** Types + persistence for the reference room.
 *
 *  Sharing model: git, not a server. In dev, a Vite middleware
 *  (vite.config.ts, '/__room') writes uploads into refroom/assets/ and
 *  the layout into refroom/room.json in the WORKING TREE; committing is
 *  a separate, deliberate act. Without the middleware (e.g. a plain
 *  static host) the room opens read-only.
 */

export type Kind = 'image' | 'video' | 'link' | 'note';

export interface RoomItem {
  id: string;
  kind: Kind;
  /** 'refroom/assets/…' for files; the full URL for kind 'link';
   *  empty for kind 'note' (the text lives in `caption`) */
  src: string;
  wall: 0 | 1 | 2 | 3;
  /** item CENTER on the wall, 0..1 left→right facing it */
  u: number;
  /** item center up the wall, 0..1 */
  v: number;
  /** width in meters */
  w: number;
  /** height/width, captured at import so layout never reflows */
  aspect: number;
  caption: string;
}

export interface RoomData {
  version: 1;
  items: RoomItem[];
}

export async function loadRoom(): Promise<RoomData> {
  try {
    const res = await fetch('refroom/room.json', { cache: 'no-store' });
    if (!res.ok) return { version: 1, items: [] };
    const data = (await res.json()) as RoomData;
    if (!Array.isArray(data.items)) return { version: 1, items: [] };
    return data;
  } catch {
    return { version: 1, items: [] };
  }
}

/** true when the dev middleware answers — i.e. edits can be persisted */
export async function detectEditMode(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch('/__room/ping', { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** raw-byte upload; returns the repo-relative URL to store in room.json */
export async function uploadAsset(name: string, blob: Blob): Promise<string> {
  const res = await fetch(`/__room/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: blob,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  const out = (await res.json()) as { url: string };
  return out.url;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty: RoomData | null = null;
let onSaveError: ((e: unknown) => void) | null = null;

export function setSaveErrorHandler(fn: (e: unknown) => void): void {
  onSaveError = fn;
}

async function postSave(data: RoomData, keepalive: boolean): Promise<void> {
  const res = await fetch('/__room/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
    keepalive,
  });
  if (!res.ok) throw new Error(`save failed (${res.status})`);
}

/** debounced autosave — never lose work, never spam the disk */
export function scheduleSave(data: RoomData): void {
  dirty = data;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const d = dirty;
    dirty = null;
    if (!d) return;
    postSave(d, false).catch((e) => {
      dirty = d; // keep it pending; the next change retries
      onSaveError?.(e);
    });
  }, 1000);
}

/** flush on page close (fetch keepalive survives unload) */
export function flushSave(): void {
  if (!dirty) return;
  const d = dirty;
  dirty = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  void postSave(d, true).catch(() => {});
}
