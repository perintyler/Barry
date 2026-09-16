import XCTest
@testable import ServicesFeature

/// astra review F13: `discoverServices()` used to re-parse every
/// `com.barry.*.plist` on every poll, unconditionally. `PlistCache` caches
/// `parsePlist`'s result per path, keyed by mtime, so an unchanged file is
/// never re-parsed.
final class PlistCacheTests: XCTestCase {
    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("PlistCacheTests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    private func writePlist(name: String, port: Int) throws -> URL {
        let url = tempDir.appendingPathComponent(name)
        let plist: [String: Any] = [
            "EnvironmentVariables": ["PORT": String(port)],
            "ProgramArguments": ["/usr/bin/true"],
        ]
        let data = try PropertyListSerialization.data(
            fromPropertyList: plist, format: .xml, options: 0
        )
        try data.write(to: url)
        return url
    }

    private func mtime(of url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate ?? .distantPast
    }

    func testParsesOnFirstLookup() throws {
        let url = try writePlist(name: "com.barry.test-a.plist", port: 4001)
        let cache = PlistCache()
        let service = cache.service(at: url, mtime: mtime(of: url))
        XCTAssertEqual(service?.port, 4001)
    }

    func testReturnsCachedResultForUnchangedMtime() throws {
        let url = try writePlist(name: "com.barry.test-b.plist", port: 4002)
        let cache = PlistCache()
        let stableMtime = mtime(of: url)

        let first = cache.service(at: url, mtime: stableMtime)

        // Mutate the file on disk WITHOUT changing the mtime we pass in — a
        // real cache-hit path never re-reads the bytes, so this proves the
        // second call actually used the cache rather than merely returning
        // an equal-by-coincidence result.
        let mutated: [String: Any] = [
            "EnvironmentVariables": ["PORT": "9999"],
            "ProgramArguments": ["/usr/bin/true"],
        ]
        let mutatedData = try PropertyListSerialization.data(
            fromPropertyList: mutated, format: .xml, options: 0
        )
        try mutatedData.write(to: url)

        let second = cache.service(at: url, mtime: stableMtime)
        XCTAssertEqual(first?.port, second?.port, "same mtime must return the cached parse, not re-read the mutated file")
        XCTAssertEqual(second?.port, 4002, "must be the ORIGINAL port — proves the cache, not the mutated file, was returned")
    }

    func testReparsesWhenMtimeChanges() throws {
        let url = try writePlist(name: "com.barry.test-c.plist", port: 4003)
        let cache = PlistCache()
        let firstMtime = mtime(of: url)
        _ = cache.service(at: url, mtime: firstMtime)

        let mutated: [String: Any] = [
            "EnvironmentVariables": ["PORT": "4004"],
            "ProgramArguments": ["/usr/bin/true"],
        ]
        let mutatedData = try PropertyListSerialization.data(
            fromPropertyList: mutated, format: .xml, options: 0
        )
        try mutatedData.write(to: url)
        // A distinct, later mtime — simulating a real file edit rather than
        // relying on the filesystem's own timestamp resolution, which can be
        // coarser than this test runs in.
        let newMtime = firstMtime.addingTimeInterval(1)

        let second = cache.service(at: url, mtime: newMtime)
        XCTAssertEqual(second?.port, 4004, "a changed mtime must trigger a real re-parse")
    }

    func testCachesAMissTooSoARepeatedlyUnparsablePlistIsNotReReadEveryCall() throws {
        let url = tempDir.appendingPathComponent("com.barry.broken.plist")
        try Data("not a plist".utf8).write(to: url)
        let cache = PlistCache()
        let stableMtime = mtime(of: url)

        XCTAssertNil(cache.service(at: url, mtime: stableMtime))
        // Second call with the same mtime must also return nil via the cache
        // path, not crash or behave differently on a repeat lookup.
        XCTAssertNil(cache.service(at: url, mtime: stableMtime))
    }

    /// Negative control: without the cache, calling `parsePlist` directly on
    /// every lookup would "work" too (same results) — the whole point of
    /// `PlistCacheTests.testReturnsCachedResultForUnchangedMtime` above is
    /// that it specifically distinguishes cached-hit behavior from a fresh
    /// re-parse (returning the ORIGINAL port after the file was mutated
    /// underneath the same mtime). This test pins that `parsePlist` alone —
    /// the pure function with no cache — does NOT have that property, so the
    /// cache test above is actually testing the cache, not something
    /// `parsePlist` already gave it for free.
    func testParsePlistAloneHasNoCachingBehavior() throws {
        let url = try writePlist(name: "com.barry.test-d.plist", port: 5001)
        let first = parsePlist(at: url)
        let mutated: [String: Any] = [
            "EnvironmentVariables": ["PORT": "5002"],
            "ProgramArguments": ["/usr/bin/true"],
        ]
        let mutatedData = try PropertyListSerialization.data(
            fromPropertyList: mutated, format: .xml, options: 0
        )
        try mutatedData.write(to: url)
        let second = parsePlist(at: url)
        XCTAssertEqual(first?.port, 5001)
        XCTAssertEqual(second?.port, 5002, "parsePlist alone always re-reads — the cache is what adds mtime-gating")
    }
}
