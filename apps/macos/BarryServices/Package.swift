// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BarryServices",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "BarryServices", targets: ["BarryServices"]),
    ],
    targets: [
        .executableTarget(
            name: "BarryServices",
            path: "Sources",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
