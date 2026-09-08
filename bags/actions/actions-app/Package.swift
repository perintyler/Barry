// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BarryActions",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "BarryActions", targets: ["BarryActions"])
    ],
    dependencies: [
        .package(path: "../../../packages/BarryKit"),
        // Components carries the markdown theme and palette. Action
        // deliverables ARE markdown (a wrap-up report is the motivating case),
        // and a second copy of the theme would drift from the rhythm and type
        // invariants MarkdownRhythmTests pins in that package.
        //
        // This directory is `actions-app`, not `app`: SwiftPM derives a
        // package's identity from its directory name, and a second package
        // called `app` collides with the sessions one — the dependency
        // resolves to itself and the product is reported missing.
        .package(path: "../../sessions/sessions-macos/app")
    ],
    targets: [
        // Pure, UI-independent logic — run grouping, status derivation and the
        // metadata reader. Split out so it is testable without standing up a
        // window or a live API, matching BarrySessionsCore's split.
        .target(
            name: "ActionsFeature",
            dependencies: [
                .product(name: "BarryKit", package: "BarryKit"),
                .product(name: "Components", package: "app")
            ],
            path: "Features/Actions",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "ActionsFeatureTests",
            dependencies: ["ActionsFeature"],
            path: "Features/ActionsTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "BarryActions",
            dependencies: ["ActionsFeature"],
            path: "Sources/App",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
