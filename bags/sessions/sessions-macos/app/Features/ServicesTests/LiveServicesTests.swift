import XCTest
@testable import ServicesFeature

/// Reads the machine's actual launchd agents through ServicesState.
///
/// The services tab shells out to `launchctl`, so nothing about it is proven
/// by a unit test over fixtures. Skips when no Barry agents are installed, so
/// it stays quiet on a fresh checkout.
@MainActor
final class LiveServicesTests: XCTestCase {
    func testDiscoversInstalledBarryAgents() async throws {
        let state = ServicesState()
        state.start()

        // start() refreshes asynchronously; give it a moment to land.
        for _ in 0..<20 {
            if !state.services.isEmpty { break }
            try await Task.sleep(for: .milliseconds(250))
        }

        guard !state.services.isEmpty else {
            throw XCTSkip("No Barry launchd agents installed on this machine")
        }

        // The merged app is itself an agent, so it must be in its own list.
        let names = state.services.map(\.id)
        XCTAssertTrue(
            names.contains { $0.contains("BarrySessions") || $0.contains("sessions") },
            "expected the sessions agent among \(names.prefix(10))"
        )
    }
}
