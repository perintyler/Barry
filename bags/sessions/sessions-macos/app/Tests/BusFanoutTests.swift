import XCTest
@testable import BarrySessionsCore

@MainActor
final class BusFanoutTests: XCTestCase {
    private func makeClient(topics: Set<String>) -> BusClient {
        BusClient(baseURL: URL(string: "http://localhost:4854")!, secret: nil, topics: topics)
    }

    /// The merged app runs one socket for every feature. With a single
    /// assignable `onTopicChanged`, whichever feature started last would
    /// silently replace the others' handler — the app would look connected
    /// while one surface simply stopped updating.
    func testEverySubscriberOnATopicIsCalled() {
        let bus = makeClient(topics: ["sessions", "events"])
        var calls: [String] = []
        bus.subscribe("sessions") { _ in calls.append("first") }
        bus.subscribe("sessions") { _ in calls.append("second") }

        bus.deliver(topic: "sessions")

        XCTAssertEqual(calls, ["first", "second"])
    }

    func testSubscribersOnlyHearTheirOwnTopic() {
        let bus = makeClient(topics: ["sessions", "events"])
        var sessions = 0
        var events = 0
        bus.subscribe("sessions") { _ in sessions += 1 }
        bus.subscribe("events") { _ in events += 1 }

        bus.deliver(topic: "events")

        XCTAssertEqual(sessions, 0)
        XCTAssertEqual(events, 1)
    }

    func testHandlerReceivesTheTopicName() {
        let bus = makeClient(topics: ["events"])
        var seen: String?
        bus.subscribe("events") { seen = $0 }

        bus.deliver(topic: "events")

        XCTAssertEqual(seen, "events")
    }

    /// A frame for a topic nobody subscribed to is ordinary — the socket
    /// carries every topic the app asked for — and must not trap.
    func testDeliveringToNoSubscribersIsHarmless() {
        let bus = makeClient(topics: ["sessions"])
        bus.deliver(topic: "sessions")
    }

    /// The legacy single-callback path still works; `AppState` and the events
    /// feed both moved to `subscribe`, but the property remains public API.
    func testOnTopicChangedStillFires() {
        let bus = makeClient(topics: ["sessions"])
        var fired = false
        bus.onTopicChanged = { _ in fired = true }

        bus.deliver(topic: "sessions")

        XCTAssertTrue(fired)
    }
}
