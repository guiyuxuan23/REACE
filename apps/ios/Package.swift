// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TraceAPI",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "TraceAPI", targets: ["TraceAPI"])],
    targets: [
        .target(name: "TraceAPI"),
        .testTarget(name: "TraceAPITests", dependencies: ["TraceAPI"])
    ]
)
