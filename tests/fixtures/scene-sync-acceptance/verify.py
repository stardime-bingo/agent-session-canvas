import hashlib
import json
import os
import selectors
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import Request, urlopen

from playwright.sync_api import sync_playwright


REPO = Path(__file__).resolve().parents[3]
SERVER = REPO / "scripts/serve-scene-sync-acceptance.mjs"
CHROME = os.environ.get(
    "AGENT_CANVAS_CHROME",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
RUN_ID = f"{time.strftime('%Y%m%dT%H%M%S')}-{os.getpid()}"


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def start_server(data_dir, port):
    env = os.environ.copy()
    env["AGENT_CANVAS_SYNC_DATA_DIR"] = str(data_dir)
    env["AGENT_CANVAS_SYNC_PORT"] = str(port)
    process = subprocess.Popen(
        ["node", str(SERVER)],
        cwd=REPO,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + 45
    transcript = []
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(f"sync daemon exited: {''.join(transcript)}")
            events = selector.select(timeout=0.25)
            if not events:
                continue
            line = process.stdout.readline()
            transcript.append(line)
            try:
                ready = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ready.get("ready"):
                assert ready["port"] == port
                assert Path(ready["dataDir"]).resolve() == Path(data_dir).resolve()
                return process, ready, transcript
        raise AssertionError(f"sync daemon start timed out: {''.join(transcript)}")
    finally:
        selector.close()


def stop_server(process):
    if process.poll() is not None:
        return process.returncode
    process.terminate()
    try:
        return process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        return process.wait(timeout=3)


def read_graph(base):
    with urlopen(f"{base}/api/graph", timeout=2) as response:
        assert response.status == 200
        return json.load(response)


def read_health(base):
    with urlopen(f"{base}/health", timeout=2) as response:
        assert response.status == 200
        return json.load(response)


def post_json(base, path, body):
    request = Request(
        f"{base}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=3) as response:
        assert response.status == 200
        return json.load(response)


def wait_until(read, predicate, label, timeout=15):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = read()
            if predicate(last):
                return last
        except Exception as error:
            last = str(error)
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {label}: {last}")


def page_snapshot(page):
    return page.evaluate("() => window.__SYNC_ACCEPTANCE__.snapshot()")


def wait_page(page, predicate, label, timeout=15):
    return wait_until(lambda: page_snapshot(page), predicate, label, timeout)


def note_text(graph):
    notes = graph.get("canvas", {}).get("notes", [])
    note = next((item for item in notes if item.get("id") == "sync-acceptance-note"), None)
    return note.get("text", "") if note else ""


def diagnostics(context, page, base):
    result = {
        "consoleErrors": [],
        "consoleWarnings": [],
        "pageErrors": [],
        "requestFailed": [],
        "externalResources": [],
        "dialogs": [],
    }

    def console(message):
        if message.type == "error":
            result["consoleErrors"].append(message.text)
        elif message.type == "warning":
            result["consoleWarnings"].append(message.text)

    def request(request):
        if not request.url.startswith(base) and not request.url.startswith(("data:", "blob:")):
            result["externalResources"].append(request.url)

    def dialog(value):
        result["dialogs"].append({"type": value.type, "message": value.message})
        value.dismiss()

    page.on("console", console)
    page.on("pageerror", lambda error: result["pageErrors"].append(str(error)))
    page.on("requestfailed", lambda request: result["requestFailed"].append({
        "url": request.url,
        "failure": str(request.failure or "request failed"),
    }))
    page.on("request", request)
    page.on("dialog", dialog)
    return result


def open_fixture(browser, base):
    context = browser.new_context(viewport={"width": 1100, "height": 760})
    page = context.new_page()
    diag = diagnostics(context, page, base)
    response = page.goto(base, wait_until="load", timeout=90_000)
    assert response is not None and response.status == 200
    page.wait_for_function("() => window.__SYNC_ACCEPTANCE__?.ready === true", timeout=90_000)
    page.locator('[data-testid="sync-note"]').wait_for(state="visible")
    return context, page, diag


def assert_clean(diag):
    for key in ("consoleErrors", "consoleWarnings", "pageErrors", "requestFailed", "externalResources", "dialogs"):
        assert not diag[key], f"{key}: {json.dumps(diag[key], ensure_ascii=False)}"


def run(browser, base, data_dir, port, server_process):
    contexts = []
    restarts = [{"pid": server_process.pid, "phase": "initial"}]
    try:
        context_a, page_a, diag_a = open_fixture(browser, base)
        context_b, page_b, diag_b = open_fixture(browser, base)
        contexts.extend([context_a, context_b])
        writer_a = page_snapshot(page_a)["writerId"]
        writer_b = page_snapshot(page_b)["writerId"]
        assert writer_a != writer_b

        # 干净标签静默采纳远端；没有刷新提示、对话框或诊断噪音。
        page_a.locator('[data-testid="sync-note"]').fill("tab-a-clean")
        page_a.evaluate("() => window.__SYNC_ACCEPTANCE__.flushNow()")
        adopted_clean = wait_page(
            page_b,
            lambda value: value["text"] == "tab-a-clean" and value["adoptions"][-1]["accepted"] is True,
            "clean tab remote adoption",
        )
        assert adopted_clean["sync"] == "saved"
        assert page_b.locator("text=请刷新").count() == 0
        assert_clean(diag_a)
        assert_clean(diag_b)

        # B 先脏、A 后写；B 必须记录拒绝采纳，且本地文字不被静默覆盖。随后 B 自己成为 LWW。
        prior_adoptions = len(adopted_clean["adoptions"])
        page_b.locator('[data-testid="sync-note"]').fill("tab-b-dirty")
        page_a.locator('[data-testid="sync-note"]').fill("tab-a-remote")
        page_a.evaluate("() => window.__SYNC_ACCEPTANCE__.flushNow()")
        dirty_guard = wait_page(
            page_b,
            lambda value: len(value["adoptions"]) > prior_adoptions,
            "dirty tab rejects remote",
        )["adoptions"][-1]
        assert dirty_guard["accepted"] is False, dirty_guard
        assert dirty_guard["localText"] == "tab-b-dirty", dirty_guard
        converged_a = wait_page(
            page_a,
            lambda value: value["text"] == "tab-b-dirty" and value["sync"] == "saved",
            "tab A converges to dirty tab LWW",
        )
        converged_b = wait_page(
            page_b,
            lambda value: value["text"] == "tab-b-dirty" and value["sync"] == "saved",
            "tab B saved",
        )
        assert converged_a["text"] == converged_b["text"]
        assert_clean(diag_a)
        assert_clean(diag_b)

        # daemon 真停：防抖请求失败后状态进入 error；第二次输入仍同步写本地文档。
        page_a.locator('[data-testid="sync-note"]').fill("offline-before-stop")
        assert page_snapshot(page_a)["sync"] == "dirty"
        stopped_code = stop_server(server_process)
        offline = wait_page(
            page_a,
            lambda value: value["sync"] == "error" and value["live"] is False,
            "offline error status",
            timeout=8,
        )
        page_a.locator('[data-testid="sync-note"]').fill("offline-continued")
        offline_after_input = page_snapshot(page_a)
        assert offline_after_input["text"] == "offline-continued"
        assert offline_after_input["sync"] == "error"
        assert page_a.locator(".sync-state.error").count() == 1

        # 同一临时 data dir 重启；SceneStore 无限退避自动追平，不要求刷新。
        restarted, ready, _ = start_server(data_dir, port)
        server_process = restarted
        restarts.append({"pid": restarted.pid, "phase": "resumed"})
        recovered = wait_page(
            page_a,
            lambda value: value["sync"] == "saved" and value["live"] is True,
            "automatic retry after daemon restart",
            timeout=15,
        )
        persisted_offline = wait_until(
            lambda: read_graph(base),
            lambda graph: note_text(graph) == "offline-continued",
            "offline final edit persisted",
        )
        assert recovered["text"] == "offline-continued"

        # pagehide：在 300ms debounce 前立即关页；150ms 服务端延迟要求 keepalive 真正续送。
        context_c, page_c, diag_c = open_fixture(browser, base)
        contexts.append(context_c)
        page_c.locator('[data-testid="sync-note"]').fill("pagehide-final")
        page_c.close()
        persisted_pagehide = wait_until(
            lambda: read_graph(base),
            lambda graph: note_text(graph) == "pagehide-final",
            "pagehide keepalive persistence",
            timeout=8,
        )
        assert_clean(diag_c)
        context_d, page_d, diag_d = open_fixture(browser, base)
        contexts.append(context_d)
        reopened = page_snapshot(page_d)
        assert reopened["text"] == "pagehide-final"
        assert page_d.locator('[data-testid="sync-note"]').input_value() == "pagehide-final"
        assert_clean(diag_d)

        # 普通 flush 已在飞，随后再输入最终内容并关页；最新 keepalive 必须胜过旧请求。
        idle_health = wait_until(
            lambda: read_health(base),
            lambda health: health["pendingSceneWrites"] == 0,
            "scene writes idle before in-flight pagehide",
        )
        page_d.locator('[data-testid="sync-note"]').fill("pagehide-inflight-first")
        in_flight = wait_until(
            lambda: read_health(base),
            lambda health: health["startedSceneWrites"] > idle_health["startedSceneWrites"]
            and health["pendingSceneWrites"] >= 1,
            "ordinary flush enters server before pagehide",
        )
        page_d.locator('[data-testid="sync-note"]').fill("pagehide-inflight-final")
        page_d.close()
        persisted_inflight = wait_until(
            lambda: read_graph(base),
            lambda graph: note_text(graph) == "pagehide-inflight-final",
            "in-flight pagehide final edit persistence",
            timeout=8,
        )
        context_e, page_e, diag_e = open_fixture(browser, base)
        contexts.append(context_e)
        reopened_inflight = page_snapshot(page_e)
        assert reopened_inflight["text"] == "pagehide-inflight-final"
        assert page_e.locator('[data-testid="sync-note"]').input_value() == "pagehide-inflight-final"
        assert_clean(diag_e)

        # Chrome keepalive 总量约 64KB：70KB 最终编辑必须由同源恢复快照接住，重开后普通冲刷再追平服务端。
        large_text = "pagehide-large-final:" + ("大载荷" * 24000)
        assert len(large_text.encode("utf-8")) > 70_000
        page_e.locator('[data-testid="sync-note"]').fill(large_text)
        page_e.close()
        page_f = context_e.new_page()
        diag_f = diagnostics(context_e, page_f, base)
        response_f = page_f.goto(base, wait_until="load", timeout=90_000)
        assert response_f is not None and response_f.status == 200
        page_f.wait_for_function("() => window.__SYNC_ACCEPTANCE__?.ready === true", timeout=90_000)
        reopened_large = page_snapshot(page_f)
        assert reopened_large["recovery"]["applied"] is True, reopened_large
        assert reopened_large["text"] == large_text
        assert page_f.locator('[data-testid="sync-note"]').input_value() == large_text
        persisted_large = wait_until(
            lambda: read_graph(base),
            lambda graph: note_text(graph) == large_text,
            "large pagehide local recovery persisted",
            timeout=15,
        )
        saved_large = wait_page(page_f, lambda value: value["sync"] == "saved", "large recovery saved")
        assert saved_large["text"] == large_text
        assert_clean(diag_f)

        # 已追平的 clean 页再关闭时不应制造恢复记录；否则漏过 SSE 的旧 clean 快照会在下次打开倒灌。
        page_f.close()
        page_g = context_e.new_page()
        diag_g = diagnostics(context_e, page_g, base)
        response_g = page_g.goto(base, wait_until="load", timeout=90_000)
        assert response_g is not None and response_g.status == 200
        page_g.wait_for_function("() => window.__SYNC_ACCEPTANCE__?.ready === true", timeout=90_000)
        clean_reopen = page_snapshot(page_g)
        assert clean_reopen["recovery"]["applied"] is False, clean_reopen
        assert clean_reopen["text"] == large_text
        assert_clean(diag_g)

        # 深交错反例：A 的图片场景先成功（本地 IDB 已清），A 再变 dirty；B 随后以空图成为 LWW。
        # 普通 scene 写必须保守保留内容寻址正文，否则 A 拒绝远端覆盖后会永久缺图。
        context_h, page_h, diag_h = open_fixture(browser, base)
        contexts.append(context_h)
        image_writer = page_snapshot(page_h)["writerId"]
        files_before = read_health(base)["startedFileWrites"]
        page_h.evaluate("() => window.__SYNC_ACCEPTANCE__.addImage()")
        page_h.evaluate("() => window.__SYNC_ACCEPTANCE__.flushNow()")
        first_image_saved = wait_page(
            page_h,
            lambda value: value["sync"] == "saved" and value["imagePresent"] is True,
            "first image scene saved",
        )
        first_image_graph = wait_until(
            lambda: read_graph(base),
            lambda graph: len(graph.get("canvas", {}).get("drawing", [])) == 1
            and "sync-acceptance-image-file" in graph.get("canvas", {}).get("drawingFiles", {}),
            "first image scene and asset persisted",
        )
        assert read_health(base)["startedFileWrites"] > files_before
        first_recovery_asset_cleared = not page_h.evaluate(
            "() => window.__SYNC_ACCEPTANCE__.recoveryFilePresent()"
        )
        assert first_recovery_asset_cleared is True

        # A 后续本地编辑必须保持 dirty/error，确保它拒绝 B 的空图 SSE，而不是先静默采纳。
        post_json(base, "/__acceptance/reject-scenes", {"writerId": image_writer, "count": 100})
        page_h.locator('[data-testid="sync-note"]').fill("image-local-dirty")

        context_i, page_i, diag_i = open_fixture(browser, base)
        contexts.append(context_i)
        assert page_snapshot(page_i)["imagePresent"] is True
        page_i.evaluate("() => window.__SYNC_ACCEPTANCE__.removeImage()")
        page_i.locator('[data-testid="sync-note"]').fill("image-race-empty-lww")
        page_i.evaluate("() => window.__SYNC_ACCEPTANCE__.flushNow()")

        retained = wait_until(
            lambda: read_graph(base),
            lambda graph: note_text(graph) == "image-race-empty-lww"
            and not graph.get("canvas", {}).get("drawing", [])
            and "sync-acceptance-image-file" in graph.get("canvas", {}).get("drawingFiles", {}),
            "other writer empty scene retains content-addressed image body",
        )
        dirty_image = wait_page(
            page_h,
            lambda value: value["sync"] == "error" and value["imagePresent"] is True
            and value["adoptions"] and value["adoptions"][-1]["accepted"] is False,
            "dirty image tab rejects empty remote scene",
        )
        stopped_image_code = stop_server(server_process)
        page_h.close()

        restarted_image, ready_image, _ = start_server(data_dir, port)
        server_process = restarted_image
        restarts.append({"pid": restarted_image.pid, "phase": "image-recovery"})
        page_j = context_h.new_page()
        diag_j = diagnostics(context_h, page_j, base)
        response_j = page_j.goto(base, wait_until="load", timeout=90_000)
        assert response_j is not None and response_j.status == 200
        page_j.wait_for_function("() => window.__SYNC_ACCEPTANCE__?.ready === true", timeout=90_000)
        reopened_image = page_snapshot(page_j)
        assert reopened_image["recovery"]["applied"] is True, reopened_image
        assert reopened_image["imagePresent"] is True, reopened_image
        persisted_image = wait_until(
            lambda: read_graph(base),
            lambda graph: len(graph.get("canvas", {}).get("drawing", [])) == 1
            and "sync-acceptance-image-file" in graph.get("canvas", {}).get("drawingFiles", {}),
            "IndexedDB image body restored and persisted",
        )
        saved_image = wait_page(page_j, lambda value: value["sync"] == "saved", "restored image saved")
        assert saved_image["imagePresent"] is True
        assert page_j.evaluate("() => window.__SYNC_ACCEPTANCE__.recoveryFilePresent()") is False
        assert not diag_h["consoleWarnings"] and not diag_h["pageErrors"]
        assert not diag_h["externalResources"] and not diag_h["dialogs"]
        assert all(item["url"].startswith(base) for item in diag_h["requestFailed"])
        assert_clean(diag_i)
        assert_clean(diag_j)

        # 离线阶段只允许同源网络失败；页面错误、外联与刷新对话框始终为零。
        offline_failures = diag_a["requestFailed"] + diag_b["requestFailed"]
        assert offline_failures, "daemon stop should produce observable same-origin request failures"
        assert all(item["url"].startswith(base) for item in offline_failures)
        assert not diag_a["pageErrors"] and not diag_b["pageErrors"]
        assert not diag_a["externalResources"] and not diag_b["externalResources"]
        assert not diag_a["dialogs"] and not diag_b["dialogs"]

        files = {}
        for file in sorted(Path(data_dir).glob("*.json")):
            raw = file.read_bytes()
            files[file.name] = {"byteLength": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        return {
            "status": "pass",
            "browserVersion": browser.version,
            "port": port,
            "isolatedDataDir": str(Path(data_dir).resolve()),
            "serverRestarts": restarts,
            "initialStopExitCode": stopped_code,
            "writersDistinct": True,
            "cleanRemoteAdoption": adopted_clean["adoptions"][-1],
            "dirtyRemoteGuard": dirty_guard,
            "lwwConvergedText": converged_a["text"],
            "offline": {
                "error": offline,
                "continuedInput": offline_after_input,
                "recovered": recovered,
                "persistedText": note_text(persisted_offline),
                "sameOriginRequestFailures": len(offline_failures),
            },
            "pagehide": {
                "persistedText": note_text(persisted_pagehide),
                "reopenedText": reopened["text"],
                "inFlight": {
                    "pendingWritesObserved": in_flight["pendingSceneWrites"],
                    "persistedText": note_text(persisted_inflight),
                    "reopenedText": reopened_inflight["text"],
                },
                "largePayload": {
                    "utf8Bytes": len(large_text.encode("utf-8")),
                    "localRecoveryApplied": reopened_large["recovery"]["applied"],
                    "persistedTextBytes": len(note_text(persisted_large).encode("utf-8")),
                    "cleanReopenRecoveryApplied": clean_reopen["recovery"]["applied"],
                },
                "serverWriteDelayMs": ready["writeDelayMs"],
                "imageRecovery": {
                    "firstSceneSaved": first_image_saved["sync"] == "saved",
                    "firstServerDrawingCount": len(first_image_graph["canvas"]["drawing"]),
                    "localRecoveryAssetClearedAfterFirstScene": first_recovery_asset_cleared,
                    "dirtyRemoteAdoptionAccepted": dirty_image["adoptions"][-1]["accepted"],
                    "assetRetainedAfterOtherWriterEmptyScene": (
                        "sync-acceptance-image-file" in retained["canvas"]["drawingFiles"]
                    ),
                    "serverStoppedExitCode": stopped_image_code,
                    "recoveryApplied": reopened_image["recovery"]["applied"],
                    "imagePresentAfterReopen": saved_image["imagePresent"],
                    "serverDrawingCount": len(persisted_image["canvas"]["drawing"]),
                    "serverFileIds": sorted(persisted_image["canvas"]["drawingFiles"].keys()),
                    "expectedInjectedFailureConsoleErrors": len(diag_h["consoleErrors"]),
                    "restartWriteDelayMs": ready_image["writeDelayMs"],
                },
            },
            "diagnostics": {
                "preOfflineClean": True,
                "pageErrors": len(diag_a["pageErrors"]) + len(diag_b["pageErrors"]) + len(diag_e["pageErrors"]) + len(diag_f["pageErrors"]) + len(diag_g["pageErrors"]) + len(diag_j["pageErrors"]),
                "externalResources": len(diag_a["externalResources"]) + len(diag_b["externalResources"]) + len(diag_e["externalResources"]) + len(diag_f["externalResources"]) + len(diag_g["externalResources"]) + len(diag_j["externalResources"]),
                "dialogs": len(diag_a["dialogs"]) + len(diag_b["dialogs"]) + len(diag_e["dialogs"]) + len(diag_f["dialogs"]) + len(diag_g["dialogs"]) + len(diag_j["dialogs"]),
                "freshReopenConsoleErrors": len(diag_j["consoleErrors"]),
                "freshReopenConsoleWarnings": len(diag_j["consoleWarnings"]),
            },
            "isolatedFiles": files,
        }, server_process
    except Exception:
        stop_server(server_process)
        raise
    finally:
        for context in contexts:
            try:
                context.close()
            except Exception:
                pass


def main():
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    temporary = tempfile.TemporaryDirectory(prefix="agent-scene-sync-acceptance-")
    data_dir = Path(temporary.name)
    server_process = None
    try:
        server_process, _, _ = start_server(data_dir, port)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
            try:
                result, server_process = run(browser, base, data_dir, port, server_process)
            finally:
                browser.close()
        output = {"ok": True, "suite": "scene-sync", "result": result}
    finally:
        if server_process is not None:
            stop_server(server_process)
        temporary.cleanup()
    output["result"]["isolatedDataDirRemoved"] = not data_dir.exists()
    artifacts = REPO / "output/acceptance"
    artifacts.mkdir(parents=True, exist_ok=True)
    report_path = artifacts / f"scene-sync-{RUN_ID}.report.json"
    output["reportPath"] = str(report_path.resolve())
    report_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
