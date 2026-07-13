# wolgan/image-uniform-spread

author: wolgan (with Claude)
started: 2026-07-13

## Goal

Image particles must spread uniformly over the whole image (no
brightness-driven contours), and how much color they take from the image
vs from the settings must be a weighted dial.

## The idea

Wolgan spotted contours in image constellations — the sampler was
culling pixels below a luminance threshold, so dark regions had NO
particles: the spread was secretly following the brightness channel.
Now every non-transparent pixel is an equally likely home; the image's
structure is carried by COLOR only (black pixels = dim particles, which
is physically honest — black emits nothing). New patch param
`imageColor` (0–1): 0 = particles wear the settings' tint (the image is
a pure spawn-shape), 1 = the image's own pixels, between = blend. This
REPLACES the short-lived multiplicative gel from wolgan/image-tint-gel —
the weighted mix is the simpler mental model and it's what was asked.

## Measured

Black/white test image, green settings tint: imageColor=0 → left/right
lit-pixel counts 23409 vs 23536 (uniform, both pure green);
imageColor=1 → white half bright, black half dim (structure by color).

## Log

- generators.ts: alpha-only candidate filter (uniform spread).
- ObjectDef/Manager/Panel: imageColor patch param + descriptor.
- GPU (uObjG) + worklet: weighted mix image↔tint, gel removed.
