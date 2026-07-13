# wolgan/image-property-field

author: wolgan (with Claude)
started: 2026-07-14

## Goal

One pixel — one set of particle properties. No grids, no scaffolding.

## The idea (Wolgan's, verbatim in spirit)

The image is a property FIELD: particles land at continuous random
points of the rectangle and the source pixel under each landing dresses
them. Attraction only relocates matter into the field's reach; the
geometry itself always dresses — even at attraction 0, matter that
happens to pass through the paper-thin slab takes the image's
properties. Thickness defaults paper-thin (2mm), tunable, with a
zero-thickness tick for the exact mathematical plane.

Agreed direction (next branch): the same logic for ALL objects — points
and primitives become fully analytic (no resolution at all), drawn
curves keep a ~1mm interpolated arc-length table (below particle size =
effectively continuous). No visible landing quantization anywhere.

## Measured

Red/blue source image, sparse paint: left lit-average (141,99,96)
red-dominant, right (89,102,146) blue-dominant — source pixels flow.
Attraction 0, thick slab in a grey field: 291 dressed-red particles
inside the slab region — dressing decoupled from attraction works.

## Log

- images: full-res 1024 texture per slot (fixed allocation — resizing a
  live texture silently fails on WebGL2, found the hard way) + 256
  audio copy; analytic rectangle landing; grid machinery removed.
- thickness + zeroThickness on the generator (live, serialized, panel).
- chance-dressing pass in GPU + worklet free path (twins hold).
- Deferred: depth-map displacement; analytic geometry unification.
