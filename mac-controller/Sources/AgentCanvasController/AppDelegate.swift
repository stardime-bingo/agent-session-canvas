// [INPUT]: ServiceClient 状态/动作与 DisplayPreferences 显示偏好
// [OUTPUT]: Dock + 菜单栏原生控制入口、双隐藏恢复面板与诊断反馈
// [POS]: macOS 控制器 UI；服务和数据仍由现有 launchd/Node 应用唯一负责
// [PROTOCOL]: 变更时更新此头部，然后检查 mac-controller/Tests

import AppKit
import OSLog

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let logger = Logger(subsystem: "com.bingo.agent-canvas.controller", category: "controller")
    private let preferences = DisplayPreferences()
    private let client: ServiceClient
    private let suppressAutomaticOpen: Bool
    private let forceShowControls: Bool

    private var statusItem: NSStatusItem?
    private var status = ServiceStatus.unknown
    private var statusKnown = false
    private var isRefreshing = false
    private var busyLabel: String?
    private var refreshTimer: Timer?
    private var didFinishLaunching = false
    private var suppressActivationUntil = Date.distantPast
    private var modalDepth = 0
    private var isMenuTracking = false

    override init() {
        let arguments = Set(CommandLine.arguments.dropFirst())
        suppressAutomaticOpen = arguments.contains("--no-open")
        forceShowControls = arguments.contains("--show-controls")

        let appHome = AppHomeLocator.locate()
        let bundledController = Bundle.main.resourceURL?.appendingPathComponent("agent-canvas")
        let repositoryController = appHome
            .appendingPathComponent("plugins/agent-session-canvas/scripts/agent-canvas")
        let controller = bundledController.flatMap {
            FileManager.default.fileExists(atPath: $0.path) ? $0 : nil
        } ?? repositoryController
        client = ServiceClient(controllerURL: controller, appHome: appHome)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        logger.notice("launch forceControls=\(self.forceShowControls) suppressOpen=\(self.suppressAutomaticOpen) dock=\(self.preferences.showDock) menuBar=\(self.preferences.showMenuBar)")
        suppressActivationUntil = Date().addingTimeInterval(0.75)
        applyPresence()
        rebuildMainMenu()
        refreshStatus()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshStatus() }
        }
        didFinishLaunching = true

        guard !suppressAutomaticOpen else { return }
        if !preferences.showDock && !preferences.showMenuBar {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.presentSettingsPanel() }
        } else if forceShowControls {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.presentSettingsPanel() }
        } else {
            openBoard(nil)
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard didFinishLaunching else { return }
        guard Date() >= suppressActivationUntil else { return }
        guard modalDepth == 0, busyLabel == nil else { return }
        openBoard(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        refreshTimer?.invalidate()
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        if !preferences.showDock && !preferences.showMenuBar {
            presentSettingsPanel()
        } else {
            openBoard(nil)
        }
        return true
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        makeControlMenu(includeQuit: false)
    }

    func menuWillOpen(_ menu: NSMenu) {
        isMenuTracking = true
        refreshStatus()
    }

    func menuDidClose(_ menu: NSMenu) {
        isMenuTracking = false
        DispatchQueue.main.async { [weak self] in
            self?.updateStatusItem()
            self?.rebuildMainMenu()
        }
    }

    private func applyPresence() {
        NSApp.setActivationPolicy(preferences.showDock ? .regular : .accessory)
        if preferences.showMenuBar {
            if statusItem == nil {
                let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
                item.button?.toolTip = "会话指挥塔"
                statusItem = item
            }
            updateStatusItem()
        } else if let statusItem {
            NSStatusBar.system.removeStatusItem(statusItem)
            self.statusItem = nil
        }
        rebuildMainMenu()
    }

    private func updateStatusItem() {
        guard let button = statusItem?.button else { return }
        let symbol: String
        if busyLabel != nil || !statusKnown {
            symbol = "square.grid.2x2"
        } else if status.isHealthy {
            symbol = "square.grid.2x2.fill"
        } else if status.running {
            symbol = "exclamationmark.triangle.fill"
        } else {
            symbol = "square.grid.2x2"
        }
        button.image = makeStatusImage(symbol: symbol)
        button.contentTintColor = nil
        button.toolTip = "会话指挥塔 · \(statusSummary)"
        if !isMenuTracking {
            statusItem?.menu = makeControlMenu(includeQuit: true)
        }
    }

    private func makeStatusImage(symbol: String) -> NSImage? {
        guard let source = NSImage(systemSymbolName: symbol, accessibilityDescription: statusSummary) else {
            return nil
        }
        let image = NSImage(size: source.size, flipped: false) { bounds in
            source.draw(in: bounds)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current?.compositingOperation = .sourceIn
            NSColor.white.setFill()
            bounds.fill()
            NSGraphicsContext.restoreGraphicsState()
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = statusSummary
        return image
    }

    private var statusSummary: String {
        if let busyLabel { return busyLabel }
        guard statusKnown else { return "正在检查…" }
        if status.isHealthy { return "运行正常 · \(status.port)" }
        if status.running { return "服务启动中 · API 未就绪" }
        return "服务已停止"
    }

    private func makeControlMenu(includeQuit: Bool) -> NSMenu {
        let menu = NSMenu(title: "会话指挥塔")
        menu.delegate = self

        let statusLine = NSMenuItem(title: statusSummary, action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())

        if status.isHealthy {
            menu.addItem(actionItem("打开看板", action: #selector(openBoard), key: "o"))
            menu.addItem(actionItem("重新启动", action: #selector(restartService)))
            menu.addItem(actionItem("停止服务", action: #selector(stopService)))
        } else {
            menu.addItem(actionItem("启动并打开", action: #selector(openBoard), key: "o"))
            if status.running {
                menu.addItem(actionItem("重新启动", action: #selector(restartService)))
                menu.addItem(actionItem("停止服务", action: #selector(stopService)))
            }
        }

        menu.addItem(.separator())
        menu.addItem(actionItem("控制器显示设置…", action: #selector(showSettings)))
        menu.addItem(toggleItem("在 Dock 中显示", checked: preferences.showDock, action: #selector(toggleDock)))
        menu.addItem(toggleItem("在菜单栏显示图标", checked: preferences.showMenuBar, action: #selector(toggleMenuBar)))
        menu.addItem(actionItem("运行诊断…", action: #selector(runDiagnostics)))

        if includeQuit {
            menu.addItem(.separator())
            menu.addItem(actionItem("退出控制器（服务继续运行）", action: #selector(quitController), key: "q"))
        }
        return menu
    }

    private func actionItem(_ title: String, action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = busyLabel == nil
        return item
    }

    private func toggleItem(_ title: String, checked: Bool, action: Selector) -> NSMenuItem {
        let item = actionItem(title, action: action)
        item.state = checked ? .on : .off
        return item
    }

    private func rebuildMainMenu() {
        guard !isMenuTracking else { return }
        let mainMenu = NSMenu(title: "")
        let appRoot = NSMenuItem(title: "会话指挥塔", action: nil, keyEquivalent: "")
        let appMenu = makeControlMenu(includeQuit: true)
        appRoot.submenu = appMenu
        mainMenu.addItem(appRoot)
        NSApp.mainMenu = mainMenu
    }

    private func refreshStatus() {
        guard !isRefreshing else { return }
        isRefreshing = true
        client.readStatus { [weak self] result in
            guard let self else { return }
            isRefreshing = false
            switch result {
            case .success(let status):
                self.status = status
                self.statusKnown = true
            case .failure(let error):
                self.status = .unknown
                self.statusKnown = false
                self.logger.error("status failed: \(error.localizedDescription, privacy: .public)")
            }
            self.updateStatusItem()
            self.rebuildMainMenu()
        }
    }

    private func runAction(
        command: String,
        label: String,
        completion: ((CommandOutput) -> Void)? = nil
    ) {
        guard busyLabel == nil else { return }
        busyLabel = label
        updateStatusItem()
        rebuildMainMenu()
        logger.info("run action: \(command, privacy: .public)")
        client.run(command) { [weak self] result in
            guard let self else { return }
            self.busyLabel = nil
            switch result {
            case .success(let output):
                if output.exitCode == 0 {
                    completion?(output)
                } else {
                    self.presentError(title: "操作没有完成", detail: output.combinedText)
                }
            case .failure(let error):
                self.presentError(title: "操作没有完成", detail: error.localizedDescription)
            }
            self.refreshStatus()
            self.updateStatusItem()
            self.rebuildMainMenu()
        }
    }

    @objc private func openBoard(_ sender: Any?) {
        runAction(command: "open", label: "正在启动并打开…")
    }

    @objc private func restartService(_ sender: Any?) {
        runAction(command: "restart", label: "正在重新启动…")
    }

    @objc private func stopService(_ sender: Any?) {
        runAction(command: "stop", label: "正在停止…")
    }

    @objc private func runDiagnostics(_ sender: Any?) {
        runAction(command: "doctor", label: "正在诊断…") { [weak self] output in
            guard let self else { return }
            let title = output.exitCode == 0 ? "诊断通过" : "诊断发现问题"
            self.presentInformation(title: title, detail: output.combinedText)
        }
    }

    @objc private func toggleDock(_ sender: Any?) {
        setPresence(showDock: !preferences.showDock, showMenuBar: preferences.showMenuBar)
    }

    @objc private func toggleMenuBar(_ sender: Any?) {
        setPresence(showDock: preferences.showDock, showMenuBar: !preferences.showMenuBar)
    }

    @objc private func showSettings(_ sender: Any?) {
        presentSettingsPanel()
    }

    private func setPresence(showDock: Bool, showMenuBar: Bool) {
        if !showDock && !showMenuBar && !confirmHideAll() { return }
        preferences.showDock = showDock
        preferences.showMenuBar = showMenuBar
        applyPresence()
    }

    private func confirmHideAll() -> Bool {
        modalDepth += 1
        defer { modalDepth -= 1 }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "隐藏全部控制器入口？"
        alert.informativeText = "后台服务会继续运行。需要恢复时，从“应用程序”再次打开“会话指挥塔”，或双击仓库中的“显示会话指挥塔控制器”。"
        alert.addButton(withTitle: "全部隐藏")
        alert.addButton(withTitle: "取消")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func presentSettingsPanel() {
        guard modalDepth == 0 else { return }
        modalDepth += 1
        defer { modalDepth -= 1 }
        logger.notice("present settings")
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let dockCheckbox = NSButton(checkboxWithTitle: "在 Dock 中显示", target: nil, action: nil)
        dockCheckbox.state = preferences.showDock ? .on : .off
        let menuBarCheckbox = NSButton(checkboxWithTitle: "在菜单栏显示图标", target: nil, action: nil)
        menuBarCheckbox.state = preferences.showMenuBar ? .on : .off
        let options = NSStackView(views: [dockCheckbox, menuBarCheckbox])
        options.orientation = .vertical
        options.alignment = .leading
        options.spacing = 8
        options.frame = NSRect(x: 0, y: 0, width: 260, height: 52)

        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "控制器显示设置"
        alert.informativeText = "服务与控制器是分开的。两项都关闭时，后台服务仍会运行；再次从“应用程序”打开即可恢复设置。"
        alert.accessoryView = options
        alert.addButton(withTitle: "应用")
        alert.addButton(withTitle: "打开看板")
        alert.addButton(withTitle: "取消")
        let response = alert.runModal()

        guard response == .alertFirstButtonReturn || response == .alertSecondButtonReturn else {
            applyPresence()
            return
        }
        let showDock = dockCheckbox.state == .on
        let showMenuBar = menuBarCheckbox.state == .on
        if !showDock && !showMenuBar && !confirmHideAll() {
            applyPresence()
            return
        }
        preferences.showDock = showDock
        preferences.showMenuBar = showMenuBar
        applyPresence()
        if response == .alertSecondButtonReturn { openBoard(nil) }
    }

    private func presentError(title: String, detail: String) {
        modalDepth += 1
        defer { modalDepth -= 1 }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = detail.isEmpty ? "请运行诊断后重试。" : detail
        alert.runModal()
    }

    private func presentInformation(title: String, detail: String) {
        modalDepth += 1
        defer { modalDepth -= 1 }
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = title
        alert.informativeText = detail.isEmpty ? "未返回诊断信息。" : detail
        alert.runModal()
    }

    @objc private func quitController(_ sender: Any?) {
        NSApp.terminate(nil)
    }
}
