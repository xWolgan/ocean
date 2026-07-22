"""Stage-1 audio probe: engine runs, sings in the right bands, reports.
Also the corpuscular-transport live check: a captured object at a known
distance rings its flash-to-ring gap (r/343) into the real AnalyserNode
output -- see measure_flash_to_ring() for the method.
Foreground, timeout, GPU flags, always-closed -- per CLAUDE.md.

Run: python probes/audio_stage1.py   (foreground, wrap with an external
timeout when scripting -- e.g. `timeout 120 python probes/audio_stage1.py`
on a shell that has `timeout`, or Start-Process -Wait with a job timeout
on PowerShell). Never leave this backgrounded.
"""
import json
import subprocess
import sys
import time
import urllib.request
import urllib.error

from playwright.sync_api import sync_playwright

PORT = 5199
URL = f"http://localhost:{PORT}"


def wait_for_server(url, timeout_s=30):
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return True
        except Exception as e:  # noqa: BLE001 - just polling
            last_err = e
            time.sleep(0.3)
    raise RuntimeError(f"dev server never came up at {url}: {last_err}")


def kill_proc_tree(proc):
    """Best-effort, forceful cleanup of the vite dev server and any
    children it spawned (npx on Windows wraps node in a shell/cmd
    layer -- plain terminate() can leave the real node.exe behind)."""
    if proc.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        else:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
    except Exception as e:  # noqa: BLE001 - cleanup must not raise
        print(f"warning: dev server cleanup issue: {e}", file=sys.stderr)


def measure_flash_to_ring(page):
    """Live check: place a captured, fully-synced point object at a known
    distance r and verify the audio's per-ear arrival lag is r/343 (the
    flash-to-ring gap of
    docs/superpowers/specs/2026-07-19-corpuscular-transport-design.md
    Sec 2.1), within +-3 ms.

    Method (deliberately NOT two separate page loads): comparing a
    default-URL capture against a fresh `?transport=off` navigation would
    need two independent AudioContext startups, and cross-navigation
    JS-scheduling jitter (page load, click dispatch, context creation)
    is comparable in size to the ~8.75 ms signal being measured here --
    too noisy for a +-3ms assertion. Instead this flips the SAME running
    engine's transport flag mid-recording, three times (alternating
    direction), and reads the delay directly off continuous captures that
    straddle each flip -- the MEDIAN of the three rounds is the reported
    measurement, absorbing the live engine's own cycle-to-cycle jitter
    (see below) the way the offline suite's determinism never has to.
    `AudioEngine.transportFlag` is declared `private` in TypeScript but
    NOT a true `#private` field, so it erases to a plain writable JS
    property at build time (confirmed by reading src/audio/AudioEngine.ts:
    `update()` already re-reads `this.transportFlag` fresh on every
    ~60 Hz tick to build the params message) -- writing it from the
    console is exactly what `?transport=off` does internally, minus the
    navigation and its jitter.

    The captured object is a steady tau-periodic pulse train (sync=1,
    claim=1, huge influenceRadius so it sweeps up the whole pool).
    While transport is ON every burst arrives at its true emission time
    + r/343; the instant the flag flips to OFF, the very next rendered
    burst arrives r/343 EARLIER than the metronomic cadence predicts --
    one exactly-dE-shorter gap in an otherwise uniform tau-spaced train.
    The measurement is read off each recording's own onset spacing, so
    no JS-side timestamp precision is required at all.
    """
    r = 3.0  # matches the offline flash-to-ring/ITD acceptance geometry
    tau = 0.05  # longer than the offline suite's 0.02s: more silence
    # between bursts survives the FDN tail's reverberant floor better in
    # a live, noisier capture (chosen for this test's own robustness,
    # not required to match the offline geometry)
    expected_ms = r / 343 * 1000  # ~8.746 ms
    sr = 48000
    n_rounds = 3

    rounds = page.evaluate(
        """async ([r, tau, nRounds]) => {
            const o = window.__ocean;
            const ctx = o.audio['ctx'];
            // quiet the free/environment field so the captured pulse
            // train dominates the recording; captured voices keep full
            // volume via objectGain
            o.bus.base.fieldGain = 0.02;
            o.bus.base.objectGain = 1.0;
            const lifespanValue = Math.log10(tau / 0.001) / 2; // invert tau = 0.001*10^(2L)
            const def = {
                id: 'probe-flash-to-ring', name: 'flash-to-ring probe',
                generator: { kind: 'point', position: [0, 1.7, 4.4 - r], sigma: 0.02 },
                patch: {
                    lifespan: { value: lifespanValue, weight: 1 },
                    scale: { value: 0.5, weight: 0.5 }, octave: 0,
                    tintR: 0.85, tintG: 0.88, tintB: 0.9, tintWeight: 0.5,
                    colorRandom: { value: 0, weight: 1 }, sizeRandom: { value: 0.5, weight: 1 },
                    smear: { value: 0.5, weight: 1 }, asymmetry: { value: 0, weight: 1 },
                    sync: 1, gain: 1, imageColor: 1,
                },
                attack: 0.05, release: 2.0, influenceRadius: 10, spatialSmear: 0,
                claim: 1, active: true,
            };
            await o.objects.add(def);
            // let capture sweep the pool into this object's slot over
            // many tau cycles before recording (steady state, not the
            // capture transient)
            await new Promise((res) => setTimeout(res, 2000));

            const an = ctx.createAnalyser();
            an.fftSize = 32768; // ~682ms window at 48kHz
            o.audio['node'].connect(an);
            // Warm-up must clear the FULL buffer duration before the
            // first flip, or the oldest part of that capture is silence
            // from before the analyser was connected (its ring buffer
            // has no real audio to report yet) -- that silence-to-signal
            // edge was mistaken for a burst onset in an earlier version
            // of this probe.
            await new Promise((res) => setTimeout(res, 700));

            const out = [];
            let on = true; // transport starts ON (default flag value)
            for (let i = 0; i < nRounds; i++) {
                // steady state before this round's flip -- also doubles
                // as the settle time after the PREVIOUS round's capture
                await new Promise((res) => setTimeout(res, 380));
                const onToOff = on;
                o.audio.transportFlag = on ? 0 : 1;
                on = !on;
                // enough post-flip audio that the capture below straddles
                // the flip instant with margin either side
                await new Promise((res) => setTimeout(res, 345));
                const buf = new Float32Array(an.fftSize);
                an.getFloatTimeDomainData(buf);
                out.push({ buf: Array.from(buf), onToOff });
            }
            return out;
        }""",
        [r, tau, n_rounds],
    )

    def analyze_round(raw, on_to_off, flip_wait_s):
        n = len(raw)
        absbuf = [abs(x) for x in raw]
        # envelope: rectify + a short moving average (~0.4ms) -- smooths
        # the carrier without smearing the burst-scale (tens-of-ms)
        # transients
        win = 20
        env = [0.0] * n
        acc = 0.0
        for i in range(n):
            acc += absbuf[i]
            if i >= win:
                acc -= absbuf[i - win]
            env[i] = acc / min(i + 1, win)

        peak = max(env)
        assert peak > 1e-4, f"flash-to-ring probe: no signal captured (peak {peak})"
        threshold = 0.25 * peak
        refractory = int(0.7 * tau * sr)  # under one period, over one burst + its tail wobble

        onsets = []
        hold = 0
        for i in range(n):
            if hold > 0:
                hold -= 1
                continue
            if env[i] > threshold:
                onsets.append(i)
                hold = refractory

        assert len(onsets) >= 8, f"flash-to-ring probe: too few onsets detected ({onsets})"
        # Drop the first and last detections: the capture window's edges
        # can clip a burst already in progress (its rising edge truncated
        # by the buffer boundary), which reads as a spurious near-instant
        # "onset" unrelated to any real cycle and skews the phase average
        # below -- verified empirically (a first onset within a few
        # samples of index 0 pulled the pre-flip phase off by ~9ms in an
        # earlier version of this probe).
        onsets = onsets[1:-1]

        # Read the flip's effect as a PHASE shift between the steady
        # region before it and the steady region after it, not off the
        # transition cycle(s) themselves. An instantaneous mid-stream
        # flag flip crosses hop-enumeration boundaries the engine was
        # never designed to be flipped at (the foreign-clock principle
        # wants control changes to land at natural generation boundaries;
        # a bare console-write to transportFlag has no such courtesy), so
        # the 1-2 cycles straddling the flip render under a mix of
        # ON/OFF enumeration rules and do NOT cleanly show a single
        # r/343-shorter gap (verified empirically -- see the report). But
        # the object's own emission phase (asgPhi/asgInvTau) is untouched
        # by the flip -- only whether the arrival-time offset is ADDED at
        # render time -- so bursts recorded well before the flip sit at
        # (emission_phase [+ dE]) and bursts recorded well after it sit
        # at (emission_phase [+ dE if the OTHER state was ON]). Comparing
        # the AVERAGE modular phase of each steady region, several cycles
        # away from the flip on both sides, measures dE directly while
        # completely ignoring the messy transition and how many whole
        # cycles occurred inside it.
        nominal_samples = round(tau * sr)
        # buffer-relative sample index where the flip was requested (see
        # the JS above: 380ms steady-state wait, then flip, then
        # `flip_wait_s` before capture ends)
        flip_index = n - int(flip_wait_s * sr)
        # 2.5 cycles clear on both sides: 1.5 measured empirically NOT
        # enough -- the flip's effect (message-passing latency to the
        # worklet, plus a hop or two of mixed-rule rendering right at the
        # boundary) can still be settling barely past a 1.5-cycle margin
        # (observed: an onset 141 samples past a 1.5-cycle boundary was
        # still off by several ms). 2.5 cycles cleared it reliably in
        # repeated live runs.
        margin = int(2.5 * nominal_samples)
        pre = [o for o in onsets if o < flip_index - margin]
        post = [o for o in onsets if o > flip_index + margin]
        assert len(pre) >= 3 and len(post) >= 3, (
            f"flash-to-ring probe: not enough steady-state onsets either "
            f"side of the flip (pre={pre}, post={post}, flip_index={flip_index})"
        )

        def mean_phase(xs):
            # xs cluster tightly (well under one nominal_samples period)
            # once reduced mod the period, since jitter is small compared
            # to tau; anchor every residual to the first one before
            # averaging so a residual that happens to straddle the
            # 0/period wrap doesn't corrupt the mean.
            r0 = xs[0] % nominal_samples
            acc = 0.0
            for x in xs:
                res = x % nominal_samples
                d = (res - r0 + nominal_samples / 2) % nominal_samples - nominal_samples / 2
                acc += r0 + d
            return acc / len(xs)

        phase_pre = mean_phase(pre)
        phase_post = mean_phase(post)
        # Normalize sign to "ON minus OFF": if this round flipped ON->OFF,
        # pre is ON (delayed) and post is OFF (undelayed) -- phase_pre
        # should lead phase_post by +dE. If OFF->ON, it's the reverse, so
        # swap which side is subtracted from which.
        if on_to_off:
            raw_diff = phase_pre - phase_post
        else:
            raw_diff = phase_post - phase_pre
        # Wrap to the minimal-magnitude residue, (-nominal/2, nominal/2].
        measured_samples = raw_diff % nominal_samples
        if measured_samples > nominal_samples / 2:
            measured_samples -= nominal_samples
        return measured_samples / sr * 1000, len(onsets), len(pre), len(post)

    measurements = []
    for i, rnd in enumerate(rounds):
        ms, n_onsets, n_pre, n_post = analyze_round(rnd["buf"], rnd["onToOff"], 0.345)
        measurements.append(ms)
        print(
            f"  flash-to-ring round {i + 1}/{len(rounds)}: "
            f"{'ON->OFF' if rnd['onToOff'] else 'OFF->ON'} "
            f"onsets={n_onsets} (pre={n_pre} post={n_post}) measured={ms:.2f}ms"
        )

    measured_ms = sorted(measurements)[len(measurements) // 2]  # median of the rounds
    print(
        f"  flash-to-ring: rounds={[round(m, 2) for m in measurements]} "
        f"median={measured_ms:.2f}ms expected={expected_ms:.2f}ms"
    )
    assert abs(measured_ms - expected_ms) <= 3.0, (
        f"flash-to-ring gap {measured_ms:.2f}ms (median of {measurements}), "
        f"expected {expected_ms:.2f}ms +-3ms"
    )
    return measured_ms


def main():
    dev = subprocess.Popen(
        ["npx", "vite", "--port", str(PORT)], shell=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_server(URL, timeout_s=30)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=[
                "--enable-gpu", "--use-angle=d3d11",
                "--autoplay-policy=no-user-gesture-required"])
            try:
                page = browser.new_page()
                page.goto(URL, timeout=30000)
                page.wait_for_timeout(2500)
                page.mouse.click(400, 300)          # gesture starts audio
                page.wait_for_timeout(2500)
                status = page.evaluate("__ocean.audio.status")
                assert status == "running", f"audio status: {status}"
                probe = page.evaluate("""() => {
                    const a = __ocean.audio;
                    return { voices: a.voiceCount, bed: a.bedCount };
                }""")
                # heroes must actually be sounding in the default scene
                # (a silent hero layer is a real failure) and can never
                # exceed AudioEngine's posted heroCount cap (32; the 48
                # ceiling leaves headroom if the cap changes)
                assert 0 < probe["voices"] <= 48 and probe["bed"] > 1000, json.dumps(probe)
                # band sanity via a tapped AnalyserNode. The substance is
                # stochastic, so a single spectrum snapshot swings several
                # dB run to run — max-hold over a 2s window (20 frames,
                # 100ms apart, applied to BOTH bands so the comparison
                # stays fair) measures "energy over the window", which is
                # what the ear hears, not one arbitrary instant.
                bands = page.evaluate("""async () => {
                    const eng = __ocean.audio;
                    const ctx = eng['ctx']; const node = eng['node'];
                    const an = ctx.createAnalyser(); an.fftSize = 4096;
                    node.connect(an);
                    await new Promise(r => setTimeout(r, 500)); // analyser warmup
                    const d = new Float32Array(an.frequencyBinCount);
                    const hz = i => i * ctx.sampleRate / an.fftSize;
                    let inBand = -200, sub = -200;
                    for (let frame = 0; frame < 20; frame++) {
                        await new Promise(r => setTimeout(r, 100));
                        an.getFloatFrequencyData(d);
                        for (let i = 0; i < d.length; i++) {
                            if (hz(i) > 55 && hz(i) < 4000) inBand = Math.max(inBand, d[i]);
                            if (hz(i) < 20) sub = Math.max(sub, d[i]);
                        }
                    }
                    return { inBand, sub };
                }""")
                assert bands["inBand"] > -80, f"no audible energy: {bands}"
                # rumble margin 12 dB, calibrated from measurement (see
                # task-9-report.md): the healthy engine's sub-20Hz reading
                # is just the grain-envelope skirt after the output-stage
                # 25 Hz one-pole HP (no DC, no subsonic peak; bin-level
                # diagnostic confirmed a smooth monotonic rolloff), and
                # its max-hold margin varies 16-25 dB run to run. A real
                # rumble bug puts sub comparable to in-band (~0 dB
                # margin), so 12 dB separates cleanly in both directions;
                # the brief's original 20 dB sat inside healthy variance.
                assert bands["inBand"] > bands["sub"] + 12, f"rumble: {bands}"

                # corpuscular transport: the flash-to-ring gap, live
                flash_to_ring_ms = measure_flash_to_ring(page)

                print("PROBE PASS", json.dumps(probe), json.dumps(bands),
                      json.dumps({"flashToRingMs": round(flash_to_ring_ms, 2)}))
            finally:
                browser.close()
    finally:
        kill_proc_tree(dev)


if __name__ == "__main__":
    main()
