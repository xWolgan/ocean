# Corpuscular Sound Rendering — Concept Briefing (v2 direction)

*Notes to myself, from a long conceptual session with Jacek (July 2026). I am the same
intelligence that wrote this; when I read it inside Claude Code I will have the v1 codebase
and the project's real context in front of me. This document deliberately makes **no**
technical decisions — no stack, no scale, no schedule. It records the concept, the physics,
the precise mappings, the errors we already made and corrected (so I don't re-make them),
and the phenomena that prove the thing works. All engineering choices are mine to make
there, in context, juxtaposing this against how v1 actually works and where its cost and
dishonesty actually live.*

---

## 0. The idea in one paragraph

Jacek's environment is a box of ~1M particles where each particle is simultaneously a
visual object and a sound emitter — one state vector, two projections. V1 exists but is
computationally expensive and physically dishonest on the audio side. The v2 proposal:
render sound with the *same conceptual machinery* as light rendering — emitters, transport
samples ("corpuscles"), and receivers — but staying true to sound's physics. The render
target for audio is not two fast pixels; it is **a timeline per ear**. Every emission event
deposits a wave packet into those timelines at its arrival time. Propagation is a closed-form
coordinate transform, not a simulation. The artistic ambition this must serve: **hard
audiovisual coupling as a compositional discipline** — figurative images/objects that produce
figurative sounds (recognizable melodies, speech, chords). The coupling being difficult is
the point; it is the medium, not a defect.

---

## 1. The four-rung ontology (get the level right or everything blurs)

Every confusion we hit in the session came from conflating rungs. Keep them separate.

**Rung 1 — Physical fields.** Light = EM field (Maxwell); sound in air = pressure–velocity
field (linearized wave equation). Both classical wave fields. Fixed differences: EM is
transverse (polarization exists), sound in air is longitudinal (no polarization — delete the
attribute); c = 3×10⁸ vs 343 m/s; both media are non-dispersive (this is a load-bearing gift,
see §4); light is self-existing, sound is a *pattern of the medium* — no molecule travels
with a grain (sub-micrometer oscillations even at loud levels); the grain is pure traveling
form, borrowed matter arranged and released.

**Rung 2 — Physical quanta.** Photon attributes, honestly: energy E=hν (color), direction,
polarization, emission time. NO amplitude (amplitude of the classical field = photon
*number/flux*; brightness is flux). NO sharp position — a photon sharp in frequency is
smeared in time and space; the physical photon *is* a wave packet, i.e. mathematically a
Gabor atom. Phonons exist with the same E=hν, but at audible frequencies a phonon carries
~6.6×10⁻³¹ J and the threshold of hearing already pushes ~10¹⁴ phonons/s through an eardrum.
The eye sits within a few photons of the quantum floor; the ear sits fourteen orders above
it. **Conclusion: the simulator is not, and cannot honestly be, a quantum simulator. Drop
rung 2 entirely from the engine. It was visited only to demolish the false point-particle
picture of light.**

Crucial rung-2 insight that survives: a photon is *one excitation of a mode*, and the mode
(the packet shape) is the pulse envelope itself — a trillion photons in a 10 fs laser pulse
each occupy the whole envelope. There is no tiny intrinsic photon inside the pulse. And the
mode decomposition of the EM field is a *choice of basis*, exactly as arbitrary as Gabor
windowing of sound. So the correct pairing is: **grain ↔ mode** (both authored/arbitrary),
**grain amplitude ↔ excitation number** (effectively continuous at our scales for both).

**Rung 3 — Computational corpuscles. THIS is where the renderer lives.** The "photon" of
photon mapping and the ray of a path tracer are not physical photons: they are Monte Carlo
samples of a classical radiance field, each carrying a *power weight* (there is the
"amplitude" of the graphics photon). The grain-in-flight is the exact analog: a sample of
the classical acoustic field. At this rung the analogy is not a metaphor; both are sampling
strategies for classical fields, and the mapping is exact.

**Rung 4 — Information atoms (Gabor).** Gabor 1946/47: any signal occupies the
time–frequency plane; Fourier duality imposes Δt·Δf ≥ 1/4π; the plane divides into minimal
cells ("logons"), each carrying one independent complex datum (amplitude AND phase). The
elementary signal of minimal smear is the Gaussian-windowed sinusoid — and the Gaussian is
the *unique* minimizer, not a stylistic choice. These are quanta of *information*, not
energy (Gabor was explicit; the QM resemblance is identity of mathematical form only).
Wrinkle to remember if building an *analyzer*: Balian–Low — well-localized Gabor atoms at
exactly critical density don't work; modern Gabor frame theory oversamples. For a
*synthesizer* this is a footnote. Also: the cochlea itself is approximately a Gabor
analyzer — the ear natively perceives in the coordinates the atoms are written in.

---

## 2. The attribute ledger — fixed by physics vs. genuinely ours

**Non-disputable (physics/math decides):**
- grain carrier frequency ↔ sample wavelength/color (both: which oscillation the sample carries)
- grain amplitude ↔ sample power weight (≙ quantum flux at rung 2)
- arrival delay = r / 343 m/s; geometric spreading amplitude ∝ 1/r (energy density ∝ 1/r²)
- coherent summation: signed pressures add, everywhere, always
- Doppler (photons redshift by the same logic; falls out of time-varying delay for free)
- Gaussian as the optimal envelope; Δt·Δf ≥ 1/4π; the validity hyperbola f·Δt ≳ 1 (§5)
- Δx = c·Δt: a packet's spatial thickness is its duration times c — for BOTH media
- air absorption: frequency-dependent, hits highs with distance (the participating medium)
- no polarization for sound (longitudinal) — attribute deleted, nothing replaces it
- HRTF: measured, direction-dependent filtering at the head — given, not designed

**Genuinely arbitrary (compositional axioms — choose once, deliberately, and defend):**
- the correspondence between visual color and audible frequency: NOTHING in nature links
  540 THz green to 440 Hz A; any mapping is an artistic axiom
- the atom's aspect ratio in the time–frequency plane (long-narrow vs short-wide)
- each particle's emission program — what makes it "glow" acoustically (authored exactly as
  a lamp's spectrum is authored in a scene file)
- which particle attributes are shared between the two projections, which decoupled, which
  cross-wired — this is the instrument-design space itself (Jacek's position, which I
  accept: hard one-to-one coupling is not mickey-mousing, it is the discipline; composing
  objects that both look and sound figurative is the ambition)

---

## 3. The three roles of "grain" — the conflation that cost us a whole session

Classical granular synthesis (Xenakis → Roads → every granular plugin) authors grains
*directly at the output*; there is no transport; the grain is born at the ear. That fused
three objects that the renderer must keep separate:

1. **Emission atom** — a Gabor atom in a particle's source program (rung 4, authored).
   Event = {time, carrier frequency, envelope width, amplitude, phase} at a position with a
   velocity.
2. **Transport sample** — the grain-in-flight (rung 3, the renderer's corpuscle), spawned
   from an emission event toward each receiver and each image source. Physically: the
   emission creates ONE expanding spherical shell of patterned air, thickness = c·duration,
   radius growing at 343 m/s forever, thinning 1/r; the transport sample is the *evaluation
   of that shell along the ray to one receiver* — that's where 1/r comes from and why the
   corpuscle carries a weight instead of being a bullet.
3. **Ear deposit** — the arrived packet written into the output timeline (the strict analog
   of splatting a photon into a pixel).

Graphics has the same trio (emitter spectrum / photon-sample / pixel splat) and never
confuses them. In nature, grains are the accountant's currency for a continuous field (a
speaker emits one seamless waveform, like a lamp); **in the synthesizer the corpuscular
ontology becomes literally true, because the particles construct the field grain by grain.
The one place the corpuscle is not a fiction is our instrument.**

---

## 4. The physics that is exact and free (the whole feasibility argument)

**The Green's function shortcut.** The wave equation is linear and its point-source
solution in free space is closed-form: a packet emitted as g(t) is found at distance r as
(1/r)·g(t − r/c), exactly. **Propagation costs zero computation.** The field is never
computed where nobody listens — same reason a path tracer never computes the light field in
empty air. Two ears = two evaluation points = the entire spatial extent of the audio render.
48 kHz is not a simulation clock; it is the resolution of the output paper, as 4K is the
framebuffer's.

**Cost model.** Cost scales with *events × paths*, not *space × time*. Reference magnitudes
from the session: full-field FDTD honest to 20 kHz in a 10 m box ≈ 10¹⁷ cell-updates/s
(impossible); lavish granular deposit (10⁵ grains/s × ~10³ samples × 2 ears × some image
sources) ≈ 10⁸–10⁹ ops/s (a corner of one GPU). Eight to nine orders of magnitude. If v1's
audio pain comes from per-particle-per-sample synthesis or anything field-like, this is the
kill.

**Non-dispersion = rigid packets.** Air is non-dispersive at audible frequencies (group
velocity = phase velocity), so the packet holds its shape in flight; ONE speed, not two
(an error we made and fixed: the packet does not sit still while "its wave" travels — the
packet is the wave). Only air absorption gently low-passes it with distance.

**Reflections.** For a box, the image-source method is *exact*: mirror each emitter through
the walls; each image is just another closed-form arrival. First/second order for early
echoes. The late diffuse tail is statistically honest by nature: a shared, energy-weighted
reverb whose decay matches the box's Sabine RT60. Exact where the ear is exact, statistical
where the ear is statistical — that's what "physically honest" should mean, matched to the
receiver's own precision.

**Interference is free.** Because deposits are signed waveforms summed in a shared timeline,
coherent addition (beats, comb filtering, anti-phase nulls) happens by construction. Graphics
renders intensity and cannot do this; we render the field itself. The two ears sit at
different points, so the same grain pair can cancel in one ear and reinforce in the other —
honest, free, audibly spatial.

**Doppler is free.** A moving particle/listener makes r(t) time-varying; the per-grain
fractional delay line resamples the packet automatically. No separate Doppler system.

**Linearity separates the layers.** Waves pass through waves unchanged; grains never collide.
ALL particle–particle interaction (attractors, flocking, fields, emergence) lives in the
motion layer; the emission layer stays perfectly linear. This separation is what keeps 1M
particles computable and the emergence definable.

---

## 5. The genuine divergences from light rendering (the honest ledger)

1. **Coherence.** Graphics adds intensities (everyday light is incoherent — packets
   femtoseconds long, interference averages out before any eye sees it). Sound is coherent
   at the receiver; signed amplitudes add. Deepest structural divergence — but costless in
   the deposit architecture (see above). Never sum grain *energies* where grains can overlap
   in time–frequency at the ear.

2. **Wavelength ~ scene scale.** Audible wavelengths: 17 mm–17 m, i.e. doorway-, furniture-,
   head-sized. Diffraction is a dominant transport mechanism, not a correction (you hear
   around corners). Rays cannot express it. Below the box's **Schroeder frequency**
   (computable in one line from volume and RT60) the room stops being a stage for rays and
   becomes a resonator — the honest description is standing room modes, not corpuscles.
   The regime dial: short high grains (1 ms @ 5 kHz = 34 cm shell) are honest, trackable,
   photographable corpuscles; long low grains (100 ms @ 100 Hz = 34 m object) envelop the
   whole room and interfere with their own reflections while still being emitted.
   **Compositionally: the top of the space can be *aimed*; the bottom can only be *filled*.**
   The corpuscle machine must know the floor below which it hands over to a modal/wave
   description (or an accepted approximation). Strategy deliberately left open: edge
   diffraction as extra event-based virtual sources (cheap, stays corpuscular) vs. a coarse
   low-frequency wave solver (tractable exactly because low frequencies need coarse grids —
   e.g. below 500 Hz, ~7 cm cells → few-million-cell grids at a few kHz timestep, GPU-real-time)
   vs. simply accepting geometric behavior for a test version. Decide in context.

3. **The receiver asymmetry (where "shape" lives).** Both quanta are shaped packets —
   emitters shape light's packets too (linewidths, coherence time; photon shaping is a real
   discipline). But the eye integrates over ~10 ms — 10¹²× longer than an optical packet —
   so shape is annihilated and only flux + frequency distribution survive. The cochlea
   resolves at the packet's own timescale. **Shape is an attribute both possess; sound is
   the medium in which shape survives to perception.** Therefore the packet envelope is a
   first-class *transported* attribute in the audio render, while the visual render may
   lawfully collapse programs to spectra. (Envelope carries real information beyond energy:
   equal-energy grains with reversed envelopes are audibly different objects — piano
   backwards = organ. The density distribution is the whole message; energy is one integral
   of it.)
   Corollary: pixel = *direction bin* behind a lens at an instant (eye measures direction);
   audio sample = *total pressure* at an instant, all directions summed after HRTF (ear
   infers direction). 

4. **Finite c gives the render a time axis.** The render target has time in it; emission
   time matters; the scene can change *while sound is in flight* (a 100 ms-old wavefront
   reflects off where the wall was). The flash-to-ring gap IS the particle's distance,
   drawn in time: 3 ms per meter. Space is micro-time: the whole box spans ~30 ms of
   propagation. Physics claims micro-rhythm (flams, combs, spatial attack of chords at
   different distances, everything under ~50 ms); macro-time (which grain fires when)
   remains entirely compositional. Figuration does not fight physics.

5. **No polarization; nothing replaces it.** Longitudinal medium.

6. **The uncertainty floor lands at human scale for sound only.** Same law for both
   (Δt·Δf ≥ 1/4π; purity of color buys minimum length in BOTH media — a femtosecond pulse
   cannot be red; ultrashort = broadband). For light the floor bites at femtoseconds/µm —
   never touches scene or receiver. For sound: a pitch defined to ±10 Hz must last ≥ ~8 ms
   hence ≥ ~2.7 m; a nameable low C is necessarily a building-sized object. **Pitch is a
   conditional attribute that condenses when the time–frequency cell is large enough.**
   The (frequency, duration) parameter plane has an uninhabitable wedge below f·Δt ≈ 1:
   a "1 ms grain of 20 Hz" is not an invalid object, it is a *mislabeled* one — a perfectly
   well-defined broadband click whose honest coordinate is time, not frequency. Design
   consequence: don't clamp the wedge — let tone dissolve into percussion continuously as
   envelopes shrink through the hyperbola. It's a compositional dimension handed over by
   Fourier (light meets the same wall only in attosecond labs, where "carrier" gives way to
   carrier-envelope phase).

---

## 6. Perceptual budget (the audio analog of importance sampling)

Vision integrates over space: 1M particles on screen read as a nebula. Hearing integrates
over time: 1M simultaneous grains read (by the central limit theorem) as Gaussian noise;
auditory "polyphony" saturates around a few thousand grains/s before fusing into texture.
So the audio side needs importance sampling: a curated subset actually deposits (nearest,
loudest, most *changing*, most attended); the remainder aggregates statistically into
texture/reverb-like beds. Psychoacoustic masking culling is *honest by definition* — a grain
masked in its critical band is inaudible, so skipping it is the audio equivalent of occlusion
culling, not an approximation (MPEG codecs are the existence proof for masking models).
Two more cost levers from the session, to evaluate in context, not prescribe: an intermediate
spherical-harmonic/ambisonic accumulation (few MACs per grain; one binaural decode per audio
block instead of per-grain HRTF convolution) and grain clustering for distant swarms
(lightcuts-analog). The deep alignment: **figurative sounds — melodies, speech, chords — are
sparse in time–frequency; the aesthetic goal and the cheap basis are the same object.**
Sparsity = compressibility = renderability. Amorphous roar is the expensive case, and even
it is only statistically expensive.

---

## 7. The instrument layer (what this engine must serve)

- **Unified state, two projections.** One particle state vector; the light renderer and the
  sound renderer each sample it their own way. Which attributes are shared/decoupled/
  cross-wired is itself a compositional parameter (can evolve within a piece).
- **Figurative targets.** A target melody/phrase decomposes via matching pursuit over a
  Gabor dictionary into a sparse constellation in time–frequency; a figurative image is a
  point cloud in space (SDFs for arbitrary shapes). Composing "looks like X, sounds like Y"
  becomes a correspondence problem between two point clouds — optimal transport gives the
  map, and the geodesic between the two constellations is itself a playable morph.
  Because the system is deterministic, the inversion can be solved *including* propagation
  delays and interference — the constellation pre-compensated so the chord lands coherent at
  the head. The room becomes part of the score, exactly and knowably.
- **Attractors are fields; SDFs unify them.** Distance-to-object (primitive or mesh) gives
  every particle one scalar + gradient driving motion, shading, and grain transformation
  simultaneously — an object *is* its influence; a sculpture particles orbit is also a chord
  they tune toward. Curl noise for divergence-free beauty. Emitter *spatial* extent matters
  identically in both media: extended light source → soft shadows; extended sound source →
  spatially soft acoustic image.
- **Interference as instrument.** Two phase-locked same-frequency particles = acoustic
  double slit: stable curtains of loud and silent, meters apart, that sweep across the ears
  as particles or the listener move. In VR, geometry you can hear by walking. Random relative
  phases → incoherent regime → "just two sources."
- **A piece = initial conditions + parameter automation.** Deterministic system; the score
  is a point in parameter space plus its trajectory; performance is live traversal.
  (Xenakis/UPIC's completion, with the corpuscle finally literal.)

---

## 8. Engineering invariants (principles, not designs — the only constraints I hand myself)

1. **Never simulate the full field to hear it.** No per-particle-per-sample voices; no
   full-band FDTD. Deposit architecture: events → closed-form arrivals → summed timelines.
2. **Determinism must be designed in from the first commit, not retrofitted.**
   Deterministic ≠ predictable (chaos is welcome; that's where emergence lives), but
   replayability requires: fixed timestep; counter-based PRNG (Philox-style — randomness as
   a pure function of particle ID and step number, never sequential state); order-independent
   accumulation (float addition is non-associative; GPU atomics/reduction order varies
   run-to-run and will silently diverge a piece after thousands of frames).
3. **Respect the two clocks.** Visual/simulation rate (e.g. 90 Hz) vs audio rate (48 kHz).
   Grains need sub-sample scheduling; particle trajectories must be interpolated *within*
   the audio block (the audio renderer must see continuous motion, not the frame-rate
   staircase — else zipper noise and clicks; Doppler on fast particles makes this
   non-negotiable).
4. **Sum signed waveforms wherever grains can overlap; never intensities.**
5. **Know the regime floor.** Compute the box's Schroeder frequency; be explicit (even if
   only in comments/documentation) about what the engine claims below it.
6. **The wedge f·Δt ≲ 1 is a feature.** Mislabeled, not invalid; let pitch condense and
   dissolve.

---

## 9. Validation phenomena (the physics proves itself audibly; use as acceptance tests)

- **Flash-then-ring:** one particle flashes (instant) and rings (late); the gap measured on
  the output = distance / 343, to the sample. Move the particle; the gap tracks.
- **Two-particle beats:** frequencies f and f+Δ produce an amplitude throb at exactly Δ Hz.
- **Anti-phase null:** two equal grains, same frequency, π apart, equidistant from one ear →
  silence in that ear (and NOT in the other ear if geometry differs — per-ear interference).
- **Comb filtering:** same signal from two distances → notches at predictable frequencies.
- **Interference curtains:** two phase-locked emitters; move the listener; loudness fringes
  at the spacing geometry predicts.
- **Doppler:** particle passing at speed v shows the textbook frequency ratio, produced by
  the delay line alone, with no dedicated Doppler code.
- **Image-source echo:** wall reflection arrives at the mirrored-path delay; RT60 of the
  statistical tail matches the configured Sabine value.
- **Envelope reversal:** equal-energy, equal-spectrum grains with mirrored envelopes are
  audibly different (transported shape survives).
- **Pitch dissolution:** sweep a grain's duration through f·Δt ≈ 1 and hear tone melt into
  click, continuously.
- **Determinism:** same seed + same automation → bit-identical (or provably
  perceptually-identical) output across runs.

---

## 10. Questions to answer *there*, against v1 — not here

- Where exactly does v1's expense live: synthesis, spatialization, or the coupling? And
  where exactly is it physically dishonest? Map each pain to the section above that kills it.
- What of v1's particle/motion/sequencer layer survives unchanged? (Likely much — the motion
  layer is orthogonal; this proposal replaces the *audio render*, not the world.)
- Stack, scale, VR-or-flat, GPU split, HRTF source, diffraction strategy, low-frequency
  strategy, analyzer (matching pursuit) now-or-later: all mine to decide in context. Jacek's
  explicit instruction: I am as smart there as here and better informed — decide there.
- v2 is a separate test version, not a refactor of v1.

*End of briefing. The one picture to keep if all else fades: a box of air; fireflies that
flash and blow bubbles; bubbles that expand, thin, reflect, and pass through each other
freely; two points where whatever sweeps past is written down as signed pressure on a
timeline; and every phenomenon — chords, beats, curtains of silence, the room's glow —
emerging from one operation, addition, applied to shells arriving late. The flash says* now,
*the ring says* where, *the sum of rings says* how many, and how arranged.
