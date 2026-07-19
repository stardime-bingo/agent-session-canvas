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
UPDATE_BUDGET_MS = {
    300: {"samples": 20, "warmP95": 50, "warmMax": 100, "longTaskMax": 50},
    800: {"samples": 20, "warmP95": 100, "warmMax": 125, "longTaskMax": 100},
}
PERFORMANCE_352 = {
    "nodeCount": 352,
    "expectedTargets": {
        "district": 1, "workspace": 12, "note": 1, "board": 3,
        "edge": 22, "ink": 6, "activeDots": 171,
    },
    "minFrameSamples": 90,
    "minPointerMoves": 100,
    "minDistinctPositions": 80,
    "minDisplacementPx": 150,
    "frameP95MaxMs": 20,
    "frameMaxMs": 50,
    "slowFrameRatioMax": 0.05,
    "longTaskMaxCount": 0,
    "idleDurationMs": 1500,
    "idlePaintMaxCount": 0,
    "idlePrePaintMaxCount": 0,
    "idleUpdateLayoutTreeMaxCount": 0,
    "idleContinuousAnimationsMaxCount": 0,
}
PERFORMANCE_DISTRICT_ID = "district:/fixture"
PERFORMANCE_WORKSPACE_ID = "/fixture/perf-352/workspace-01"
PERFORMANCE_NOTE_ID = "note:perf-352"
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

    # 信任级真实输入：合成 dispatchEvent 不会执行默认焦点动作，无法替代真鼠标验文字编辑器。
    shortcut_keys = page.locator(".tool-island .tool-key").all_text_contents()
    assert shortcut_keys == ["N", "B", "V", "P", "R", "O", "A", "T", "E", "F"], shortcut_keys
    canvas_box = page.locator(".canvas-root").bounding_box()
    assert canvas_box, canvas_box
    page.keyboard.press("t")
    page.mouse.click(canvas_box["x"] + canvas_box["width"] * 0.72, canvas_box["y"] + canvas_box["height"] * 0.78)
    editor = page.locator(".ink-text-editor")
    editor.wait_for(state="visible", timeout=10_000)
    assert editor.evaluate("node => document.activeElement === node")
    editor.fill("真实鼠标文字可见")
    page.get_by_title("选择绘图（V）：框选/Shift 多选/拖动/缩放/旋转/Cmd+C/V/Alt 拖").click()
    rendered_text = page.locator(".ink-world text", has_text="真实鼠标文字可见").last
    rendered_box = rendered_text.bounding_box()
    assert rendered_box and rendered_box["width"] > 40 and rendered_box["height"] > 10, rendered_box
    checks["trustedPointerTextInput"] = True
    checks["visibleShortcutLabels"] = True
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


def verify_layout_quality(browser):
    context = browser.new_context(viewport={"width": 1440, "height": 960})
    page = context.new_page()
    diagnostics = diagnostics_for(context, page)
    response = page.goto(f"{BASE}/?mode=layout-quality", wait_until="networkidle", timeout=90_000)
    assert response is not None and response.status == 200
    page.wait_for_function("() => window.__LAYOUT_ACCEPTANCE__?.ready === true", timeout=90_000)
    before = page.evaluate("() => window.__LAYOUT_ACCEPTANCE__.snapshot()")
    arrange = page.get_by_role("button", name="智能整理", exact=True)
    assert arrange.count() == 1 and arrange.is_enabled()
    arrange.click()
    page.wait_for_function(
        "() => ['complete', 'fail'].includes(window.__LAYOUT_ACCEPTANCE__?.status)",
        timeout=90_000,
    )
    result = page.evaluate("() => window.__LAYOUT_ACCEPTANCE__")
    report = result["report"]
    assert result["status"] == "complete" and report["pass"] is True, json.dumps(result, ensure_ascii=False)
    assert report["domComplete"] is True, report
    assert report["collisions"] == [], report
    assert report["rowsAligned"] is True, report
    assert report["membershipsPreserved"] is True, report
    assert report["districtGeometryPersisted"] is True, report
    assert report["boardMoved"] is True and report["boardCompacted"] is True, report
    assert report["domBoardMoved"] is True and report["domBoardCompacted"] is True, report
    assert report["noteUnchanged"] is True and report["domNoteUnchanged"] is True, report
    assert report["inkCarried"] is True and report["domInkCarried"] is True, report
    assert 2 <= report["laneCount"] <= 4, report
    assert 0.9 <= report["bounds"]["aspect"] <= 2.2, report
    assert report["performance"]["syncMs"] <= 50, report
    assert report["performance"]["firstPaintMs"] <= 100, report
    assert report["performance"]["longTaskSupported"] is True, report
    assert not [value for value in report["performance"]["longTasks"] if value >= 50], report
    assert page.get_by_role("button", name="智能整理", exact=True).count() == 1
    undo = page.get_by_role("button", name="撤销", exact=True)
    assert undo.count() == 1 and undo.is_enabled()
    undo.click()
    page.wait_for_function(
        "before => JSON.stringify(window.__LAYOUT_ACCEPTANCE__.snapshot().layout) === JSON.stringify(before.layout)",
        arg=before,
        timeout=10_000,
    )
    undone = page.evaluate("() => window.__LAYOUT_ACCEPTANCE__.snapshot()")
    assert undone["boards"] == before["boards"], undone
    assert undone["notes"] == before["notes"], undone
    assert undone["drawing"] == before["drawing"], undone
    arrange.click()
    page.wait_for_function(
        "() => ['complete', 'fail'].includes(window.__LAYOUT_ACCEPTANCE__?.status)",
        timeout=90_000,
    )
    assert page.evaluate("() => window.__LAYOUT_ACCEPTANCE__.status") == "complete"
    assert page.evaluate("() => window.__LAYOUT_ACCEPTANCE__.growArrangedDistrict()") is True
    page.wait_for_function(
        "() => ['complete', 'fail'].includes(window.__LAYOUT_ACCEPTANCE__?.growthStatus)",
        timeout=10_000,
    )
    growth = page.evaluate("() => window.__LAYOUT_ACCEPTANCE__.growthReport")
    assert growth["pass"] is True, growth
    assert growth["targetGrew"] is True and growth["followerMoved"] is True, growth
    assert growth["followerInkCarried"] is True, growth
    assert growth["collisions"] == [], growth
    resize_before = page.evaluate(
        "growth => window.__LAYOUT_ACCEPTANCE__.geometry(growth.followerId, growth.followerInkId)",
        growth,
    )
    follower = page.locator(f'.react-flow__node[data-id="{growth["followerId"]}"]')
    resize_handle = follower.locator(".react-flow__resize-control.handle.bottom.right")
    assert resize_handle.count() == 1
    handle_box = resize_handle.bounding_box()
    assert handle_box is not None
    page.mouse.move(handle_box["x"] + handle_box["width"] / 2, handle_box["y"] + handle_box["height"] / 2)
    page.mouse.down()
    page.mouse.move(handle_box["x"] + handle_box["width"] / 2 + 48,
                    handle_box["y"] + handle_box["height"] / 2 + 36, steps=8)
    page.mouse.up()
    page.wait_for_function(
        """growth => {
          const doc = window.__LAYOUT_ACCEPTANCE__.snapshot();
          const geometry = window.__LAYOUT_ACCEPTANCE__.geometry(growth.followerId, growth.followerInkId);
          const saved = doc.layout[growth.followerId];
          return saved && geometry.container
            && Math.abs(saved.x - geometry.container.x) <= 2
            && Math.abs(saved.y - geometry.container.y) <= 2;
        }""",
        arg=growth,
        timeout=10_000,
    )
    resize_after = page.evaluate(
        "growth => window.__LAYOUT_ACCEPTANCE__.geometry(growth.followerId, growth.followerInkId)",
        growth,
    )
    assert abs(resize_after["ink"]["x"] - resize_before["ink"]["x"]) <= 4, (resize_before, resize_after)
    assert abs(resize_after["ink"]["y"] - resize_before["ink"]["y"]) <= 4, (resize_before, resize_after)
    growth["resizeProjectionCommitted"] = True
    growth["resizeInkStable"] = True
    assert_clean(diagnostics)
    context.close()
    return {
        "status": "pass",
        "laneCount": report["laneCount"],
        "bounds": report["bounds"],
        "containerCount": report["containerCount"],
        "rowsAligned": True,
        "membershipsPreserved": True,
        "districtGeometryPersisted": True,
        "boardMoved": True,
        "boardCompacted": True,
        "domVerified": True,
        "growth": growth,
        "noteUnchanged": True,
        "inkCarried": True,
        "undoRestored": True,
        "performance": report["performance"],
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
    update_budget = UPDATE_BUDGET_MS[size]
    assert detail["samples"] == update_budget["samples"], detail
    assert detail["warmP95Ms"] <= update_budget["warmP95"], detail
    assert detail["warmMaxMs"] <= update_budget["warmMax"], detail
    assert detail["maxLongTaskMs"] <= update_budget["longTaskMax"], detail
    assert detail["longTaskSupported"] is True, detail
    assert detail["earlyTextUpdated"] is True, detail
    assert_clean(diagnostics)
    context.close()
    return {
        "size": size,
        "status": "pass",
        "domCount": detail["domCount"],
        "mountMs": detail["mountMs"],
        "budgetMs": detail["budgetMs"],
        "samples": detail["samples"],
        "warmP95Ms": detail["warmP95Ms"],
        "warmMaxMs": detail["warmMaxMs"],
        "maxLongTaskMs": detail["maxLongTaskMs"],
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
        assert detail["targets"] == PERFORMANCE_352["expectedTargets"], detail

        target_specs = [
            {
                "name": "district container",
                "node": f'.react-flow__node-district[data-id="{PERFORMANCE_DISTRICT_ID}"]',
                "handle": f'.react-flow__node-district[data-id="{PERFORMANCE_DISTRICT_ID}"] .container-drag-handle',
                "xFraction": 0.65,
                "yFraction": 0.5,
            },
            {
                "name": "workspace",
                "node": f'.react-flow__node-workspace[data-id="{PERFORMANCE_WORKSPACE_ID}"]',
                "handle": f'.react-flow__node-workspace[data-id="{PERFORMANCE_WORKSPACE_ID}"]',
                "xFraction": 0.5,
                "yPx": 20,
            },
            {
                "name": "note",
                "node": f'.react-flow__node-note[data-id="{PERFORMANCE_NOTE_ID}"]',
                "handle": f'.react-flow__node-note[data-id="{PERFORMANCE_NOTE_ID}"]',
                "xFraction": 0.65,
                "yFraction": 0.18,
            },
        ]

        cdp = context.new_cdp_session(page)
        page.wait_for_timeout(500)
        continuous_animations = page.evaluate("""() => document.getAnimations()
          .filter(animation => animation.playState === 'running')
          .map(animation => animation.animationName || 'unnamed')""")
        cdp.send("Tracing.start", {
            "categories": "devtools.timeline,toplevel",
            "options": "sampling-frequency=10000",
            "transferMode": "ReturnAsStream",
        })
        trace_started = True
        page.wait_for_timeout(PERFORMANCE_352["idleDurationMs"])
        idle_trace_bytes = finish_cdp_trace(cdp, page)
        trace_started = False
        idle_trace_events = json.loads(idle_trace_bytes).get("traceEvents", [])
        idle_event_counts = {
            name: sum(1 for event in idle_trace_events if event.get("name") == name)
            for name in ("UpdateLayoutTree", "PrePaint", "Paint")
        }
        idle_checks = {
            "continuousAnimations": len(continuous_animations)
            <= PERFORMANCE_352["idleContinuousAnimationsMaxCount"],
            "updateLayoutTree": idle_event_counts["UpdateLayoutTree"]
            <= PERFORMANCE_352["idleUpdateLayoutTreeMaxCount"],
            "prePaint": idle_event_counts["PrePaint"] <= PERFORMANCE_352["idlePrePaintMaxCount"],
            "paint": idle_event_counts["Paint"] <= PERFORMANCE_352["idlePaintMaxCount"],
        }
        assert all(idle_checks.values()), json.dumps({
            "idleChecks": idle_checks,
            "idleEventCounts": idle_event_counts,
            "continuousAnimations": continuous_animations,
        }, ensure_ascii=False)

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
        target_metrics = []
        thresholds = PERFORMANCE_352
        for spec in target_specs:
            handle = page.locator(spec["handle"])
            node = page.locator(spec["node"])
            assert handle.count() == 1 and node.count() == 1, f"{spec['name']} drag target must be unique"
            target_box = handle.bounding_box()
            before = node.bounding_box()
            assert target_box and before, f"{spec['name']} drag geometry unavailable"
            start_x = target_box["x"] + target_box["width"] * spec["xFraction"]
            start_y = target_box["y"] + spec.get("yPx", target_box["height"] * spec.get("yFraction", 0.5))
            drag_x, drag_y = 180, 100
            page.mouse.move(start_x, start_y)
            page.evaluate("selector => window.__FLOW_PERF_352__.start(selector)", spec["node"])
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
            after = node.bounding_box()
            assert after, f"{spec['name']} performance drag final geometry unavailable"

            frame_intervals = perf["frameIntervals"]
            frame_p95 = percentile(frame_intervals, 0.95)
            frame_max = max(frame_intervals, default=0)
            slow_frames = [value for value in frame_intervals if value > thresholds["frameP95MaxMs"]]
            slow_ratio = len(slow_frames) / len(frame_intervals) if frame_intervals else 1
            effective_fps = 1000 / (sum(frame_intervals) / len(frame_intervals)) if frame_intervals else 0
            distinct_positions = len({
                (round(position["x"], 1), round(position["y"], 1))
                for position in perf["positions"]
            })
            displacement = math.hypot(after["x"] - before["x"], after["y"] - before["y"])
            page_long_tasks = [duration for duration in perf["longTasks"] if duration >= 50]
            checks = {
                "frameSamples": len(frame_intervals) >= thresholds["minFrameSamples"],
                "pointerMoves": perf["pointerMoves"] >= thresholds["minPointerMoves"],
                "distinctPositions": distinct_positions >= thresholds["minDistinctPositions"],
                "displacement": displacement >= thresholds["minDisplacementPx"],
                "frameP95": frame_p95 <= thresholds["frameP95MaxMs"],
                "frameMax": frame_max <= thresholds["frameMaxMs"],
                "slowFrameRatio": slow_ratio <= thresholds["slowFrameRatioMax"],
                "longTaskSupport": perf["longTaskSupported"] is True,
                "pageLongTasks": len(page_long_tasks) <= thresholds["longTaskMaxCount"],
            }
            assert all(checks.values()), json.dumps({
                "target": spec["name"],
                "checks": checks,
                "frameP95Ms": frame_p95,
                "frameMaxMs": frame_max,
                "slowFrameRatio": slow_ratio,
                "pageLongTasks": page_long_tasks,
            }, ensure_ascii=False)
            target_metrics.append({
                "target": spec["name"],
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
                "checks": checks,
            })

        trace_bytes = finish_cdp_trace(cdp, page)
        trace_started = False

        trace = json.loads(trace_bytes)
        trace_events = trace.get("traceEvents", [])
        cdp_long_tasks = [
            event.get("dur", 0) / 1000
            for event in trace_events
            if event.get("name") == "RunTask"
            and event.get("ph") == "X"
            and event.get("dur", 0) >= 50_000
        ]

        checks = {
            "nodeCount": detail["nodeCount"] == thresholds["nodeCount"],
            "allTargets": len(target_metrics) == 3 and all(all(metric["checks"].values()) for metric in target_metrics),
            "cdpLongTasks": len(cdp_long_tasks) <= thresholds["longTaskMaxCount"],
        }
        assert all(checks.values()), json.dumps({"checks": checks, "cdpLongTasks": cdp_long_tasks}, ensure_ascii=False)
        assert_clean(diagnostics)

        artifacts_dir.mkdir(parents=True, exist_ok=True)
        idle_trace_path = artifacts_dir / f"canvas-352-idle-{RUN_ID}.trace.json.gz"
        compressed_idle_trace = gzip.compress(idle_trace_bytes, compresslevel=9)
        idle_trace_path.write_bytes(compressed_idle_trace)
        trace_path = artifacts_dir / f"canvas-352-performance-{RUN_ID}.trace.json.gz"
        compressed_trace = gzip.compress(trace_bytes, compresslevel=9)
        trace_path.write_bytes(compressed_trace)
        return {
            "status": "pass",
            "browserVersion": browser.version,
            "nodeCount": detail["nodeCount"],
            "topology": detail["targets"],
            "idle": {
                "durationMs": PERFORMANCE_352["idleDurationMs"],
                "continuousAnimations": continuous_animations,
                "eventCounts": idle_event_counts,
                "checks": idle_checks,
                "trace": {
                    "path": str(idle_trace_path.resolve()),
                    "sha256": hashlib.sha256(compressed_idle_trace).hexdigest(),
                    "byteLength": len(compressed_idle_trace),
                    "encoding": "gzip",
                },
            },
            "targets": target_metrics,
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
                "layoutQuality": verify_layout_quality(browser),
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
