// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BarryEvents",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "BarryEvents", targets: ["BarryEvents"])
    ],
    targets: [
        // Pure, UI-independent bus logic (frame parsing, reconnect backoff, URL
        // building) — split out so it can be unit-tested without the executable.
        .target(
            name: "BarryEventsCore",
            path: "Core",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "BarryEvents",
            dependencies: ["BarryEventsCore"],
            path: "Sources",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "BarryEventsTests",
            dependencies: ["BarryEventsCore"],
            path: "Tests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
