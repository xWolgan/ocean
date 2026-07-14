# Audio resilience: retry + visible status

**Who:** Wolgan (direct to main, pre-Monika phase — commits c360f02,
3ee148b, 647552a, 2026-07)

## The trigger

Monika's first remote test: visuals fine, sound from other sites fine,
OCEAN silent. Same URL played on Wolgan's machine. We had no way to see
what her audio engine was doing — the app was a black box on a machine
we couldn't touch.

## What was wrong on our side

The audio start was armed with a `{once: true}` first-click listener.
If that single attempt failed for any transient reason (autoplay policy
quirk, busy audio device, slow worklet fetch), the listener was already
consumed — the app stayed permanently silent with zero feedback, and
only a reload (with a luckier first click) could cure it. A silent
failure mode in an instrument whose whole point is sound.

## What is true now

- Every click retries `audio.start()` until the context is running.
- A failed start resets the half-built context so the retry is clean,
  and captures the reason.
- The stats overlay has an `audio` line: `off (click to start)` /
  `running` / `suspended` / `FAILED: <reason>`. A non-technical tester
  reads it aloud and the remote studio knows exactly where the chain
  broke — the screen is the diagnostic.

## Lesson recorded for both studios

A scripted bulk edit of `start()` failed silently once (the status
field existed but nothing wrote to it); the headless probe caught it
because it asserted the overlay TEXT, not the code. Verify claims at
the surface the user sees.
