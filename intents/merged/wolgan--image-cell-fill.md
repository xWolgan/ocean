# wolgan/image-cell-fill

author: wolgan (with Claude)
started: 2026-07-13

## Goal

Objects must ABSORB the matter around them, and images must be painted
by particles — Wolgan's intent, stated after seeing sparse dot-lattice
images that ignored the particle count.

## The idea (evolved mid-branch)

Started as: more targets (2048→8192) + pixel-cell jitter so stacked
particles fill the image plane. Then Wolgan corrected the deeper model:
particles that would have spawned in the area around an object should
instead spawn at a RANDOM point ON the object (fresh each rebirth),
carrying its local properties — and the surrounding area should visibly
empty into the object. So capture was rebuilt as TRUE ABSORPTION:
- no more fixed 1/8 pool partition — any object can claim any particle
  whose free spawn falls in its reach (at full claim, total absorption);
- no more permanent per-particle seats — each cycle lands on a fresh
  random constellation point (the image twinkles alive, and N particles
  = N points of paint);
- overlapping reaches: lowest slot index wins (rule open to refinement);
- the audio worklet now receives whole constellations and samples
  per-generation targets itself (same hashes — the twins hold).

## Measured

Sphere at claim 1: surrounding band depletes 39% on activation (old
model could never exceed 12.5%). Image: full pixel coverage in the
probe region (was 2048 discrete dots). 59fps at 314k particles with the
8-object capture test.

## Log

- 8192 targets; image pixel-cell fill; GPU capture loop (accumulated
  mixes, per-gen salts 517+m*29 / 761+m*31 family); worklet
  evaluateCapture + clouds messages; CLAUDE.md salt registry + SPEC
  capture section updated.
