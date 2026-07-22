# OCEAN — project brain for Claude instances

You are working on OCEAN, an audiovisual synthesizer and VR art
installation inspired by Lem's Solaris. Two humans collaborate here, each
with their own Claude: **Wolgan** (technical lead) and **Monika**
(co-creator, non-technical — if she's your user, handle ALL git/terminal
mechanics for her, explain in plain language, and Polish is welcome).

Read `README.md` for the architecture. This file holds the rules that are
NOT obvious from the code.

## The core invariant: deterministic twins

The substance is ONE stochastic process rendered twice: the GPU draws it
(TSL nodes in `src/field/ParticleField.ts`) and the audio worklet plays it
(`public/granular-processor.js`). They share no data at runtime — they
compute the SAME function from the same PCG hashes on a shared clock.

**Any change to the shared math must be made identically in BOTH files**:
same formulas, same hash salts (101/202/331 free position, 303 density
lottery, 222/111 burst shape, 404 size, 601-603 color, 808 slot period,
909 phase; per object slot m, per object-generation g: 431+m*17 capture
lottery, 517+m*29 u, 549+m*37 v, 761/862/963+m*31 and 1063+m*41
analytic-landing randoms), same
envelope math, same tau/octave scaling. `pcgHash` in
ParticleField.ts is the bit-exact JS replica of TSL's `hash()` — never
let them diverge. If you change one side and not the other, image and
sound silently stop being the same thing, which breaks the artwork's
central premise.

The mass audio path is transitioning per
`docs/superpowers/specs/2026-07-14-spectral-tile-audio-design.md`: the
DESTINATION is one GPU evaluation projected twice (image + spectrum).
Today (Stage 1) the pool/bed still replicates the math CPU-side, and it
must remain bit-exact — including the hero path and the bed's
slot-anchored phases — so the duplicated-math duty above STILL APPLIES
in full to `granular-processor.js`. Do not weaken that warning because
Stage 2 is planned; it isn't built.

The corpuscular-transport constants (`docs/superpowers/specs/2026-07-19-corpuscular-transport-design.md`)
join this duty: `SPEED_OF_SOUND` (343), `EAR_OFFSET` (0.09), `NEAR_CLAMP`
(0.25, amplitude-only — delays use true r), `REFL_COEF` (0.7), `RT60`
(0.4), `AIR_COEF` (2.2e-10 nepers·m⁻¹·Hz⁻² — corrected during
implementation from a plan value 4 orders of magnitude too strong; see
`SPEC.md` §7.2), wall geometry, `IMAGE_TOP_K`/`IMAGE_AMP_SKIP`, and the
FDN's delay lengths/mix. These live audio-only today, but per §3 of that
spec they transplant line-for-line into the Stage-2 GPU splat shader
when its readback gate opens — every term is per-particle, state-free,
closed-form math for exactly that reason. Keep them identical wherever
both sides eventually touch them, the same as the free/object hash
salts above.

## The foreign-clock principle

No clock that isn't part of the universe may touch the substance:
- Control-rate updates (60Hz params messages) must NEVER reset a running
  grain's phase or timeline — new values take effect at natural births.
- Each timeline (free, per-object) owns its own oscillator phase.
- The visual frame is an EXPOSURE (integrate/stratify over dt), never a
  sample, for anything coherent/synchronized.
- The app clock offset in the worklet slews (hard resync only >50ms).
- Corpuscular-transport quantities (a grain's per-ear distance, flight
  delay, range rate/Doppler multiplier, and wall-reflection validity)
  are FROZEN per (voice, generation, ear) at first consideration, the
  same way a grain's phase is — a control-rate change (listener motion,
  a `transport` toggle) affects only the NEXT generation, never bends
  one already in flight. This is a real, load-bearing constraint, not a
  formality: driving `transport` from something other than its intended
  one-time, page-load resolution (e.g. writing the flag directly at
  runtime instead of navigating with `?transport=off`) visibly produces
  a messy mid-flight transition for a cycle or two while old and new
  enumeration rules overlap — confirmed empirically while building the
  live flash-to-ring probe (`probes/audio_stage1.py`).
Violations of this principle have caused every audio artifact so far.

## Other hard-won constraints

- **WebGL2 fallback must keep working** (Quest may need it): three.js
  emulates compute via transform feedback — max ONE buffer write per
  thread per pass, NO scatter writes, NO per-frame GPU readbacks.
  EXCEPTION: the ≤8 KB fenced audio-tile/statistics readback (see the
  spectral-tile-audio spec §6; `?probe=readback` measures its cost). The
  prohibition stands for substance buffers — this carve-out is for that
  one bounded, fenced, async tile/stat readback only, and it is still
  gated (see PERF.md — desktop WebGL2 fallback is NO-GO; Quest/WebGPU
  measurements are open).
- **Audio worklet hot loop**: no Math.pow, no allocation, no per-sample
  trig. Envelopes are baked into LUTs on parameter changes.
- TSL `uniformArray` stores its data under `.array`, not `.value`.
- Perf target: standalone Quest 3; density is a scalable parameter.
- The ModulationBus (`src/state/ModulationBus.ts`) is the single source
  of truth — renderers read only `bus.out`. New features should be
  expressible as signals/routes on the bus.

## Verification (do this before claiming anything works)

- `npx tsc --noEmit` and `node --test "tests/*.test.mjs"` (the worklet is
  an ES module now, not a checkable script — the test harness's import of
  it is the syntax check; `node --check public/granular-legacy.js` still
  applies to the frozen legacy file).
- Drive the real app with Playwright (Python), ALWAYS: foreground with a
  timeout, `try/finally browser.close()`, launch args
  `--enable-gpu --use-angle=d3d11 --autoplay-policy=no-user-gesture-required`
  (without the GPU flags the page hard-stalls on software GL). NEVER
  leave headless browsers running in background tasks (this once froze
  the whole machine by leaking 212GB).
- The app exposes `window.__ocean` ({bus, objects, state, audio, field,
  renderer}) for probes. Prove audio claims with measurements
  (autocorrelation at expected lags, FFT band energy via AnalyserNode),
  not by assumption.

## Collaboration contract

- **Never commit directly to `main`.** `main` auto-deploys to
  https://xwolgan.github.io/ocean/ and must always work.
- Branch naming: `wolgan/<topic>` or `monika/<topic>`.
- Start every session: `git pull origin main` (and merge/rebase your
  branch on it). Keep branches short-lived; small PRs beat big ones.
- Open a Pull Request for every change; CI (build check) must pass.
  Merge conflicts: read BOTH sides' intent and blend semantically; if
  the intents genuinely clash, stop and let the humans decide in the PR.
- Commit messages tell the story of the instrument — keep doing that.
- `FOR_CO-CREATOR.md` is the plain-language player guide (EN/PL).

## Provenance duty (binding — the memory prosthesis for the humans)

Wolgan and Monika update each other by talking, and human memory is
imperfect. You (both instances) compensate, using git history +
`intents/`:

1. **Guardian reflex.** Before changing existing behavior, check who
   last shaped it (`git log -p`/`git blame` on the region, then the
   matching intent file in `intents/merged/`). If it was the OTHER
   human's work, tell yours BEFORE proceeding: "Monika pushed this to X
   because Y — proceed, adjust, or ask her first?" Then respect the
   answer.
2. **Explainer reflex.** When your human is surprised by behavior ("why
   does it do this?"), trace it: blame → commit → intent file, and
   answer with who, when, and WHY — not just what the code does.
3. **Session briefing.** At session start, after pulling `main`,
   summarize what arrived from the other studio since your human last
   worked: which branches merged, and what they were FOR (read their
   archived intent files; don't just list commits).
4. **Context, never territory.** Provenance exists to remember reasons,
   not to assign credit or permission. Never frame it as ownership
   ("her code"), never discourage a change because of authorship — only
   inform the change with the reason the current state exists.

## Documentation system (binding — see intents/README.md)

- **`SPEC.md`** is the objective description of the app's current state:
  every functionality, boundary, parameter. Trust it as ground truth on
  arrival; keep it true on merge.
- **`intents/<branch>.md`**: create it when you create a branch (goal,
  idea, what it should feel like); update it with EVERY commit. When
  reading someone else's branch, read their intent file BEFORE the diff.
- **On merge to `main`**: fold what became true into SPEC.md and move
  the intent file to `intents/merged/` (never delete — it's the
  project's history of ideas). CI fails PRs that change code without
  touching their intent file or SPEC.md.

## Design language (for consistency of future features)

Objects are constellations (target clouds + weighted patches + AR
envelopes; release=∞ is permanent memory/trace). Order is never a dial —
it emerges from synchronization. Every visual property gets an audible
twin via the settled mapping table in README. Every property has a mean
AND a dispersion ("randomnesses"). When adding a parameter, ask: what is
its twin in the other sense, and what is its dispersion?
