// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "BarryKit",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "BarryKit",
            targets: ["BarryKit"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", exact: "1.10.4"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", exact: "1.9.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", exact: "1.2.0"),
        .package(url: "https://github.com/apple/swift-http-types", exact: "1.5.1")
    ],
    targets: [
        .target(
            name: "BarryKit",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "HTTPTypes", package: "swift-http-types")
            ],
            path: "Sources",
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .testTarget(
            name: "BarryKitTests",
            dependencies: ["BarryKit"],
            path: "Tests"
        )
    ]
)
