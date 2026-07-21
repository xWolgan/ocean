# monika/reference-room

author: monika (with Claude)
started: 2026-07-21

## Goal

A shared 3D moodboard room — a separate dev-only page where Monika (and
Wolgan) pin reference images and videos on the walls, drag them around,
and caption them.

## The idea

References need a spatial home next to the artwork, not inside it: a
plain walkable room (8×3×8 m, WASD + right-drag, same feel as the
compositor), four walls that act as pinboards. Items are images, video
files, and video links (YouTube/Vimeo → thumbnail card + lightbox).
Everything shares through git: a dev-only Vite middleware writes uploads
to `refroom/assets/` and the layout to `refroom/room.json` in the
working tree; committing the room is a normal conversational act.

Deliberate boundary (Monika's call): the room lives in the repo but NOT
on the public site — `room.html` is not a build entry, `refroom/` is
outside `public/`, so `dist/` (and GitHub Pages) never contain it.

## What it should feel like

Like pinning printouts to a studio wall: drop a file anywhere, it lands
on the wall in front of you; grab it, slide it, scroll to size it, type
a line under it. No ceremony, nothing to break in the artwork.

## Log

- (start) plan agreed: room.html + src/room/* (plain WebGLRenderer, no
  TSL), dev middleware in vite.config.ts (ping/upload/save, raw-byte
  uploads, filename scrub), items = image | video (muted loop) | link
  (card + lightbox), snapshot undo, autosave 1 s debounce, images
  downscaled to 2048 px client-side, video files capped at 50 MB.
- built in one pass: RoomScene (Wall descriptors with wallPoint/pointToUV
  as the shared wall-local coordinate system), Controller (fixed eye
  height 1.6 m, no Q/E — everything lives on walls), store, items
  (aspect stored in room.json so layout never reflows on the other
  studio's first load), editor (idle/selected/dragging; click-without-
  drag activates: video pause, link lightbox), ui. FOR_CO-CREATOR.md
  section 5 added (EN/PL).
- verified: tsc + build clean; dist/ contains NEITHER room.html NOR
  refroom/ (the privacy decision holds). Event-level probe in embedded
  Chromium (no Python/Playwright on this machine; the pane doesn't
  composite WebGL, so matrices were updated manually and a virtual
  1280x800 viewport injected): drop of a generated PNG → upload scrubbed
  the filename, item landed with exact aspect 0.625, autosave wrote
  room.json; drag moved u by +0.155; wheel resize 1.0→1.26 m; caption
  wrapped to two lines (0.247 m); edge drag jumped wall 0→1; Delete
  removed; Ctrl+Z restored item WITH caption; YouTube link card added.
  Test data cleaned; seed room.json empty. Visual pass on a real GPU
  browser still owed — Monika checks it in Chrome.
