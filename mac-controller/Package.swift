// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AgentCanvasController",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "AgentCanvasController", targets: ["AgentCanvasController"]),
    ],
    targets: [
        .executableTarget(
            name: "AgentCanvasController",
            path: "Sources/AgentCanvasController"
        ),
        .testTarget(
            name: "AgentCanvasControllerTests",
            dependencies: ["AgentCanvasController"],
            path: "Tests/AgentCanvasControllerTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
