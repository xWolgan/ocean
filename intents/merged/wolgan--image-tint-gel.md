# wolgan/image-tint-gel

author: wolgan (with Claude)
started: 2026-07-13

## Goal

Image (and any color-carrying) objects must react to their tint —
currently target colors fully override it, in both light and sound.

## The idea

The tint becomes a GEL: a colored light over the constellation,
multiplicative with the targets' own colors, scaled by tintWeight.
White gel = neutral; red gel = the image seen through red glass; the
audio twin filters the per-voice color identically, so the image's
chord shifts timbre with the same gesture that shifts its light.
Objects without their own target colors (point/curve/primitives) keep
the existing behavior exactly (measured green-dominant before the fix).

## Log

- GPU: capturedTint = mix(tint, targetColor × mix(white, tint, tintW·level), hasColor).
- Worklet: same gel on per-voice target colors before scatter/blend.
- Probe re-run: image avg lit RGB went (209,211,212) → green-dominant;
  point/sphere unchanged.
