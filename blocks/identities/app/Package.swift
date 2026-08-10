// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "Identities",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "Identities",
            targets: ["Identities"]
        )
    ],
    dependencies: [
        .package(path: "../../../packages/BarryKit")
    ],
    targets: [
        .executableTarget(
            name: "Identities",
            dependencies: [
                .product(name: "BarryKit", package: "BarryKit")
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "IdentitiesTests",
            dependencies: [.product(name: "BarryKit", package: "BarryKit")],
            path: "Tests"
        )
    ]
)
