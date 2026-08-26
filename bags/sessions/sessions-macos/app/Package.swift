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
        // Exported so the standalone BarryIdentities app can host the same
        // window this package's popover links out to — one copy of the
        // identity code, two consumers.
        .library(
            name: "IdentitiesFeature",
            targets: ["IdentitiesFeature"]
        )
    ],
    dependencies: [
        .package(path: "../../../../packages/BarryKit"),
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.1"),
        .package(url: "https://github.com/smittytone/HighlighterSwift", from: "3.1.0")
    ],
    targets: [
        .target(
            name: "Components",
            dependencies: [
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
                .product(name: "Highlighter", package: "HighlighterSwift")
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
        // One feature target per menu-bar surface that was folded in. Each owns
        // its own models, client and views, and depends only on the shared
        // targets — never on the app target or on a sibling feature. That
        // boundary is what lets `InfoPanel`, `TraitsPanel` and friends keep
        // their natural names in more than one feature without colliding.
        .target(
            name: "EventsFeature",
            dependencies: [
                "Components",
                "BarrySessionsCore",
                .product(name: "BarryKit", package: "BarryKit")
            ],
            path: "Features/Events",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        // Its InfoPanel, TraitsPanel, CheckRow, SectionLabel and friends share
        // names with the sessions app's. Nine such collisions is why these are
        // separate modules rather than one merged target with renames.
        .target(
            name: "ApprovalsFeature",
            dependencies: [
                "Components",
                "BarrySessionsCore",
                .product(name: "BarryKit", package: "BarryKit")
            ],
            path: "Features/Approvals",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "ApprovalsFeatureTests",
            dependencies: ["ApprovalsFeature"],
            path: "Features/ApprovalsTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .target(
            name: "ServicesFeature",
            dependencies: ["Components", "BarrySessionsCore"],
            path: "Features/Services",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "ServicesFeatureTests",
            dependencies: ["ServicesFeature"],
            path: "Features/ServicesTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .target(
            name: "IdentitiesFeature",
            dependencies: [
                "Components",
                "BarrySessionsCore",
                .product(name: "BarryKit", package: "BarryKit")
            ],
            path: "Features/Identities",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "BarrySessions",
            dependencies: [
                "Components",
                "BarrySessionsCore",
                "EventsFeature",
                "ServicesFeature",
                "ApprovalsFeature",
                .product(name: "BarryKit", package: "BarryKit")
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
        // The identities feature had no tests at all — its models and form
        // rules were only ever exercised by running the app.
        .testTarget(
            name: "IdentitiesFeatureTests",
            dependencies: ["IdentitiesFeature"],
            path: "Features/IdentitiesTests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "BarrySessionsTests",
            dependencies: [
                "BarrySessionsCore",
                "Components",
                "EventsFeature",
                "ServicesFeature",
                .product(name: "BarryKit", package: "BarryKit")
            ],
            path: "Tests",
            // No explicit `sources:` list. It used to enumerate every file, which
            // meant a newly added test was not compiled and `swift test` still
            // reported success — a green run that proved nothing. Let SwiftPM
            // discover the directory instead.
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
