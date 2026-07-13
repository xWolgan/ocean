# wolgan/image-continuous-uv

author: wolgan (with Claude)
started: 2026-07-14

## Goal

Images must be PAINTED by constantly re-landing particles — Wolgan's
two-screenshot proof showed a frozen dot lattice that merely blinked.

## The idea

The image was a fixed point set (8192 targets sampled once), so
rebirths could only hop between the same points. Now an image is a
GRIDDED CANVAS: the cloud stores a 128x64 downsampled image in scanline
order, and each capture draws a continuous (u,v) on the rectangle —
the grid cell gives the color, the fraction gives the exact position.
No point set exists; every rebirth lands anywhere on the surface.
Geometry objects keep scattered constellations (dense enough there).
Transparent cells become black (invisible) matter.

## Measured

Sparse paint, frames 2s apart: Jaccard overlap of lit-pixel masks
0.596 at 75% coverage — the random-independence expectation is 0.60,
i.e. the two frames are statistically independent samples of the
canvas. The lattice is gone.

## Log

- generators: image -> 128x64 grid cloud (scanline order, cell +
  grid metadata); GPU uObjH + continuous-uv landing (salts 517+m*29 for
  u, 549+m*37 for v); worklet twin; descriptors carry grid/cell;
  CLAUDE.md salt registry + SPEC updated.
