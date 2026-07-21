import type { RoomItem } from './store';
import { youTubeId, vimeoId } from './items';

/** Thin DOM layer: toast, lightbox, side panel. All elements live in
 *  room.html; this module only wires them. */

const toastEl = document.getElementById('toast')!;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.style.opacity = '0'), 2600);
}

// --- lightbox ---------------------------------------------------------

const lightbox = document.getElementById('lightbox')!;
const lightboxClose = document.getElementById('lightboxClose')!;
let lightboxFrame: HTMLIFrameElement | null = null;

export function openLightbox(url: string): void {
  const yt = youTubeId(url);
  const vm = vimeoId(url);
  const embed = yt
    ? `https://www.youtube-nocookie.com/embed/${yt}?autoplay=1`
    : vm
      ? `https://player.vimeo.com/video/${vm}?autoplay=1`
      : null;
  if (!embed) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  lightboxFrame = document.createElement('iframe');
  lightboxFrame.src = embed;
  lightboxFrame.allow = 'autoplay; fullscreen; encrypted-media';
  lightbox.appendChild(lightboxFrame);
  lightbox.style.display = 'flex';
}

export function closeLightbox(): void {
  lightbox.style.display = 'none';
  lightboxFrame?.remove();
  lightboxFrame = null;
}

lightboxClose.addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') closeLightbox();
});

// --- side panel -------------------------------------------------------

export interface PanelHooks {
  onCaption: (text: string) => void;
  onDelete: () => void;
  onFocusChange: (typing: boolean) => void;
  onToggleVideo: (() => void) | null;
  onUnmute: ((muted: boolean) => void) | null;
}

const panel = document.getElementById('panel')!;

export function closePanel(): void {
  panel.style.display = 'none';
  panel.innerHTML = '';
}

export function openPanel(item: RoomItem, hooks: PanelHooks): void {
  panel.innerHTML = '';
  panel.style.display = 'flex';

  const title = document.createElement('h2');
  title.textContent =
    item.kind === 'image' ? 'Obraz' : item.kind === 'video' ? 'Wideo (plik)' : 'Wideo (link)';
  panel.appendChild(title);

  const src = document.createElement('div');
  src.style.cssText = 'font:11px monospace;color:#6d7688;word-break:break-all;';
  src.textContent = item.src;
  panel.appendChild(src);

  const capLabel = document.createElement('label');
  capLabel.textContent = 'Podpis';
  panel.appendChild(capLabel);
  const cap = document.createElement('textarea');
  cap.value = item.caption;
  cap.addEventListener('input', () => hooks.onCaption(cap.value));
  cap.addEventListener('focus', () => hooks.onFocusChange(true));
  cap.addEventListener('blur', () => hooks.onFocusChange(false));
  panel.appendChild(cap);

  if (hooks.onToggleVideo) {
    const row = document.createElement('div');
    row.className = 'row';
    const play = document.createElement('button');
    play.textContent = '⏯ odtwarzaj / pauza';
    play.addEventListener('click', () => hooks.onToggleVideo?.());
    row.appendChild(play);
    panel.appendChild(row);
  }
  if (hooks.onUnmute) {
    const row = document.createElement('div');
    row.className = 'row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'unmute';
    const lab = document.createElement('label');
    lab.htmlFor = 'unmute';
    lab.textContent = 'dźwięk włączony';
    lab.style.marginBottom = '0';
    box.addEventListener('change', () => hooks.onUnmute?.(!box.checked));
    row.append(box, lab);
    panel.appendChild(row);
  }

  panel.appendChild(document.createElement('hr'));
  const del = document.createElement('button');
  del.className = 'danger';
  del.textContent = 'Usuń ze ściany';
  del.addEventListener('click', () => hooks.onDelete());
  panel.appendChild(del);

  const tip = document.createElement('div');
  tip.style.cssText = 'font:11px system-ui;color:#6d7688;';
  tip.textContent = 'Przeciągnij obraz, by go przesunąć (także na inną ścianę). Kółko myszy zmienia rozmiar. Delete usuwa, Ctrl+Z cofa.';
  panel.appendChild(tip);
}

// --- add bar ----------------------------------------------------------

export function showAddBar(onFile: (files: FileList) => void, onLink: (url: string) => void): void {
  const bar = document.getElementById('addbar')!;
  bar.style.display = 'flex';
  document.getElementById('addFile')!.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.multiple = true;
    input.onchange = () => input.files && onFile(input.files);
    input.click();
  });
  document.getElementById('addLink')!.addEventListener('click', () => {
    const url = prompt('Wklej link do wideo (YouTube / Vimeo):');
    if (url && url.trim()) onLink(url.trim());
  });
}
