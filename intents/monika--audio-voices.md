# monika/audio-voices

author: monika (with Claude)
started: 2026-07-14

## Goal

Make the audio voice count a performance parameter (32–256), like the
particle count already is for the GPU.

## The idea

On Monika's laptop the worklet cannot compute 256 voices inside the
real-time budget: measured drift of the audio clock vs the wall clock
was 0.8 s per 4 s at default density and 1.7 s per 4 s at density 1.0 —
the stream starves and the result is silence. The voices are already "a
strided sample of real particles", so sampling more coarsely (fewer
voices, larger stride) keeps the ocean's character while cutting CPU
proportionally. Default stays 256 = today's behavior, bit for bit.

## What it should feel like

On a strong machine: nothing changes. On a weak one: you pick 64 voices
and the ocean simply plays — a slightly sparser starfield of grains,
never a choked stream.

## Log

- Panel: `audio voices` dropdown (32/64/128/256) in the performance
  folder; main.ts derives the stride from it per frame and ships both to
  the worklet; worklet builds min(voices, 256) Voice slots (pool cap
  MAX_VOICES=256 unchanged). Changing the count rebuilds voices — same
  reset path the existing stride/particle-count change already takes;
  no running-grain phase is touched by control updates (foreign-clock
  principle intact). No shared-math change — deterministic twins
  untouched.
- Verified on the affected laptop (drift of audio clock vs wall clock;
  worst-case environment — same machine also software-rendering the
  field): density 1.0 → 256 voices 2.9 s behind per 4 s, 64 voices
  0.57 s, 32 voices 0. Density 0.55 (default) at 64 voices, clean
  fresh-context run: 2 ms per 5 s = no starvation. Caveat learned: a
  starved context "catches up" its backlog after load drops, so drift
  must be measured from a fresh context, not right after overload.
