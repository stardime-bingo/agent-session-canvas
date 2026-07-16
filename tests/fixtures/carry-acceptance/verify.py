import hashlib
import json
import math
import os
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:4518"
RUN_ID = f"{os.getpid()}-{time.time_ns()}"
CHROME = os.environ.get(
    "LE011_CHROME",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
SCENARIOS = [
    "normal",
    "response-unknown",
    "export-retry",
    "no-anchor",
    "authority-conflict-800",
    "escape",
    "pointercancel",
]
BATCH_SCENARIOS = [
    "batch-normal",
    "batch-export-retry",
    "batch-response-unknown",
]
BOARD = '[data-id="board:b1"]'
DISTRICT = '[data-id="district:batch-project"]'
MAIN = '.ink-world [data-ink-element-id="shape-0"]'
OUTSIDE = '.ink-world [data-ink-element-id="shape-outside"]'
MINI = '.mini-ink [data-ink-element-id="shape-0"]'


INITIAL_GEOMETRY = """
() => {
  const rect = selector => {
    const value = document.querySelector(selector).getBoundingClientRect();
    return { left: value.left, top: value.top, width: value.width, height: value.height };
  };
  const mini = document.querySelector(%s);
  const svg = mini.ownerSVGElement;
  const svgRect = svg.getBoundingClientRect();
  return {
    board: rect(%s),
    main: rect(%s),
    outside: rect(%s),
    mini: rect(%s),
    miniScaleX: svgRect.width / svg.viewBox.baseVal.width,
    miniScaleY: svgRect.height / svg.viewBox.baseVal.height,
  };
}
""" % tuple(json.dumps(value) for value in [MINI, BOARD, MAIN, OUTSIDE, MINI])


PERF_INIT = """
(() => {
  const state = { moveDurations: [], longTasks: [] };
  let observer = null;
  window.addEventListener('pointermove', () => {
    const started = performance.now();
    queueMicrotask(() => state.moveDurations.push(performance.now() - started));
  }, true);
  try {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
    });
    observer.observe({ type: 'longtask', buffered: true });
  } catch {}
  window.__carryBrowserPerf = {
    reset() {
      observer?.takeRecords();
      state.moveDurations.length = 0;
      state.longTasks.length = 0;
    },
    snapshot() {
      return {
        moveDurations: [...state.moveDurations],
        longTasks: [...state.longTasks, ...(observer?.takeRecords() || []).map(entry => entry.duration)],
      };
    },
  };
})();
"""


START_GEOMETRY_SAMPLER = """
({ initial }) => {
  const rect = selector => {
    const value = document.querySelector(selector).getBoundingClientRect();
    return { left: value.left, top: value.top, width: value.width, height: value.height };
  };
  const samples = [];
  let active = true;
  let stopped;
  const done = new Promise(resolve => { stopped = resolve; });
  const sample = () => requestAnimationFrame(() => setTimeout(() => {
    if (!active) {
      stopped(samples);
      return;
    }
    const board = rect(%s);
    const main = rect(%s);
    const outside = rect(%s);
    const mini = rect(%s);
    const production = window.__carryAcceptance.snapshot();
    const zoom = production.viewport.zoom;
    const screenDx = board.left - initial.board.left;
    const screenDy = board.top - initial.board.top;
    const relativeError = Math.hypot(
      (main.left - board.left) - (initial.main.left - initial.board.left),
      (main.top - board.top) - (initial.main.top - initial.board.top),
    );
    samples.push({
      relativeError,
      mainMove: Math.hypot(main.left - initial.main.left, main.top - initial.main.top),
      outsideMove: Math.hypot(outside.left - initial.outside.left, outside.top - initial.outside.top),
      miniError: Math.hypot(
        mini.left - initial.mini.left - (screenDx / zoom) * initial.miniScaleX,
        mini.top - initial.mini.top - (screenDy / zoom) * initial.miniScaleY,
      ),
      miniMove: Math.hypot(mini.left - initial.mini.left, mini.top - initial.mini.top),
      boardDx: screenDx,
      boardDy: screenDy,
      carryDx: production.carryDelta.dx * zoom,
      carryDy: production.carryDelta.dy * zoom,
    });
    sample();
  }, 0));
  sample();
  window.__carryLiveSampler = {
    stop() {
      active = false;
      return done;
    },
  };
}
""" % tuple(json.dumps(value) for value in [BOARD, MAIN, OUTSIDE, MINI])


BATCH_GEOMETRY = """
() => {
  const rect = selector => {
    const value = document.querySelector(selector).getBoundingClientRect();
    return { left: value.left, top: value.top, width: value.width, height: value.height };
  };
  return {
    board: rect(%s),
    district: rect(%s),
    main: rect(%s),
    outside: rect(%s),
  };
}
""" % tuple(json.dumps(value) for value in [BOARD, DISTRICT, MAIN, OUTSIDE])


START_BATCH_SAMPLER = """
({ initial }) => {
  const rect = selector => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const value = node.getBoundingClientRect();
    return { left: value.left, top: value.top, width: value.width, height: value.height };
  };
  const samples = [];
  let active = true;
  let stopped;
  const done = new Promise(resolve => { stopped = resolve; });
  const sample = () => requestAnimationFrame(() => {
    if (!active) {
      stopped(samples);
      return;
    }
    const board = rect(%s);
    const district = rect(%s);
    const main = rect(%s);
    const outside = rect(%s);
    const production = window.__carryAcceptance.snapshot();
    if (board && district && main && outside) {
      samples.push({
        boardRelativeError: Math.hypot(
          (main.left - board.left) - (initial.main.left - initial.board.left),
          (main.top - board.top) - (initial.main.top - initial.board.top),
        ),
        districtRelativeError: Math.hypot(
          (outside.left - district.left) - (initial.outside.left - initial.district.left),
          (outside.top - district.top) - (initial.outside.top - initial.district.top),
        ),
        bridgeCount: production.bridgeCount,
        requestedGenerationId: production.requestedGenerationId,
        renderedGenerationId: production.renderedGenerationId,
        targetFrameId: production.carryTargetFrame?.targetFrameId || null,
      });
    }
    sample();
  });
  sample();
  window.__batchPaintSampler = {
    stop() {
      active = false;
      return done;
    },
  };
}
""" % tuple(json.dumps(value) for value in [BOARD, DISTRICT, MAIN, OUTSIDE])


def geometry(page):
    return page.evaluate(INITIAL_GEOMETRY)


def batch_geometry(page):
    return page.evaluate(BATCH_GEOMETRY)


def distance(left, right):
    return math.hypot(left["left"] - right["left"], left["top"] - right["top"])


def percentile(values, ratio):
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * ratio) - 1)]


def events(data, name):
    return [entry for entry in data["carryEvents"] if entry["event"] == name]


def assert_frame_identity(data, expect_target, commit_event="COMMIT_OK"):
    commits = events(data, commit_event)
    ready = events(data, "TARGET_FRAME_READY")
    if expect_target:
        assert len(commits) == len(ready) == 1, "target frame lifecycle is not exactly once"
        assert commits[0]["frameId"] == ready[0]["frameId"], "target frame identity drift"
        assert commits[0]["seq"] < ready[0]["seq"], "target frame cleared before DOM-ready"
    else:
        assert not ready, "unexpected target frame"


def assert_drawing_blocked(page, phase):
    page.wait_for_function(
        f"""() => {{
          const value = window.__carryAcceptance.snapshot();
          return value.carryPhase === '{phase}'
            && value.carryTargetFrame?.generationCurrent
            && value.carryTargetFrame?.excludedIdsCurrent;
        }}"""
    )
    before = page.evaluate("window.__carryAcceptance.snapshot()")
    assert before["carryTargetFrame"]["requestedRevision"] == before["requestedRevision"]
    assert page.evaluate("window.__carryAcceptance.openDrawing()") is False
    assert page.evaluate("window.__carryAcceptance.attemptDrawingCommit()") is False
    after = page.evaluate("window.__carryAcceptance.snapshot()")
    assert after["carryPhase"] == phase
    assert after["opening"] is False and after["penActive"] is False
    assert after["drawingCommitCount"] == 0
    assert after["carryTargetFrame"] == before["carryTargetFrame"]


def assert_batch_plan(plan):
    moves = {move["containerId"]: move for move in plan["moves"]}
    assert set(moves) == {"board:b1", "district:batch-project"}
    assert moves["board:b1"]["anchorIds"] == ["shape-0"]
    assert moves["district:batch-project"]["anchorIds"] == ["shape-outside"]
    assert len({
        anchor
        for move in moves.values()
        for anchor in move["anchorIds"]
    }) == 2


def assert_batch_transition(before, after, plan):
    deltas = {}
    for move in plan["moves"]:
        dx = move["to"]["x"] - move["from"]["x"]
        dy = move["to"]["y"] - move["from"]["y"]
        for anchor in move["anchorIds"]:
            deltas[anchor] = (dx, dy)
    before_drawing = {element["id"]: element for element in before["drawing"]}
    after_drawing = {element["id"]: element for element in after["drawing"]}
    assert set(before_drawing) == set(after_drawing)
    for element_id, previous in before_drawing.items():
        dx, dy = deltas.get(element_id, (0, 0))
        current = after_drawing[element_id]
        assert current["x"] == previous["x"] + dx
        assert current["y"] == previous["y"] + dy
    assert after["token"] != before["token"]


def verify_scenario(browser, name):
    context = browser.new_context(viewport={"width": 1200, "height": 760})
    context.add_init_script(script=PERF_INIT)
    context.tracing.start(screenshots=True, snapshots=True, sources=True)
    page = context.new_page()
    errors = []
    api_requests = []
    page.on("console", lambda msg: errors.append(f"console:{msg.type}:{msg.text}") if msg.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(f"page:{error}"))
    page.on("requestfailed", lambda request: errors.append(f"request:{request.url}"))
    page.on("request", lambda request: api_requests.append(request.url) if "/api" in request.url else None)
    trace = Path("/tmp") / f"le011r-production-carry-{RUN_ID}-{name}.zip"
    trace.unlink(missing_ok=True)
    try:
        response = page.goto(f"{BASE}/?scenario={name}", wait_until="networkidle")
        assert response and response.ok, f"{name}: page boot failed"
        page.locator("[data-app-ready=true]").wait_for(timeout=90000)
        assert page.evaluate("window.__carryAcceptance.productionIntegration") is True
        assert page.locator("script:not([src])").count() == 0, f"{name}: inline script"
        assert page.locator("head style").count() == 0, f"{name}: inline head style"
        page.locator(BOARD).wait_for()
        page.locator(MAIN).wait_for()
        page.locator(OUTSIDE).wait_for()
        page.locator(MINI).wait_for()

        initial = geometry(page)
        before = page.evaluate("window.__carryAcceptance.snapshot()")
        assert before["productionIntegration"] is True
        assert before["carryPhase"] == "IDLE"
        initial_export_count = len(before["exportCalls"])

        grip = page.locator(f"{BOARD} .container-drag-handle > span:first-child")
        box = grip.bounding_box()
        assert box, f"{name}: production drag handle has no bounding box"
        start_x = box["x"] + box["width"] / 2
        start_y = box["y"] + box["height"] / 2
        page.mouse.move(start_x, start_y)
        page.evaluate("window.__carryBrowserPerf.reset()")
        page.mouse.down()
        page.evaluate(START_GEOMETRY_SAMPLER, {"initial": initial})
        for step in range(1, 73):
            page.mouse.move(
                start_x + 90 * step / 72,
                start_y + 60 * step / 72,
            )
            page.wait_for_timeout(18)
        samples = page.evaluate("window.__carryLiveSampler.stop()")
        page.wait_for_function("() => window.__carryAcceptance.snapshot().carryPhase === 'DRAGGING'")
        held = page.evaluate("window.__carryAcceptance.snapshot()")
        perf = page.evaluate("window.__carryBrowserPerf.snapshot()")
        move_durations = held["carryMoveDurations"]
        move_p95 = percentile(move_durations, 0.95)
        max_relative_error = max(sample["relativeError"] for sample in samples)
        max_mini_error = max(sample["miniError"] for sample in samples)
        max_unrelated_move = max(sample["outsideMove"] for sample in samples)
        worst_relative = max(samples, key=lambda sample: sample["relativeError"])
        distinct_positions = len({
            (round(sample["boardDx"], 2), round(sample["boardDy"], 2))
            for sample in samples
        })
        assert len(samples) >= 60, f"{name}: insufficient real rAF samples"
        assert distinct_positions >= 60, f"{name}: samples did not span incremental MOVE"
        assert len(move_durations) >= 60, f"{name}: production MOVE handler samples missing"
        assert len(held["exportCalls"]) == initial_export_count, f"{name}: exporter ran while pointer held"
        assert len(events(held, "BEGIN")) == 1 and len(events(held, "MOVE")) == 1
        assert max_unrelated_move <= 0.1, f"{name}: unrelated ink moved {max_unrelated_move}"
        if name == "no-anchor":
            assert max(sample["mainMove"] for sample in samples) <= 0.1, "no-anchor main ink moved"
            assert max(sample["miniMove"] for sample in samples) <= 0.1, "no-anchor minimap ink moved"
        else:
            assert max_relative_error <= 0.5, f"{name}: main bridge phase error {worst_relative}"
            assert max_mini_error <= 0.5, f"{name}: minimap bridge phase error {max_mini_error}"

        if name == "escape":
            page.keyboard.press("Escape")
            page.wait_for_function("() => window.__carryAcceptance.snapshot().carryPhase === 'IDLE'")
            page.mouse.up()
        elif name == "pointercancel":
            cancelled_pointer = page.evaluate(
                "() => {"
                "  const pointerId = window.__carryAcceptance.snapshot().carryPointerId;"
                "  window.dispatchEvent(new PointerEvent('pointercancel', "
                "    { pointerId, bubbles: true, cancelable: true }));"
                "  return pointerId;"
                "}"
            )
            assert cancelled_pointer is not None, "production drag did not retain pointer identity"
            page.wait_for_function("() => window.__carryAcceptance.snapshot().carryPhase === 'IDLE'")
            page.mouse.up()
        else:
            page.mouse.up()

        if name == "normal":
            assert_drawing_blocked(page, "AWAITING_FRAME")

        if name == "export-retry":
            page.wait_for_function(
                "() => window.__carryAcceptance.snapshot().carryPhase === 'RETRYABLE_PAINT'",
                timeout=30000,
            )
            assert page.locator(".ink-carry-anchor").count() > 0, "retry bridge cleared before target frame"
            retry_data = page.evaluate("window.__carryAcceptance.snapshot()")
            retry_calls = retry_data["exportCalls"][initial_export_count:]
            assert [call["attempt"] for call in retry_calls] == [1, 2, 3]
            assert retry_data["injectedExportFailures"] == 3
            assert_drawing_blocked(page, "RETRYABLE_PAINT")
            page.locator(".ink-carry-retry").click()

        target_phase = "CONFLICT_STALE" if name == "authority-conflict-800" else "IDLE"
        page.wait_for_function(
            f"() => window.__carryAcceptance.snapshot().carryPhase === '{target_phase}'",
            timeout=30000,
        )
        page.wait_for_timeout(100)
        final = page.evaluate("window.__carryAcceptance.snapshot()")
        assert final["drawingCommitCount"] == 0
        final_geometry = geometry(page)
        target_calls = final["exportCalls"][initial_export_count:]

        if name in ("escape", "pointercancel"):
            assert final["commitCount"] == final["authorityWrites"] == 0
            assert len(events(final, "CANCEL")) == 1
            assert not events(final, "DROP") and not events(final, "COMMIT_OK")
            assert target_calls == []
            assert distance(final_geometry["board"], initial["board"]) <= 1.5
        else:
            assert final["commitCount"] == 1 and len(set(final["opIds"])) == 1
            assert final["baseTokens"] == ["scene-1"]
            assert len(events(final, "DROP")) == 1

        if name == "normal":
            assert final["authorityWrites"] == final["authorityInstalls"] == 1
            assert final["statusQueryCount"] == 0 and final["sceneToken"] == "scene-2"
            assert_frame_identity(final, True)
            assert [call["attempt"] for call in target_calls] == [1]
        elif name == "response-unknown":
            assert final["authorityWrites"] == final["authorityInstalls"] == 1
            assert final["statusQueryCount"] == 1 and final["sceneToken"] == "scene-2"
            unknown = events(final, "RESPONSE_UNKNOWN")
            committed = events(final, "STATUS_COMMITTED")
            assert len(unknown) == len(committed) == 1
            assert not events(final, "COMMIT_OK")
            assert unknown[0]["seq"] < committed[0]["seq"]
            assert_frame_identity(final, True, "STATUS_COMMITTED")
            assert [call["attempt"] for call in target_calls] == [1]
        elif name == "export-retry":
            assert final["authorityWrites"] == final["authorityInstalls"] == 1
            assert final["statusQueryCount"] == 0
            assert_frame_identity(final, True)
            assert [call["attempt"] for call in target_calls] == [1, 2, 3, 1]
            assert len(events(final, "FINAL_FRAME_ERROR")) == 1
            assert len(events(final, "RETRY")) == 1
        elif name == "no-anchor":
            assert final["authorityWrites"] == final["authorityInstalls"] == 1
            assert final["statusQueryCount"] == 0
            assert_frame_identity(final, False)
            assert target_calls == []
        elif name == "authority-conflict-800":
            assert final["carryBeginDuration"] < 50, f"800-element BEGIN took {final['carryBeginDuration']}ms"
            assert move_p95 < 4, f"800-element MOVE p95 took {move_p95}ms"
            assert not perf["longTasks"], f"800-element drag emitted Long Tasks: {perf['longTasks']}"
            assert final["authorityWrites"] == 0 and final["sceneToken"] == "scene-1"
            assert final["authorityInstalls"] == final["statusQueryCount"] == 0
            assert final["sceneStale"] is True
            assert len(events(final, "CONFLICT")) == 1
            assert_frame_identity(final, False)
            assert target_calls == []
            assert distance(final_geometry["board"], initial["board"]) <= 1.5

        if name not in ("authority-conflict-800", "escape", "pointercancel"):
            assert distance(final_geometry["board"], initial["board"]) >= 40
        assert page.locator(".ink-carry-anchor").count() == 0
        assert not errors, f"{name}: browser errors: {errors}"
        assert not api_requests, f"{name}: API access: {api_requests}"
        context.tracing.stop(path=str(trace))
        context.close()
        trace_bytes = trace.read_bytes()
        return {
            "scenario": name,
            "productionIntegration": True,
            "browserVersion": browser.version,
            "samples": len(samples),
            "distinctMoveSamples": distinct_positions,
            "phaseErrorApplicable": name != "no-anchor",
            "maxRelativeError": None if name == "no-anchor" else max_relative_error,
            "maxMiniError": None if name == "no-anchor" else max_mini_error,
            "maxMainMove": max(sample["mainMove"] for sample in samples),
            "maxMiniMove": max(sample["miniMove"] for sample in samples),
            "maxUnrelatedMove": max_unrelated_move,
            "moveHandlerCount": len(move_durations),
            "moveHandlerP95": move_p95,
            "capturedPointerMoveP95": percentile(perf["moveDurations"], 0.95),
            "longTaskCount": len(perf["longTasks"]),
            "maxLongTask": max(perf["longTasks"], default=0),
            "beginMs": final["carryBeginDuration"],
            "exportDuringDrag": len(held["exportCalls"]) - initial_export_count,
            "phase": final["carryPhase"],
            "events": [entry["event"] for entry in final["carryEvents"]],
            "targetExports": len(target_calls),
            "trace": {
                "path": str(trace),
                "sha256": hashlib.sha256(trace_bytes).hexdigest(),
                "byteLength": len(trace_bytes),
            },
        }
    except Exception:
        context.tracing.stop(path=str(trace))
        context.close()
        raise


def verify_batch_scenario(browser, name):
    context = browser.new_context(viewport={"width": 1200, "height": 760})
    context.tracing.start(screenshots=True, snapshots=True, sources=True)
    page = context.new_page()
    errors = []
    api_requests = []
    page.on("console", lambda msg: errors.append(f"console:{msg.type}:{msg.text}") if msg.type == "error" else None)
    page.on("pageerror", lambda error: errors.append(f"page:{error}"))
    page.on("requestfailed", lambda request: errors.append(f"request:{request.url}"))
    page.on("request", lambda request: api_requests.append(request.url) if "/api" in request.url else None)
    trace = Path("/tmp") / f"le011b-production-batch-{RUN_ID}-{name}.zip"
    trace.unlink(missing_ok=True)
    try:
        response = page.goto(f"{BASE}/?scenario={name}", wait_until="networkidle")
        assert response and response.ok, f"{name}: page boot failed"
        page.locator("[data-app-ready=true]").wait_for(timeout=90000)
        for selector in [BOARD, DISTRICT, MAIN, OUTSIDE, ".batch-arrange", ".batch-undo"]:
            page.locator(selector).wait_for()
        before = page.evaluate("window.__carryAcceptance.snapshot()")
        assert before["productionIntegration"] is True
        assert before["batchAction"] == "idle"
        assert before["bridgeCount"] == before["batchBridgeCount"] == 0
        assert len(before["reactSnapshots"]) == 1
        initial = batch_geometry(page)
        page.evaluate(START_BATCH_SAMPLER, {"initial": initial})

        page.locator(".batch-arrange").click()
        page.wait_for_function(
            """() => {
              const value = window.__carryAcceptance.snapshot();
              const target = value.carryTargetFrame;
              return value.authorityWrites === 1
                && target?.kind === 'batch'
                && target.generationCurrent
                && target.excludedIdsCurrent
                && value.requestedGenerationId === target.targetFrameId
                && value.bridgeCount === 4
                && value.batchBridgeCount === 4;
            }""",
            timeout=30000,
        )
        arrange_pending = page.evaluate("window.__carryAcceptance.snapshot()")
        arrange_frame = arrange_pending["carryTargetFrame"]["targetFrameId"]
        assert arrange_pending["renderedGenerationId"] != arrange_frame
        assert len(arrange_pending["reactSnapshots"]) == 2
        assert len(arrange_pending["batchPlans"]) == 1
        assert_batch_plan(arrange_pending["batchPlans"][0])
        assert_batch_transition(
            arrange_pending["reactSnapshots"][0],
            arrange_pending["reactSnapshots"][1],
            arrange_pending["batchPlans"][0],
        )
        page.wait_for_timeout(100)
        still_pending = page.evaluate("window.__carryAcceptance.snapshot()")
        assert still_pending["carryTargetFrame"]["targetFrameId"] == arrange_frame
        assert still_pending["bridgeCount"] == still_pending["batchBridgeCount"] == 4

        if name == "batch-export-retry":
            page.wait_for_function(
                """() => {
                  const value = window.__carryAcceptance.snapshot();
                  return value.batchAction === 'arrange:retryable-paint'
                    && value.batchCarryRetryable
                    && value.carryTargetFrame?.failed
                    && value.bridgeCount === 4;
                }""",
                timeout=30000,
            )
            retry = page.evaluate("window.__carryAcceptance.snapshot()")
            assert retry["injectedExportFailures"] == 3
            assert retry["renderedGenerationId"] != arrange_frame
            page.locator(".ink-carry-retry").click()

        page.wait_for_function(
            f"""() => {{
              const value = window.__carryAcceptance.snapshot();
              return value.carryTargetFrame === null
                && value.bridgeCount === 0
                && value.batchBridgeCount === 0
                && value.callbackEvents.some(event =>
                  event.type === 'ready' && event.generationId === {arrange_frame});
            }}""",
            timeout=30000,
        )
        arranged = page.evaluate("window.__carryAcceptance.snapshot()")
        expected_arrange_status = "retryable-paint" if name == "batch-export-retry" else "ready"
        assert arranged["batchOutcomes"] == [{
            "kind": "arrange",
            "opId": "batch-1",
            "status": expected_arrange_status,
        }]
        arranged_geometry = batch_geometry(page)
        assert distance(arranged_geometry["board"], initial["board"]) >= 40
        assert distance(arranged_geometry["district"], initial["district"]) >= 40

        page.locator(".batch-undo").click()
        page.wait_for_function(
            """() => {
              const value = window.__carryAcceptance.snapshot();
              const target = value.carryTargetFrame;
              return value.authorityWrites === 2
                && target?.kind === 'batch'
                && target.generationCurrent
                && target.excludedIdsCurrent
                && value.requestedGenerationId === target.targetFrameId
                && value.bridgeCount === 4
                && value.batchBridgeCount === 4;
            }""",
            timeout=30000,
        )
        undo_pending = page.evaluate("window.__carryAcceptance.snapshot()")
        undo_frame = undo_pending["carryTargetFrame"]["targetFrameId"]
        assert undo_frame != arrange_frame
        assert undo_pending["renderedGenerationId"] != undo_frame
        assert any(
            event["type"] == "ready" and event.get("generationId") == arrange_frame
            for event in undo_pending["callbackEvents"]
        )
        assert len(undo_pending["reactSnapshots"]) == 3
        assert len(undo_pending["batchPlans"]) == 2
        assert_batch_plan(undo_pending["batchPlans"][1])
        assert_batch_transition(
            undo_pending["reactSnapshots"][1],
            undo_pending["reactSnapshots"][2],
            undo_pending["batchPlans"][1],
        )
        page.wait_for_timeout(100)
        undo_still_pending = page.evaluate("window.__carryAcceptance.snapshot()")
        assert undo_still_pending["carryTargetFrame"]["targetFrameId"] == undo_frame
        assert undo_still_pending["bridgeCount"] == 4
        page.wait_for_function(
            f"""() => {{
              const value = window.__carryAcceptance.snapshot();
              return value.batchAction === 'undo:ready'
                && value.carryTargetFrame === null
                && value.bridgeCount === 0
                && value.batchBridgeCount === 0
                && value.callbackEvents.some(event =>
                  event.type === 'ready' && event.generationId === {undo_frame});
            }}""",
            timeout=30000,
        )
        samples = page.evaluate("window.__batchPaintSampler.stop()")
        assert len(samples) >= 20
        max_board_error = max(sample["boardRelativeError"] for sample in samples)
        max_district_error = max(sample["districtRelativeError"] for sample in samples)
        assert max_board_error <= 0.5, f"{name}: board/drawing intermediate state {max_board_error}"
        assert max_district_error <= 0.5, f"{name}: district/drawing intermediate state {max_district_error}"

        final = page.evaluate("window.__carryAcceptance.snapshot()")
        final_geometry = batch_geometry(page)
        assert len(final["reactSnapshots"]) == 3
        assert [snapshot["token"] for snapshot in final["reactSnapshots"]] == [
            "scene-1", "scene-2", "scene-3",
        ]
        assert final["reactSnapshots"][0]["drawing"] == final["reactSnapshots"][2]["drawing"]
        assert final["reactSnapshots"][0]["districtLayout"] == final["reactSnapshots"][2]["districtLayout"]
        assert final["commitCount"] == final["authorityWrites"] == final["authorityInstalls"] == 2
        assert final["opIds"] == ["batch-1", "batch-2"]
        assert final["baseTokens"] == ["scene-1", "scene-2"]
        assert final["sceneToken"] == "scene-3"
        assert final["sceneStale"] is False
        assert final["batchOutcomes"][-1] == {
            "kind": "undo",
            "opId": "batch-2",
            "status": "ready",
        }
        if name == "batch-response-unknown":
            assert final["responseLosses"] == final["statusQueryCount"] == 1
        else:
            assert final["responseLosses"] == final["statusQueryCount"] == 0
        if name == "batch-export-retry":
            assert final["injectedExportFailures"] == 3
        else:
            assert final["injectedExportFailures"] == 0
        assert distance(final_geometry["board"], initial["board"]) <= 1.5
        assert distance(final_geometry["district"], initial["district"]) <= 1.5
        assert distance(final_geometry["main"], initial["main"]) <= 1.5
        assert distance(final_geometry["outside"], initial["outside"]) <= 1.5
        assert not errors, f"{name}: browser errors: {errors}"
        assert not api_requests, f"{name}: API access: {api_requests}"
        context.tracing.stop(path=str(trace))
        context.close()
        trace_bytes = trace.read_bytes()
        return {
            "scenario": name,
            "productionIntegration": True,
            "arrangeGeneration": arrange_frame,
            "undoGeneration": undo_frame,
            "samples": len(samples),
            "maxBoardRelativeError": max_board_error,
            "maxDistrictRelativeError": max_district_error,
            "statusQueries": final["statusQueryCount"],
            "exportFailures": final["injectedExportFailures"],
            "trace": {
                "path": str(trace),
                "sha256": hashlib.sha256(trace_bytes).hexdigest(),
                "byteLength": len(trace_bytes),
            },
        }
    except Exception:
        context.tracing.stop(path=str(trace))
        context.close()
        raise


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
    try:
        browser_version = browser.version
        results = [verify_scenario(browser, name) for name in SCENARIOS]
        batch_results = [verify_batch_scenario(browser, name) for name in BATCH_SCENARIOS]
    finally:
        browser.close()

print(json.dumps({
    "ok": True,
    "productionIntegration": True,
    "runId": RUN_ID,
    "browserVersion": browser_version,
    "scenarios": results,
    "batchScenarios": batch_results,
}, ensure_ascii=False))
