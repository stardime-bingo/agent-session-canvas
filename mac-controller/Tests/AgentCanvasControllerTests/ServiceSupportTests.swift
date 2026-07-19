// [INPUT]: 临时 plist、临时控制脚本与隔离 UserDefaults
// [OUTPUT]: 控制器无 UI 内核的确定性回归
// [POS]: 不接触正式 launchd、4517 或真实 data
// [PROTOCOL]: 变更时更新此头部，然后检查 ServiceSupport.swift

import Foundation
import AppKit
import XCTest
@testable import AgentCanvasController

final class ServiceSupportTests: XCTestCase {
    func testStatusDecoding() throws {
        let payload = #"{"registered":true,"running":true,"pid":42,"apiHealthy":true,"port":4517,"appHome":"/tmp/canvas"}"#
        let status = try ServiceStatus.decode(Data(payload.utf8))

        XCTAssertTrue(status.isHealthy)
        XCTAssertEqual(status.pid, 42)
        XCTAssertEqual(status.appHome, "/tmp/canvas")
    }

    func testDisplayPreferencesDefaultVisibleAndPersist() throws {
        let suite = "AgentCanvasControllerTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = DisplayPreferences(defaults: defaults)

        XCTAssertTrue(preferences.showDock)
        XCTAssertTrue(preferences.showMenuBar)
        preferences.showDock = false
        preferences.showMenuBar = false

        let reloaded = DisplayPreferences(defaults: defaults)
        XCTAssertFalse(reloaded.showDock)
        XCTAssertFalse(reloaded.showMenuBar)
    }

    func testAppHomeLocatorPrefersEnvironmentThenLaunchAgent() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-controller-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let explicit = root.appendingPathComponent("explicit")

        XCTAssertEqual(
            AppHomeLocator.locate(environment: ["AGENT_CANVAS_HOME": explicit.path], homeDirectory: root),
            explicit.standardizedFileURL
        )

        let checkout = root.appendingPathComponent("checkout")
        let plistURL = root.appendingPathComponent("agent.plist")
        let plist: [String: Any] = [
            "ProgramArguments": ["/usr/bin/node", checkout.appendingPathComponent("server/index.mjs").path],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: plistURL)

        XCTAssertEqual(
            AppHomeLocator.locate(environment: [:], homeDirectory: root, launchAgentURL: plistURL).path,
            checkout.standardizedFileURL.path
        )
    }

    func testServiceClientPassesAppHomeAndParsesStatus() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-controller-client-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let scriptURL = root.appendingPathComponent("agent-canvas")
        let script = #"""
        #!/bin/zsh
        printf '{"registered":true,"running":true,"pid":7,"apiHealthy":true,"port":4517,"appHome":"%s"}\n' "$AGENT_CANVAS_HOME"
        """#
        try script.write(to: scriptURL, atomically: true, encoding: .utf8)

        let client = ServiceClient(controllerURL: scriptURL, appHome: root)
        let output = try client.runSync("status")
        let status = try ServiceStatus.decode(Data(output.stdout.utf8))

        XCTAssertEqual(output.exitCode, 0)
        XCTAssertTrue(status.isHealthy)
        XCTAssertEqual(status.appHome, root.path)
    }

    @MainActor
    func testDockMenuExposesEnabledRecoveryAndServiceActions() {
        let delegate = AppDelegate()
        let menu = delegate.applicationDockMenu(NSApplication.shared)
        let titledItems = (menu?.items ?? []).filter { !$0.title.isEmpty }
        let items = Dictionary(uniqueKeysWithValues: titledItems.map { ($0.title, $0) })

        XCTAssertEqual(items["启动并打开"]?.isEnabled, true)
        XCTAssertEqual(items["控制器显示设置…"]?.isEnabled, true)
        XCTAssertEqual(items["在 Dock 中显示"]?.isEnabled, true)
        XCTAssertEqual(items["在菜单栏显示图标"]?.isEnabled, true)
        XCTAssertEqual(items["运行诊断…"]?.isEnabled, true)
    }
}
