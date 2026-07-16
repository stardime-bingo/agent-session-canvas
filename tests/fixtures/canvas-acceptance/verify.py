import json
import os
import re
import time
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:4518"
CHROME = os.environ.get(
    "LE013_CHROME",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
TERMINAL = ("pass", "fail", "error")
FORBIDDEN_RESOURCE_ROOTS = ("/api", "/data", "/@fs", "/.git")
WORKER_ENTRY = re.compile(r"/assets/[^/]*subset-worker\.chunk-[A-Za-z0-9_-]+\.js$")


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


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
    try:
        sizes = [verify_size(browser, size) for size in (300, 800)]
    finally:
        browser.close()

print(json.dumps({"ok": True, "sizes": sizes}, ensure_ascii=False))
