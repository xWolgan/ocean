"""Stage-1 audio probe: engine runs, sings in the right bands, reports.
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
                assert probe["voices"] >= 0 and probe["bed"] > 1000, json.dumps(probe)
                # band sanity via a tapped AnalyserNode
                bands = page.evaluate("""async () => {
                    const eng = __ocean.audio;
                    const ctx = eng['ctx']; const node = eng['node'];
                    const an = ctx.createAnalyser(); an.fftSize = 4096;
                    node.connect(an);
                    await new Promise(r => setTimeout(r, 1500));
                    const d = new Float32Array(an.frequencyBinCount);
                    an.getFloatFrequencyData(d);
                    const hz = i => i * ctx.sampleRate / an.fftSize;
                    let inBand = -200, sub = -200;
                    for (let i = 0; i < d.length; i++) {
                        if (hz(i) > 55 && hz(i) < 4000) inBand = Math.max(inBand, d[i]);
                        if (hz(i) < 20) sub = Math.max(sub, d[i]);
                    }
                    return { inBand, sub };
                }""")
                assert bands["inBand"] > -80, f"no audible energy: {bands}"
                assert bands["inBand"] > bands["sub"] + 20, f"rumble: {bands}"
                print("PROBE PASS", json.dumps(probe), json.dumps(bands))
            finally:
                browser.close()
    finally:
        kill_proc_tree(dev)


if __name__ == "__main__":
    main()
