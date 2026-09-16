import XCTest
@testable import BarrySessionsCore

final class StableHashTests: XCTestCase {
    /// The point of the type. `String.hashValue` is seeded per process, so the
    /// identity list used to give the same Barry a different avatar color on
    /// every launch. These literals are the guard: if the algorithm changes,
    /// colors shift for everyone and this test says so.
    func testValuesAreFixedAcrossRuns() {
        XCTAssertEqual(StableHash.value(""), 0xcbf2_9ce4_8422_2325)
        XCTAssertEqual(StableHash.value("a"), 0xaf63_dc4c_8601_ec8c)
        XCTAssertEqual(StableHash.value("bux"), StableHash.value("bux"))
    }

    func testIndexStaysInRange() {
        for name in ["bux", "bgoode", "vantage", "", "a very long identity name"] {
            let i = StableHash.index(name, slots: 6)
            XCTAssertTrue((0..<6).contains(i), "\(name) produced \(i)")
        }
    }

    func testDistinctNamesGenerallyDiffer() {
        let names = ["bux", "bgoode", "vantage", "scout", "ableton"]
        let indices = Set(names.map { StableHash.index($0, slots: 6) })
        XCTAssertGreaterThan(indices.count, 1, "every name collided onto one slot")
    }

    /// Guards the `count > 0` branch — `% 0` would trap.
    func testZeroSlotsIsSafe() {
        XCTAssertEqual(StableHash.index("bux", slots: 0), 0)
    }
}
