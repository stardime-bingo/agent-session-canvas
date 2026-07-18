import argparse
import json
import os
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:4518"
CHROME = os.environ.get(
    "AGENT_CANVAS_CHROME",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
TERMINAL = ("complete", "fail", "error")
FORBIDDEN_RESOURCE_ROOTS = ("/api", "/data", "/@fs", "/.git")
MOUNT_BUDGET_MS = {300: 900, 800: 1600}
PROD_GRAPH = {
    "sessions": [],
    "workspaces": {},
    "edges": [],
    "stats": {
        "total": 0,
        "workspaces": 0,
        "byTool": {},
        "byStatus": {},
        "hidden": {"subagent": 0, "empty": 0},
    },
    "scannedAt": "2026-07-18T00:00:00.000Z",
    "rev": 1,
    "layout": {},
    "canvas": {
        "edges": [], "notes": [], "boards": [], "drawing": [], "drawingFiles": {},
    },
}


def is_local_resource(url):
    parsed = urlparse(url)
    return parsed.scheme in ("data", "blob") or (
        parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port == 4518
    )


def has_forbidden_resource(url):
    path = urlparse(url).path
    return any(path == root or path.startswith(f"{root}/") for root in FORBIDDEN_RESOURCE_ROOTS)


def diagnostics_for(context, page):
    diagnostics = {
        "consoleErrors": [],
        "consoleWarnings": [],
        "pageErrors": [],
        "requestFailed": [],
        "externalResources": [],
        "apiResources": [],
    }

    def route_request(route):
        url = route.request.url
        if is_local_resource(url):
            route.continue_()
        else:
            diagnostics["externalResources"].append(url)
            route.abort()

    def record_console(message):
        if message.type == "error":
            diagnostics["consoleErrors"].append(message.text)
        elif message.type == "warning":
            diagnostics["consoleWarnings"].append(message.text)

    context.route("**/*", route_request)
    page.on("console", record_console)
    page.on("pageerror", lambda error: diagnostics["pageErrors"].append(str(error)))
    page.on("requestfailed", lambda request: diagnostics["requestFailed"].append({
        "url": request.url,
        "failure": str(request.failure or "request failed"),
    }))
    page.on("request", lambda request: diagnostics["apiResources"].append(request.url)
            if has_forbidden_resource(request.url) else None)
    return diagnostics


def assert_clean(diagnostics):
    for key in diagnostics:
        assert not diagnostics[key], f"{key}: {json.dumps(diagnostics[key], ensure_ascii=False)}"


def production_init_script():
    graph = json.dumps(PROD_GRAPH, ensure_ascii=False, separators=(",", ":"))
    return f"""
(() => {{
  const graph = {graph};
  const state = window.__PROD_BOOT_STUB__ = {{ graphCalls: 0, unexpectedFetch: [], eventSources: 0 }};
  window.fetch = async (input, init = {{}}) => {{
    const href = typeof input === 'string' ? input : input.url;
    const url = new URL(href, location.href);
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    if (url.pathname === '/api/graph' && method === 'GET') {{
      state.graphCalls += 1;
      return new Response(JSON.stringify(graph), {{ status: 200, headers: {{ 'Content-Type': 'application/json' }} }});
    }}
    state.unexpectedFetch.push({{ method, path: url.pathname }});
    return new Response(JSON.stringify({{ error: 'unexpected fixture request' }}), {{ status: 500 }});
  }};
  window.EventSource = class SyntheticEventSource {{
    constructor(url) {{
      this.url = String(url); this.onopen = null; this.onerror = null; this.onmessage = null;
      state.eventSources += 1;
      queueMicrotask(() => this.onopen?.({{ type: 'open' }}));
    }}
    close() {{}}
  }};
}})();
"""


def verify_production(browser):
    context = browser.new_context(viewport={"width": 1440, "height": 960})
    context.add_init_script(script=production_init_script())
    page = context.new_page()
    diagnostics = diagnostics_for(context, page)
    response = page.goto(BASE, wait_until="networkidle", timeout=90_000)
    assert response is not None and response.status == 200
    page.locator(".canvas-root").wait_for(state="visible", timeout=90_000)
    bounds = page.locator(".canvas-root").bounding_box()
    stub = page.evaluate("() => window.__PROD_BOOT_STUB__")
    assert bounds and bounds["width"] > 100 and bounds["height"] > 100, bounds
    assert stub["graphCalls"] == 1, stub
    assert stub["unexpectedFetch"] == [], stub
    assert stub["eventSources"] == 1, stub
    csp = response.headers.get("content-security-policy", "")
    assert "connect-src 'none'" in csp, csp
    assert "'unsafe-eval'" not in csp, csp
    assert_clean(diagnostics)
    context.close()
    return {
        "status": "pass",
        "canvas": {"width": bounds["width"], "height": bounds["height"]},
        "graphCalls": stub["graphCalls"],
        "consoleErrors": 0,
        "consoleWarnings": 0,
        "pageErrors": 0,
    }


def wait_for_probe(page):
    page.wait_for_function(
        "statuses => statuses.includes(window.__CANVAS_ACCEPTANCE__?.status)",
        arg=TERMINAL,
        timeout=180_000,
    )
    return page.evaluate("() => window.__CANVAS_ACCEPTANCE__")


def verify_interaction(browser):
    context = browser.new_context(viewport={"width": 1440, "height": 960})
    page = context.new_page()
    diagnostics = diagnostics_for(context, page)
    response = page.goto(f"{BASE}/?mode=interaction&autorun=1", wait_until="networkidle", timeout=90_000)
    assert response is not None and response.status == 200
    report = wait_for_probe(page)
    assert report["status"] == "complete", json.dumps(report, ensure_ascii=False)
    checks = report["report"]["checks"]
    assert len(checks) >= 15, checks
    assert all(checks.values()), json.dumps(checks, ensure_ascii=False)
    assert page.get_attribute("html", "data-interaction-status") == "pass"
    assert_clean(diagnostics)
    context.close()
    return {
        "status": "pass",
        "checks": checks,
        "consoleErrors": 0,
        "consoleWarnings": 0,
        "pageErrors": 0,
        "externalResources": 0,
        "apiResources": 0,
    }


def verify_size(browser, size):
    context = browser.new_context(viewport={"width": 1440, "height": 960})
    page = context.new_page()
    diagnostics = diagnostics_for(context, page)
    response = page.goto(f"{BASE}/?size={size}", wait_until="networkidle", timeout=90_000)
    assert response is not None and response.status == 200
    report = wait_for_probe(page)
    detail = report["report"]
    assert report["status"] == "complete", detail
    assert detail["pass"] is True, detail
    assert detail["domCount"] == size, detail
    assert detail["budgetMs"] == MOUNT_BUDGET_MS[size], detail
    assert detail["mountMs"] <= detail["budgetMs"], detail
    assert_clean(diagnostics)
    context.close()
    return {
        "size": size,
        "status": "pass",
        "domCount": detail["domCount"],
        "mountMs": detail["mountMs"],
        "budgetMs": detail["budgetMs"],
        "consoleErrors": 0,
        "consoleWarnings": 0,
        "pageErrors": 0,
        "externalResources": 0,
        "apiResources": 0,
    }


parser = argparse.ArgumentParser()
parser.add_argument("--suite", choices=("canvas", "prod"), default="canvas")
args = parser.parse_args()

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
    try:
        if args.suite == "prod":
            output = {
                "ok": True,
                "suite": "prod",
                "production": verify_production(browser),
                "interaction": verify_interaction(browser),
            }
        else:
            output = {"ok": True, "suite": "canvas", "sizes": [verify_size(browser, size) for size in (300, 800)]}
    finally:
        browser.close()

print(json.dumps(output, ensure_ascii=False))
