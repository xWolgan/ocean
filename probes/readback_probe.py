"""Stage-2 gate probe: measures what a tiny fenced GPU readback actually
costs per frame, at each particle count, on this machine. Foreground,
timeout, GPU flags, always-closed -- per CLAUDE.md.

Run: python probes/readback_probe.py   (foreground, wrap with an external
timeout when scripting -- e.g. `timeout 120 python probes/readback_probe.py`
on a shell that has `timeout`, or Start-Process -Wait with a job timeout
on PowerShell). Never leave this backgrounded.
"""
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

PORT = 5199
URL = f"http://localhost:{PORT}"
COUNTS = [131072, 524288]


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


def read_stats(page):
    return page.evaluate("document.getElementById('stats').textContent")


def sample_fps(page, samples=6, interval_ms=1000):
    """Average the fps line over several stats-overlay refreshes (the
    overlay updates every ~250ms with an EMA'd fps) to smooth out
    single-snapshot noise before comparing with/without the probe."""
    vals = []
    for _ in range(samples):
        page.wait_for_timeout(interval_ms)
        text = read_stats(page)
        for line in text.splitlines():
            if line.startswith("fps"):
                vals.append(float(line.split()[1]))
    return sum(vals) / len(vals) if vals else float("nan"), text


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
                for count in COUNTS:
                    # Baseline fps without the probe, for the "fps
                    # unchanged" half of the GO/NO-GO criterion.
                    page = browser.new_page()
                    page.goto(f"{URL}/?count={count}", timeout=30000)
                    page.wait_for_timeout(3000)  # let fps EMA settle
                    base_fps, base_text = sample_fps(page)
                    print(f"--- baseline (no probe, {count} particles) ---")
                    print(base_text)
                    print(f"avg fps over 6s: {base_fps:.1f}")
                    page.close()

                    # With the probe active.
                    page = browser.new_page()
                    page.goto(f"{URL}/?probe=readback&count={count}", timeout=30000)
                    page.wait_for_timeout(4000)  # let fps EMA + readback window settle
                    probe_fps, probe_text = sample_fps(page)
                    print(f"--- probe=readback count={count} ---")
                    print(probe_text)
                    print(f"avg fps over 6s: {probe_fps:.1f}")
                    delta_pct = (probe_fps - base_fps) / base_fps * 100 if base_fps else float("nan")
                    print(f"fps delta vs baseline: {delta_pct:+.1f}%")
                    page.close()
            finally:
                browser.close()
    finally:
        kill_proc_tree(dev)


if __name__ == "__main__":
    main()
