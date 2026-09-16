import XCTest
@testable import ServicesFeature

final class ServiceAttentionTests: XCTestCase {
    func testHealthyRunningServiceNeedsNothing() {
        XCTAssertNil(attentionLevel(isAlive: true, healthCheckPassed: true, isScheduled: false))
    }

    /// A service with no health endpoint is judged only on liveness.
    func testAliveWithNoHealthEndpointIsFine() {
        XCTAssertNil(attentionLevel(isAlive: true, healthCheckPassed: nil, isScheduled: false))
    }

    func testAliveButFailingHealthCheckIsUnhealthy() {
        XCTAssertEqual(
            attentionLevel(isAlive: true, healthCheckPassed: false, isScheduled: false),
            .unhealthy
        )
    }

    func testStoppedServiceIsDown() {
        XCTAssertEqual(
            attentionLevel(isAlive: false, healthCheckPassed: nil, isScheduled: false),
            .down
        )
    }

    /// The distinction the whole badge depends on: a scheduled agent is idle
    /// between firings, which is its normal resting state. Counting it as a
    /// fault would leave the badge permanently lit and therefore ignorable.
    func testScheduledJobIdleIsNotAFault() {
        XCTAssertNil(attentionLevel(isAlive: false, healthCheckPassed: nil, isScheduled: true))
    }

    /// A scheduled job that is mid-run and failing its health check is still
    /// worth surfacing — being scheduled excuses being idle, not being broken.
    func testScheduledJobFailingHealthIsStillUnhealthy() {
        XCTAssertEqual(
            attentionLevel(isAlive: true, healthCheckPassed: false, isScheduled: true),
            .unhealthy
        )
    }

    /// Regression: `bag.coffee.reconcile` is RunAtLoad with no KeepAlive and
    /// no timer. It runs, succeeds, and exits — its resting state on this
    /// machine is "not running" with last exit code 0. Counting it as down
    /// would pin the badge at 1 forever over a service working as designed,
    /// which is exactly what trains a reader to ignore the badge.
    func testRunOnceScriptThatExitedIsNotDown() {
        XCTAssertNil(attentionLevel(
            isAlive: false, healthCheckPassed: nil,
            isScheduled: false, expectedToStayUp: false
        ))
    }

    /// A long-running service is still flagged when it stops.
    func testLongRunningServiceStoppedIsStillDown() {
        XCTAssertEqual(
            attentionLevel(
                isAlive: false, healthCheckPassed: nil,
                isScheduled: false, expectedToStayUp: true
            ),
            .down
        )
    }

    /// Mirrors the real fleet: only the stopped webhook should be flagged —
    /// not the idle metrics jobs, and not the run-once reconcile script.
    func testRealisticFleetFlagsOnlyTheStoppedService() {
        let fleet: [(alive: Bool, health: Bool?, scheduled: Bool, staysUp: Bool)] = [
            (true, true, false, true),    // api
            (true, true, false, true),    // web
            (true, nil, false, true),     // coffee.daemon
            (false, nil, false, true),    // github-app.webhook — stopped
            (false, nil, true, true),     // job.metrics.sample — idle
            (false, nil, true, true),     // job.metrics.sweep — idle
            (false, nil, false, false)    // coffee.reconcile — ran and exited 0
        ]
        let flagged = fleet.compactMap {
            attentionLevel(
                isAlive: $0.alive, healthCheckPassed: $0.health,
                isScheduled: $0.scheduled, expectedToStayUp: $0.staysUp
            )
        }
        XCTAssertEqual(flagged.count, 1)
        XCTAssertEqual(flagged.first, .down)
    }
}
