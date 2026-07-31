// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "BDiff",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "BDiff",
            targets: ["BDiff"]
        ),
    ],
    dependencies: [
        .package(path: "../BarryKit"),
        .package(url: "https://github.com/appstefan/highlightswift.git", from: "1.1.0"),
    ],
    targets: [
        // Core logic (models, parser) — extracted for testability
        .target(
            name: "BDiffCore",
            path: "Core"
        ),
        .executableTarget(
            name: "BDiff",
            dependencies: [
                "BDiffCore",
                .product(name: "BarryKit", package: "BarryKit"),
                .product(name: "HighlightSwift", package: "highlightswift"),
            ],
            path: "Sources",
            resources: [
                .copy("Resources/monaco-diff.html"),
            ]
        ),
        .testTarget(
            name: "BDiffTests",
            dependencies: ["BDiffCore"],
            path: "Tests"
        ),
    ]
)
