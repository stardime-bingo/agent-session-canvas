import argparse
import base64
import gzip
import hashlib
import json
import math
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
TERMINAL = ("complete", "fail", "error")
FORBIDDEN_RESOURCE_ROOTS = ("/api", "/data", "/@fs", "/.git")
MOUNT_BUDGET_MS = {300: 900, 800: 1600}
PERFORMANCE_352 = {
    "nodeCount": 352,
    "minFrameSamples": 90,
    "minPointerMoves": 100,
    "minDistinctPositions": 80,
    "minDisplacementPx": 150,
    "frameP95MaxMs": 20,
    "frameMaxMs": 50,
    "slowFrameRatioMax": 0.05,
    "longTaskMaxCount": 0,
}
RUN_ID = f"{time.strftime('%Y%m%dT%H%M%S')}-{os.getpid()}"
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


def percentile(values, fraction):
    ordered = sorted(values)
    if not ordered:
        return 0
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * fraction) - 1))
    return ordered[index]


def finish_cdp_trace(cdp, page):
    completed = []
    cdp.on("Tracing.tracingComplete", lambda params: completed.append(params))
    cdp.send("Tracing.end")
    for _ in range(500):
        if completed:
            break
        page.wait_for_timeout(10)
    assert completed and completed[0].get("stream"), "CDP trace stream did not complete"
    handle = completed[0]["stream"]
    chunks = []
    while True:
        part = cdp.send("IO.read", {"handle": handle})
        data = part.get("data", "")
        chunks.append(base64.b64decode(data) if part.get("base64Encoded") else data.encode())
        if part.get("eof"):
            break
    cdp.send("IO.close", {"handle": handle})
    return b"".join(chunks)


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


def verify_handoff_choice(browser):
    context = browser.new_context(viewport={"width": 900, "height": 600})
    page = context.new_page()
    diagnostics = diagnostics_for(context, page)
    response = page.goto(f"{BASE}/?mode=handoff-choice", wait_until="networkidle", timeout=90_000)
    assert response is not None and response.status == 200
    page.wait_for_function("() => window.__HANDOFF_CHOICE__?.ready === true", timeout=90_000)

    claude = page.get_by_test_id("handoff-launch-claude")
    codex = page.get_by_test_id("handoff-launch-codex")
    assert claude.count() == 1 and codex.count() == 1
    assert claude.is_enabled() and codex.is_enabled()
    assert page.evaluate("() => window.__HANDOFF_CHOICE__.calls.length") == 0

    claude.focus()
    page.keyboard.press("Enter")
    codex.click()
    result = page.evaluate("() => window.__HANDOFF_CHOICE__")
    contract = result["contract"]
    assert [call["tool"] for call in result["calls"]] == ["claude", "codex"], result
    for call in result["calls"]:
        assert call["payload"] == {
            "tool": call["tool"],
            "cwd": contract["cwd"],
            "mode": "prompt",
            "prompt": contract["handoff"],
            "sourceKey": contract["sourceKey"],
        }, call
    assert_clean(diagnostics)
    context.close()
    return {
        "status": "pass",
        "choices": [call["tool"] for call in result["calls"]],
        "samePrompt": result["calls"][0]["payload"]["prompt"] == result["calls"][1]["payload"]["prompt"],
        "noDefaultLaunch": True,
        "keyboardAndPointer": True,
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


def verify_performance_352(browser, artifacts_dir):
    context = browser.new_context(viewport={"width": 1440, "height": 960})
    page = context.new_page()
    diagnostics = diagnostics_for(context, page)
    trace_started = False
    cdp = None
    try:
        response = page.goto(f"{BASE}/?mode=performance-352", wait_until="networkidle", timeout=90_000)
        assert response is not None and response.status == 200
        report = wait_for_probe(page)
        assert report["status"] == "complete", json.dumps(report, ensure_ascii=False)
        detail = report["report"]
        assert detail["nodeCount"] == PERFORMANCE_352["nodeCount"], detail
        assert detail["targetCount"] == 1, detail

        target = page.locator(".react-flow__node-district .container-drag-handle")
        assert target.count() == 1, "performance drag target must be unique"
        target_box = target.bounding_box()
        district = page.locator(".react-flow__node-district")
        before = district.bounding_box()
        assert target_box and before, "performance drag geometry unavailable"
        start_x = target_box["x"] + min(180, target_box["width"] * 0.65)
        start_y = target_box["y"] + target_box["height"] / 2
        drag_x, drag_y = 180, 100
        page.mouse.move(start_x, start_y)

        cdp = context.new_cdp_session(page)
        cdp.send("Tracing.start", {
            "categories": ",".join([
                "devtools.timeline",
                "disabled-by-default-devtools.timeline.frame",
                "blink.user_timing",
                "toplevel",
            ]),
            "options": "sampling-frequency=10000",
            "transferMode": "ReturnAsStream",
        })
        trace_started = True
        page.evaluate("selector => window.__FLOW_PERF_352__.start(selector)", ".react-flow__node-district")
        page.mouse.down()
        for step in range(1, 121):
            page.mouse.move(
                start_x + drag_x * step / 120,
                start_y + drag_y * step / 120,
            )
            page.wait_for_timeout(16)
        page.mouse.up()
        page.wait_for_timeout(80)
        perf = page.evaluate("() => window.__FLOW_PERF_352__.stop()")
        after = district.bounding_box()
        assert after, "performance drag final geometry unavailable"
        trace_bytes = finish_cdp_trace(cdp, page)
        trace_started = False

        frame_intervals = perf["frameIntervals"]
        frame_p95 = percentile(frame_intervals, 0.95)
        frame_max = max(frame_intervals, default=0)
        slow_frames = [value for value in frame_intervals if value > PERFORMANCE_352["frameP95MaxMs"]]
        slow_ratio = len(slow_frames) / len(frame_intervals) if frame_intervals else 1
        effective_fps = 1000 / (sum(frame_intervals) / len(frame_intervals)) if frame_intervals else 0
        distinct_positions = len({
            (round(position["x"], 1), round(position["y"], 1))
            for position in perf["positions"]
        })
        displacement = math.hypot(after["x"] - before["x"], after["y"] - before["y"])
        page_long_tasks = [duration for duration in perf["longTasks"] if duration >= 50]

        trace = json.loads(trace_bytes)
        trace_events = trace.get("traceEvents", [])
        cdp_long_tasks = [
            event.get("dur", 0) / 1000
            for event in trace_events
            if event.get("name") == "RunTask"
            and event.get("ph") == "X"
            and event.get("dur", 0) >= 50_000
        ]

        thresholds = PERFORMANCE_352
        checks = {
            "nodeCount": detail["nodeCount"] == thresholds["nodeCount"],
            "frameSamples": len(frame_intervals) >= thresholds["minFrameSamples"],
            "pointerMoves": perf["pointerMoves"] >= thresholds["minPointerMoves"],
            "distinctPositions": distinct_positions >= thresholds["minDistinctPositions"],
            "displacement": displacement >= thresholds["minDisplacementPx"],
            "frameP95": frame_p95 <= thresholds["frameP95MaxMs"],
            "frameMax": frame_max <= thresholds["frameMaxMs"],
            "slowFrameRatio": slow_ratio <= thresholds["slowFrameRatioMax"],
            "longTaskSupport": perf["longTaskSupported"] is True,
            "pageLongTasks": len(page_long_tasks) <= thresholds["longTaskMaxCount"],
            "cdpLongTasks": len(cdp_long_tasks) <= thresholds["longTaskMaxCount"],
        }
        assert all(checks.values()), json.dumps({
            "checks": checks,
            "frameP95Ms": frame_p95,
            "frameMaxMs": frame_max,
            "slowFrameRatio": slow_ratio,
            "pageLongTasks": page_long_tasks,
            "cdpLongTasks": cdp_long_tasks,
        }, ensure_ascii=False)
        assert_clean(diagnostics)

        artifacts_dir.mkdir(parents=True, exist_ok=True)
        trace_path = artifacts_dir / f"canvas-352-performance-{RUN_ID}.trace.json.gz"
        compressed_trace = gzip.compress(trace_bytes, compresslevel=9)
        trace_path.write_bytes(compressed_trace)
        return {
            "status": "pass",
            "browserVersion": browser.version,
            "target": "district container",
            "nodeCount": detail["nodeCount"],
            "durationMs": round(perf["durationMs"], 2),
            "frameSamples": len(frame_intervals),
            "effectiveFps": round(effective_fps, 2),
            "frameP95Ms": round(frame_p95, 3),
            "frameMaxMs": round(frame_max, 3),
            "slowFrameCount": len(slow_frames),
            "slowFrameRatio": round(slow_ratio, 5),
            "pointerMoves": perf["pointerMoves"],
            "distinctPositions": distinct_positions,
            "displacementPx": round(displacement, 2),
            "pageLongTaskCount": len(page_long_tasks),
            "pageMaxLongTaskMs": round(max(page_long_tasks, default=0), 3),
            "cdpLongTaskCount": len(cdp_long_tasks),
            "cdpMaxLongTaskMs": round(max(cdp_long_tasks, default=0), 3),
            "traceEventCount": len(trace_events),
            "thresholds": thresholds,
            "checks": checks,
            "diagnostics": {key: len(value) for key, value in diagnostics.items()},
            "trace": {
                "path": str(trace_path.resolve()),
                "sha256": hashlib.sha256(compressed_trace).hexdigest(),
                "byteLength": len(compressed_trace),
                "encoding": "gzip",
            },
        }
    finally:
        if trace_started and cdp is not None:
            try:
                finish_cdp_trace(cdp, page)
            except Exception:
                pass
        context.close()


parser = argparse.ArgumentParser()
parser.add_argument("--suite", choices=("canvas", "prod", "perf352"), default="canvas")
parser.add_argument("--artifacts-dir", default="output/acceptance")
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
                "handoffChoice": verify_handoff_choice(browser),
            }
        elif args.suite == "perf352":
            output = {
                "ok": True,
                "suite": "perf352",
                "performance": verify_performance_352(browser, Path(args.artifacts_dir)),
            }
            report_path = Path(args.artifacts_dir) / f"canvas-352-performance-{RUN_ID}.report.json"
            output["reportPath"] = str(report_path.resolve())
            report_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
        else:
            output = {"ok": True, "suite": "canvas", "sizes": [verify_size(browser, size) for size in (300, 800)]}
    finally:
        browser.close()

print(json.dumps(output, ensure_ascii=False))
