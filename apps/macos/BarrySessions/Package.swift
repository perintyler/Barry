// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BarrySessions",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(
            name: "BarrySessions",
            targets: ["BarrySessions"]
        ),
        .library(
            name: "BarrySessionsCore",
            targets: ["BarrySessionsCore"]
        ),
    ],
    dependencies: [
        .package(path: "../BarryKit"),
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.1"),
        .package(url: "https://github.com/smittytone/HighlighterSwift", from: "3.1.0"),
    ],
    targets: [
        .target(
            name: "Components",
            dependencies: [
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
                .product(name: "Highlighter", package: "HighlighterSwift"),
            ],
            path: "Components",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // Pure, UI-independent logic (scroll policy, bus frame parsing and
        // reconnect backoff) — split out so it can be unit-tested without the
        // executable or a live socket.
        .target(
            name: "BarrySessionsCore",
            path: "Core",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "BarrySessions",
            dependencies: [
                "Components",
                "BarrySessionsCore",
                .product(name: "BarryKit", package: "BarryKit"),
            ],
            path: "Sources",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "Snapshots",
            dependencies: ["Components"],
            path: "Snapshots",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "BarrySessionsTests",
            dependencies: [
                "BarrySessionsCore",
                .product(name: "BarryKit", package: "BarryKit"),
            ],
            path: "Tests",
            sources: ["ContractDecodeTests.swift", "ChatScrollModelTests.swift", "BusProtocolTests.swift"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
