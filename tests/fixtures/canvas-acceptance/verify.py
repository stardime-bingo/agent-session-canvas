import argparse
import json
import os
import re
import time
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:4518"
CHROME = os.environ.get(
    "LE014_CHROME",
    os.environ.get(
        "LE013_CHROME",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ),
)
TERMINAL = ("pass", "fail", "error")
FORBIDDEN_RESOURCE_ROOTS = ("/api", "/data", "/@fs", "/.git")
WORKER_ENTRY = re.compile(r"/assets/[^/]*subset-worker\.chunk-[A-Za-z0-9_-]+\.js$")
INTERACTION_CHECKS = (
    "concurrent", "revision", "opening", "closing",
    "coldError", "warmError", "lateIsolation",
)
PROD_BOOTSTRAP_HASH = "'sha256-+ZhgVBfEh3qSkRtu4+LWwD2KtClSz7NQW2e602MUclw='"
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
    "scannedAt": "2026-07-17T00:00:00.000Z",
    "layout": {},
    "sceneToken": "0" * 64,
    "canvas": {
        "edges": [], "notes": [], "boards": [], "drawing": [], "drawingFiles": {},
    },
}


def is_local_resource(url):
    parsed = urlparse(url)
    if parsed.scheme in ("data", "blob"):
        return True
    return (
        parsed.scheme == "http"
        and parsed.hostname == "127.0.0.1"
        and parsed.port == 4518
    )


def has_forbidden_resource(url):
    path = urlparse(url).path
    return any(path == root or path.startswith(f"{root}/") for root in FORBIDDEN_RESOURCE_ROOTS)


def install_network_gate(context, external, api_resources):
    def route_request(route):
        url = route.request.url
        if is_local_resource(url):
            route.continue_()
        else:
            external.append(url)
            route.abort()

    context.route("**/*", route_request)


def attach_native_diagnostics(page):
    diagnostics = {
        "consoleErrors": [],
        "consoleWarnings": [],
        "pageErrors": [],
        "requestFailed": [],
        "requests": [],
    }

    def record_console(message):
        if message.type == "error":
            diagnostics["consoleErrors"].append(message.text)
        elif message.type == "warning":
            diagnostics["consoleWarnings"].append(message.text)

    page.on("console", record_console)
    page.on("pageerror", lambda error: diagnostics["pageErrors"].append(str(error)))
    page.on("request", lambda request: diagnostics["requests"].append(request.url))
    page.on("requestfailed", lambda request: diagnostics["requestFailed"].append({
        "url": request.url,
        "failure": str(request.failure or "request failed"),
    }))
    return diagnostics


def assert_native_clean(diagnostics):
    assert not diagnostics["consoleErrors"], json.dumps(diagnostics["consoleErrors"], ensure_ascii=False)
    assert not diagnostics["consoleWarnings"], json.dumps(diagnostics["consoleWarnings"], ensure_ascii=False)
    assert not diagnostics["pageErrors"], json.dumps(diagnostics["pageErrors"], ensure_ascii=False)
    assert not diagnostics["requestFailed"], json.dumps(diagnostics["requestFailed"], ensure_ascii=False)


def production_init_script():
    graph = json.dumps(PROD_GRAPH, ensure_ascii=False, separators=(",", ":"))
    return f"""
(() => {{
  const graph = {graph};
  const originalFetch = window.fetch.bind(window);
  const state = window.__PROD_BOOT_STUB__ = {{
    graphCalls: 0,
    unexpectedFetch: [],
    eventSource: {{ created: 0, opened: 0, closed: 0 }},
    eventSourceUrls: [],
  }};
  window.fetch = async (input, init = {{}}) => {{
    const href = typeof input === 'string' ? input : input.url;
    const url = new URL(href, location.href);
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    if (url.pathname === '/api/graph' && method === 'GET') {{
      state.graphCalls += 1;
      return new Response(JSON.stringify(graph), {{
        status: 200,
        headers: {{ 'Content-Type': 'application/json' }},
      }});
    }}
    state.unexpectedFetch.push({{ method, path: url.pathname }});
    return originalFetch(input, init);
  }};
  class SyntheticEventSource {{
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) {{
      this.url = String(url);
      this.readyState = SyntheticEventSource.CONNECTING;
      this.onopen = null;
      this.onerror = null;
      this.onmessage = null;
      this._closed = false;
      state.eventSource.created += 1;
      state.eventSourceUrls.push(new URL(this.url, location.href).pathname);
      queueMicrotask(() => {{
        if (this._closed) return;
        this.readyState = SyntheticEventSource.OPEN;
        state.eventSource.opened += 1;
        this.onopen?.({{ type: 'open' }});
      }});
    }}
    close() {{
      if (this._closed) return;
      this._closed = true;
      this.readyState = SyntheticEventSource.CLOSED;
      state.eventSource.closed += 1;
    }}
  }}
  window.EventSource = SyntheticEventSource;
}})();
"""


def verify_prod_boot(browser):
    context = browser.new_context()
    external = []
    api_resources = []
    install_network_gate(context, external, api_resources)
    context.add_init_script(script=production_init_script())
    page = context.new_page()
    diagnostics = attach_native_diagnostics(page)

    def record_request(request):
        if has_forbidden_resource(request.url):
            api_resources.append(request.url)

    page.on("request", record_request)
    response = page.goto(BASE, wait_until="domcontentloaded", timeout=90000)
    assert response is not None and response.status == 200
    canvas = page.locator(".canvas-root")
    canvas.wait_for(state="visible", timeout=90000)
    page.wait_for_timeout(100)
    bounds = canvas.bounding_box()
    assert bounds and bounds["width"] > 100 and bounds["height"] > 100, bounds

    page_csp = response.headers.get("content-security-policy", "")
    script_src = next(
        (directive.strip() for directive in page_csp.split(";") if directive.strip().startswith("script-src ")),
        "",
    )
    assert PROD_BOOTSTRAP_HASH in script_src, script_src
    assert "'unsafe-inline'" not in script_src, script_src
    assert "'unsafe-eval'" not in script_src.split(), script_src
    assert "connect-src 'none'" in page_csp

    stub = page.evaluate("() => window.__PROD_BOOT_STUB__")
    assert stub["graphCalls"] == 1, stub
    assert stub["unexpectedFetch"] == [], stub
    assert stub["eventSource"]["created"] == 1, stub
    assert stub["eventSource"]["opened"] == 1, stub
    assert stub["eventSourceUrls"] == ["/api/events"], stub
    assert not external, json.dumps(external, ensure_ascii=False)
    assert not api_resources, json.dumps(api_resources, ensure_ascii=False)
    assert_native_clean(diagnostics)
    tdz = diagnostics["consoleErrors"] + diagnostics["pageErrors"]
    assert not any("ReferenceError" in entry or "before initialization" in entry for entry in tdz), tdz

    result = {
        "status": "pass",
        "canvas": {"width": bounds["width"], "height": bounds["height"]},
        "graphCalls": stub["graphCalls"],
        "eventSource": stub["eventSource"],
        "eventSourceUrls": stub["eventSourceUrls"],
        "consoleErrors": 0,
        "consoleWarnings": 0,
        "pageErrors": 0,
        "requestFailed": 0,
        "externalResources": 0,
        "apiResources": 0,
        "cspHash": PROD_BOOTSTRAP_HASH,
    }
    context.close()
    return result


def verify_interaction(browser):
    context = browser.new_context()
    external = []
    api_resources = []
    install_network_gate(context, external, api_resources)
    page = context.new_page()
    diagnostics = attach_native_diagnostics(page)

    def record_request(request):
        if has_forbidden_resource(request.url):
            api_resources.append(request.url)

    page.on("request", record_request)
    response = page.goto(f"{BASE}/?mode=interaction", wait_until="domcontentloaded", timeout=90000)
    assert response is not None and response.status == 200
    deadline = time.monotonic() + 180
    report = page.evaluate("() => window.__CANVAS_INTERACTION__ || null")
    while (not report or report.get("status") not in TERMINAL) and time.monotonic() < deadline:
        page.wait_for_timeout(50)
        report = page.evaluate("() => window.__CANVAS_INTERACTION__ || null")
    assert report and report.get("status") in TERMINAL, "interaction did not reach terminal status"

    assert report["mode"] == "interaction", report.get("mode")
    assert report["status"] == "pass", json.dumps(report.get("details"), ensure_ascii=False)
    assert report["passed"] is True
    assert set(report["checks"]) == set(INTERACTION_CHECKS), report["checks"]
    for name in INTERACTION_CHECKS:
        assert report["checks"][name] is True, name
        assert report["details"][name]["passed"] is True, json.dumps(report["details"][name], ensure_ascii=False)
    closing = report["details"]["closing"]
    assert closing["persistedSignatureChanged"] is True, json.dumps(closing, ensure_ascii=False)
    assert closing["drawingCommitDelta"] == 1, json.dumps(closing, ensure_ascii=False)
    if closing["reusedWithoutExport"] is True:
        seed = closing["seedExport"]
        assert closing["export"] is None, json.dumps(closing, ensure_ascii=False)
        assert closing["exactSeedReuse"] is True, json.dumps(closing, ensure_ascii=False)
        assert seed["scenario"] == "closing", json.dumps(seed, ensure_ascii=False)
        assert seed["kind"] == "group", json.dumps(seed, ensure_ascii=False)
        assert closing["fromRevision"] < seed["revision"] < closing["revision"], json.dumps(closing, ensure_ascii=False)
        assert seed["signature"] == closing["finalDrawingSignature"], json.dumps(closing, ensure_ascii=False)
    assert report["consoleErrors"] == []
    assert report["consoleWarnings"] == []
    assert report["pageErrors"] == []
    assert report["apiResources"] == []
    assert report["apiResourceCount"] == 0
    assert page.get_attribute("html", "data-interaction-status") == "pass"
    assert page.get_attribute("html", "data-interaction-passed") == "true"
    assert not external, json.dumps(external, ensure_ascii=False)
    assert not api_resources, json.dumps(api_resources, ensure_ascii=False)
    assert_native_clean(diagnostics)

    result = {
        "status": "pass",
        "checks": {name: True for name in INTERACTION_CHECKS},
        "closing": {
            "fromRevision": closing["fromRevision"],
            "revision": closing["revision"],
            "export": closing["export"],
            "seedExport": closing["seedExport"],
            "finalDrawingSignature": closing["finalDrawingSignature"],
            "persistedSignatureChanged": closing["persistedSignatureChanged"],
            "drawingCommitDelta": closing["drawingCommitDelta"],
            "exactSeedReuse": closing["exactSeedReuse"],
            "reusedWithoutExport": closing["reusedWithoutExport"],
        },
        "consoleErrors": 0,
        "consoleWarnings": 0,
        "pageErrors": 0,
        "requestFailed": 0,
        "externalResources": 0,
        "apiResources": 0,
    }
    context.close()
    return result


def verify_size(browser, size):
    context = browser.new_context()
    external = []
    api_resources = []
    requests = []

    def route_request(route):
        url = route.request.url
        if is_local_resource(url):
            route.continue_()
        else:
            external.append(url)
            route.abort()

    context.route("**/*", route_request)
    page = context.new_page()
    console_errors = []
    console_warnings = []
    page_errors = []
    worker_responses = []

    def record_request(request):
        requests.append(request.url)
        if not is_local_resource(request.url):
            external.append(request.url)
        if has_forbidden_resource(request.url):
            api_resources.append(request.url)

    def record_console(message):
        if message.type == "error":
            console_errors.append(message.text)
        elif message.type == "warning":
            console_warnings.append(message.text)

    def record_response(response):
        if WORKER_ENTRY.search(urlparse(response.url).path):
            worker_responses.append({
                "url": response.url,
                "status": response.status,
                "csp": response.headers.get("content-security-policy", ""),
            })

    page.on("request", record_request)
    page.on("console", record_console)
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.on("response", record_response)

    response = page.goto(
        f"{BASE}/?size={size}&autorun=1",
        wait_until="domcontentloaded",
        timeout=90000,
    )
    assert response is not None and response.status == 200
    deadline = time.monotonic() + 180
    status = page.get_attribute("html", "data-acceptance-status")
    while status not in TERMINAL and time.monotonic() < deadline:
        page.wait_for_timeout(50)
        status = page.get_attribute("html", "data-acceptance-status")
    assert status in TERMINAL, f"canvas {size} did not reach a terminal status: {status}"

    report = json.loads(page.get_attribute("html", "data-acceptance-report") or "{}")
    last_ready = json.loads(page.get_attribute("html", "data-last-ready") or "{}")
    meta_csp = page.locator('meta[http-equiv="Content-Security-Policy"]').get_attribute("content") or ""
    page_csp = response.headers.get("content-security-policy", "")

    assert status == "pass", json.dumps(report, ensure_ascii=False)
    checks = report.get("checks") or {}
    assert checks and all(value is True for value in checks.values()), json.dumps(checks)
    assert checks.get("sampledAfterPaint") is True
    assert last_ready.get("sampledAfterPaint") is True
    assert last_ready.get("timingBoundary") == "dom-ready+double-rAF-paint"

    assert "'unsafe-eval'" not in page_csp
    assert "'unsafe-eval'" not in meta_csp
    assert "connect-src 'self'" in page_csp
    assert "connect-src 'self'" in meta_csp
    assert "font-src 'self' data:" in page_csp

    assert worker_responses, "subset worker response was not observed"
    assert all(entry["status"] == 200 for entry in worker_responses)
    privileged_worker_responses = [
        entry for entry in worker_responses if "'unsafe-eval'" in entry["csp"]
    ]
    privileged_worker_urls = {entry["url"] for entry in privileged_worker_responses}
    assert len(privileged_worker_urls) == 1, json.dumps(worker_responses)
    assert privileged_worker_responses
    assert all("'wasm-unsafe-eval'" in entry["csp"] for entry in privileged_worker_responses)

    internal_console_errors = report.get("consoleErrors") or []
    internal_console_warnings = report.get("consoleWarnings") or []
    internal_page_errors = report.get("pageErrors") or []
    assert not console_errors, json.dumps(console_errors, ensure_ascii=False)
    assert not console_warnings, json.dumps(console_warnings, ensure_ascii=False)
    assert not page_errors, json.dumps(page_errors, ensure_ascii=False)
    assert not internal_console_errors, json.dumps(internal_console_errors, ensure_ascii=False)
    assert not internal_console_warnings, json.dumps(internal_console_warnings, ensure_ascii=False)
    assert not internal_page_errors, json.dumps(internal_page_errors, ensure_ascii=False)
    assert not external, json.dumps(sorted(set(external)), ensure_ascii=False)
    assert not api_resources, json.dumps(sorted(set(api_resources)), ensure_ascii=False)

    result = {
        "size": size,
        "status": status,
        "checks": checks,
        "workerObserved": True,
        "workerResponses": len(privileged_worker_urls),
        "sampledAfterPaint": True,
        "consoleErrors": 0,
        "consoleWarnings": 0,
        "pageErrors": 0,
        "externalResources": 0,
        "apiResources": 0,
        "resourceCount": len(set(requests)),
    }
    context.close()
    return result


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
                "production": verify_prod_boot(browser),
                "interaction": verify_interaction(browser),
            }
        else:
            output = {"ok": True, "sizes": [verify_size(browser, size) for size in (300, 800)]}
    finally:
        browser.close()

print(json.dumps(output, ensure_ascii=False))
