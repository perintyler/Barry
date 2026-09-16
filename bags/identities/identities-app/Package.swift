// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BarryIdentities",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "BarryIdentities", targets: ["BarryIdentities"])
    ],
    dependencies: [
        // The window itself lives in the sessions package, which exports it as
        // a library. Depending on it rather than copying keeps one definition
        // of the identity model, client and panels — the duplication between
        // the old menu bar apps is exactly what the consolidation removed.
        //
        // This directory is `identities-app`, not `app`: SwiftPM derives a
        // package's identity from its directory name, and two packages both
        // called `app` collide — the dependency resolves to itself and the
        // product is reported missing.
        .package(path: "../../sessions/sessions-macos/app")
    ],
    targets: [
        .testTarget(
            name: "BarryIdentitiesTests",
            dependencies: [
                .product(name: "IdentitiesFeature", package: "app")
            ],
            path: "Tests",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "BarryIdentities",
            dependencies: [
                .product(name: "IdentitiesFeature", package: "app")
            ],
            path: "Sources",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
