// [INPUT]: launchd 控制脚本、安装 plist 与 UserDefaults
// [OUTPUT]: 服务状态解码、异步命令执行、控制器显示偏好
// [POS]: 原生控制器的无 UI 内核；不读取或写入真实画布数据
// [PROTOCOL]: 变更时更新此头部，然后检查 mac-controller/Tests

import Foundation

struct ServiceStatus: Codable, Equatable {
    let registered: Bool
    let running: Bool
    let pid: Int?
    let apiHealthy: Bool
    let port: Int
    let appHome: String

    static let unknown = ServiceStatus(
        registered: false,
        running: false,
        pid: nil,
        apiHealthy: false,
        port: 4517,
        appHome: ""
    )

    var isHealthy: Bool { registered && running && apiHealthy }

    static func decode(_ data: Data) throws -> ServiceStatus {
        try JSONDecoder().decode(ServiceStatus.self, from: data)
    }
}

enum AppHomeLocator {
    static func locate(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        launchAgentURL: URL? = nil
    ) -> URL {
        if let explicit = environment["AGENT_CANVAS_HOME"], !explicit.isEmpty {
            return URL(fileURLWithPath: explicit).standardizedFileURL
        }

        let plistURL = launchAgentURL ?? homeDirectory
            .appendingPathComponent("Library/LaunchAgents/com.bingo.agent-canvas.plist")
        if let data = try? Data(contentsOf: plistURL),
           let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
           let dictionary = plist as? [String: Any],
           let arguments = dictionary["ProgramArguments"] as? [String],
           arguments.count > 1 {
            let serverEntry = URL(fileURLWithPath: arguments[1]).standardizedFileURL
            return serverEntry.deletingLastPathComponent().deletingLastPathComponent()
        }

        return homeDirectory.appendingPathComponent(".agent-session-canvas").standardizedFileURL
    }
}

struct CommandOutput {
    let stdout: String
    let stderr: String
    let exitCode: Int32

    var combinedText: String {
        [stdout, stderr]
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
    }
}

enum ServiceClientError: LocalizedError {
    case missingController(String)
    case launchFailed(String)

    var errorDescription: String? {
        switch self {
        case .missingController(let path):
            return "未找到服务控制脚本：\(path)"
        case .launchFailed(let reason):
            return "无法运行服务控制脚本：\(reason)"
        }
    }
}

final class ServiceClient {
    let controllerURL: URL
    let appHome: URL

    init(controllerURL: URL, appHome: URL) {
        self.controllerURL = controllerURL
        self.appHome = appHome
    }

    func runSync(_ command: String) throws -> CommandOutput {
        guard FileManager.default.fileExists(atPath: controllerURL.path) else {
            throw ServiceClientError.missingController(controllerURL.path)
        }

        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = [controllerURL.path, command]
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.environment = ProcessInfo.processInfo.environment.merging([
            "AGENT_CANVAS_HOME": appHome.path,
        ]) { _, appValue in appValue }

        do {
            try process.run()
        } catch {
            throw ServiceClientError.launchFailed(error.localizedDescription)
        }

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return CommandOutput(
            stdout: String(decoding: stdoutData, as: UTF8.self),
            stderr: String(decoding: stderrData, as: UTF8.self),
            exitCode: process.terminationStatus
        )
    }

    func run(_ command: String, completion: @escaping (Result<CommandOutput, Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            let result = Result { try runSync(command) }
            DispatchQueue.main.async { completion(result) }
        }
    }

    func readStatus(completion: @escaping (Result<ServiceStatus, Error>) -> Void) {
        run("status") { result in
            completion(result.flatMap { output in
                Result { try ServiceStatus.decode(Data(output.stdout.utf8)) }
            })
        }
    }
}

final class DisplayPreferences {
    private enum Key {
        static let showDock = "controller.showDock"
        static let showMenuBar = "controller.showMenuBar"
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var showDock: Bool {
        get { defaults.object(forKey: Key.showDock) == nil ? true : defaults.bool(forKey: Key.showDock) }
        set { defaults.set(newValue, forKey: Key.showDock) }
    }

    var showMenuBar: Bool {
        get { defaults.object(forKey: Key.showMenuBar) == nil ? true : defaults.bool(forKey: Key.showMenuBar) }
        set { defaults.set(newValue, forKey: Key.showMenuBar) }
    }
}
