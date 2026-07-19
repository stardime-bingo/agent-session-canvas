// [INPUT]: macOS NSApplication 生命周期
// [OUTPUT]: 会话指挥塔原生控制器进程
// [POS]: SwiftPM GUI 可执行入口
// [PROTOCOL]: 变更时更新此头部，然后检查 AppDelegate.swift

import AppKit

@main
struct AgentCanvasControllerMain {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.run()
    }
}
