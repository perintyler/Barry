import XCTest
@testable import BarryEventsCore

final class BusProtocolTests: XCTestCase {

    // MARK: - Frame parsing

    func testRecognisesABusFrame() {
        let frame = #"{"type":"bus","topic":"events","id":"evt_1","kind":"progress"}"#
        XCTAssertEqual(BusProtocol.topic(fromFrame: frame), "events")
    }

    func testIgnoresNonBusFrames() {
        // The socket also carries session traffic; only bus frames are signals.
        XCTAssertNil(BusProtocol.topic(fromFrame: #"{"type":"text","content":"hi"}"#))
        XCTAssertNil(BusProtocol.topic(fromFrame: #"{"type":"topic_subscribed","topic":"events"}"#))
    }

    func testIgnoresMalformedFrames() {
        XCTAssertNil(BusProtocol.topic(fromFrame: "not json"))
        XCTAssertNil(BusProtocol.topic(fromFrame: ""))
        XCTAssertNil(BusProtocol.topic(fromFrame: #"{"type":"bus"}"#))          // no topic
        XCTAssertNil(BusProtocol.topic(fromFrame: #"{"type":"bus","topic":""}"#)) // empty topic
    }

    // MARK: - Reconnect backoff

    func testBackoffDoubles() {
        XCTAssertEqual(BusProtocol.reconnectDelay(attempt: 1), 1)
        XCTAssertEqual(BusProtocol.reconnectDelay(attempt: 2), 2)
        XCTAssertEqual(BusProtocol.reconnectDelay(attempt: 3), 4)
        XCTAssertEqual(BusProtocol.reconnectDelay(attempt: 4), 8)
    }

    func testBackoffIsCapped() {
        XCTAssertEqual(BusProtocol.reconnectDelay(attempt: 20), 30)
        // A long outage must not overflow into an infinite delay.
        XCTAssertEqual(BusProtocol.reconnectDelay(attempt: 10_000), 30)
        XCTAssertTrue(BusProtocol.reconnectDelay(attempt: 10_000).isFinite)
    }

    func testBackoffHandlesZero() {
        XCTAssertEqual(BusProtocol.reconnectDelay(attempt: 0), 0)
    }

    // MARK: - Frame building

    func testBuildsSubscribeFrame() throws {
        let frame = try XCTUnwrap(BusProtocol.subscribeFrame(topic: "events"))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: String]
        )
        XCTAssertEqual(object["type"], "subscribe_topic")
        XCTAssertEqual(object["topic"], "events")
    }

    func testSubscribeAndUnsubscribeRoundTrip() throws {
        let unsubscribe = try XCTUnwrap(BusProtocol.unsubscribeFrame(topic: "sessions"))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(unsubscribe.utf8)) as? [String: String]
        )
        XCTAssertEqual(object["type"], "unsubscribe_topic")
        XCTAssertEqual(object["topic"], "sessions")
    }

    // MARK: - Socket URL

    func testUpgradesHttpToWs() throws {
        let url = try XCTUnwrap(BusProtocol.socketURL(apiBaseURL: URL(string: "http://localhost:4854")!))
        XCTAssertEqual(url.absoluteString, "ws://localhost:4854/api/v1/ws")
    }

    func testUpgradesHttpsToWss() throws {
        let url = try XCTUnwrap(BusProtocol.socketURL(apiBaseURL: URL(string: "https://barry.works")!))
        XCTAssertEqual(url.absoluteString, "wss://barry.works/api/v1/ws")
    }

    func testReplacesAnyExistingPath() throws {
        let url = try XCTUnwrap(BusProtocol.socketURL(apiBaseURL: URL(string: "http://localhost:4854/api/v1")!))
        XCTAssertEqual(url.absoluteString, "ws://localhost:4854/api/v1/ws")
    }
}

final class ReconnectPolicyTests: XCTestCase {

    func testDelayGrowsWithConsecutiveFailures() {
        var policy = ReconnectPolicy()
        XCTAssertEqual(policy.nextDelay(), 1)
        XCTAssertEqual(policy.nextDelay(), 2)
        XCTAssertEqual(policy.nextDelay(), 4)
    }

    func testSuccessResetsTheBackoff() {
        // Without this, a link that flaps would inherit a 30s delay from an
        // outage that already recovered.
        var policy = ReconnectPolicy()
        _ = policy.nextDelay()
        _ = policy.nextDelay()
        _ = policy.nextDelay()

        policy.recordSuccess()

        XCTAssertEqual(policy.nextDelay(), 1)
    }

    func testStopSuppressesReconnects() {
        // stop() during a pending retry must not resurrect the socket.
        var policy = ReconnectPolicy()
        _ = policy.nextDelay()
        policy.stop()

        XCTAssertNil(policy.nextDelay())
        XCTAssertTrue(policy.isStopped)
    }

    func testStartClearsStoppedState() {
        var policy = ReconnectPolicy()
        policy.stop()
        policy.start()

        XCTAssertFalse(policy.isStopped)
        XCTAssertEqual(policy.attempts, 0)
        XCTAssertEqual(policy.nextDelay(), 1)
    }

    func testRespectsItsCap() {
        var policy = ReconnectPolicy(cap: 5)
        for _ in 0..<10 { _ = policy.nextDelay() }
        XCTAssertEqual(policy.nextDelay(), 5)
    }
}
