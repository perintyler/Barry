// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "BarryProfiles",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "BarryProfiles",
            targets: ["BarryProfiles"]
        )
    ],
    dependencies: [
        .package(path: "../BarryKit")
    ],
    targets: [
        .executableTarget(
            name: "BarryProfiles",
            dependencies: [
                .product(name: "BarryKit", package: "BarryKit")
            ],
            path: "Sources"
        ),
        .testTarget(
            name: "BarryProfilesTests",
            dependencies: [.product(name: "BarryKit", package: "BarryKit")],
            path: "Tests"
        )
    ]
)
