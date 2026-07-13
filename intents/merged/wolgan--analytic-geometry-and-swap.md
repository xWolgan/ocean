# main (direct): analytic geometry, pitch/timbre swap, drag-size, previews

author: wolgan (with Claude)
started: 2026-07-14
note: committed directly to main by owner's instruction (pre-collaboration
basics phase; branch protection admin-exempt).

## Goals (Wolgan's)

1. Same no-grid logic everywhere: geometry as exact analytic property
   fields (points/primitives), curves as ~continuous interpolated tables.
2. SWAP the sound mapping: COLOR (hue) determines pitch; SIZE determines
   the selection of secondary tones. colorRandom = pitch spread,
   sizeRandom = timbre spread. Saturation/brightness unchanged.
3. Primitives drag-sized: press places, drag sizes, release commits.
4. Live authoring previews (wireframe/ghost/line) for all object types.

## Measured

Hue-to-pitch: red-orange tint peak 384 Hz, blue tint 1027 Hz — ratio
2.67x vs 2.6x predicted by the +-1.1-octave hue axis. Analytic sphere +
drawn curve condense and render at 59fps, no errors.

## Notes

Depth maps remain inert (return with a dedicated pass). Cylinder has no
authoring button yet (analytic sampler ready). New landing salt family
1063+m*41 added to the registry.
