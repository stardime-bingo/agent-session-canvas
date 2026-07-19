import hashlib
import json
import os
import time
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:4518"
CHROME = os.environ.get(
    "AGENT_CANVAS_CHROME",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
ROOT = Path(__file__).resolve().parents[3]
SCREENSHOT = ROOT / "docs/assets/agent-session-canvas-hero.png"
OUTPUT = ROOT / "output/acceptance"
RUN_ID = f"{time.strftime('%Y%m%dT%H%M%S')}-{os.getpid()}"
FORBIDDEN_TEXT = ("/Users/", "bingowu", ".claude", ".codex", "r2://")


def is_local(url):
    parsed = urlparse(url)
    return parsed.scheme in ("data", "blob") or (
        parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port == 4518
    )


def main():
    diagnostics = {
        "consoleErrors": [],
        "consoleWarnings": [],
        "pageErrors": [],
        "requestFailed": [],
        "externalResources": [],
    }
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)

        def route_request(route):
            if is_local(route.request.url):
                route.continue_()
            else:
                diagnostics["externalResources"].append(route.request.url)
                route.abort()

        context.route("**/*", route_request)
        page = context.new_page()
        page.on("console", lambda message: diagnostics[
            "consoleErrors" if message.type == "error" else "consoleWarnings"
        ].append(message.text) if message.type in ("error", "warning") else None)
        page.on("pageerror", lambda error: diagnostics["pageErrors"].append(str(error)))
        page.on("requestfailed", lambda request: diagnostics["requestFailed"].append({
            "url": request.url,
            "failure": request.failure,
        }))

        response = page.goto(f"{BASE}/?mode=hero", wait_until="load", timeout=90_000)
        if not response or response.status != 200:
            raise RuntimeError(f"hero page did not return 200: {response.status if response else 'no response'}")
        page.wait_for_function(
            "() => document.documentElement.dataset.heroStatus === 'ready'",
            timeout=30_000,
        )
        page.add_style_tag(content=(
            "*,*::before,*::after{animation:none!important;transition:none!important;"
            "caret-color:transparent!important}"
        ))
        page.wait_for_timeout(400)

        counts = page.evaluate("window.__HERO_ACCEPTANCE__")
        visible_text = page.locator("body").inner_text()
        rendered_html = page.content()
        leaks = [token for token in FORBIDDEN_TEXT if token.lower() in f"{visible_text}\n{rendered_html}".lower()]

        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        png = page.screenshot(path=str(SCREENSHOT), full_page=True)
        version = browser.version
        context.close()
        browser.close()

    diagnostics_clean = all(not values for values in diagnostics.values())
    passed = bool(counts and counts.get("pass")) and not leaks and diagnostics_clean
    report = {
        "runId": RUN_ID,
        "suite": "anonymous-hero",
        "browser": f"Chrome {version}",
        "viewport": {"width": 1440, "height": 900, "deviceScaleFactor": 1},
        "counts": counts,
        "forbiddenTokens": list(FORBIDDEN_TEXT),
        "leaks": leaks,
        "diagnostics": diagnostics,
        "screenshot": {
            "path": str(SCREENSHOT),
            "bytes": len(png),
            "sha256": hashlib.sha256(png).hexdigest(),
        },
        "pass": passed,
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    report_path = OUTPUT / f"anonymous-hero-{RUN_ID}.report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({**report, "reportPath": str(report_path)}, ensure_ascii=False, indent=2))
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
