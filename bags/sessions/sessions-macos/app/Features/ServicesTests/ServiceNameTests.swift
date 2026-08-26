import XCTest
@testable import ServicesFeature

final class ServiceNameTests: XCTestCase {
    func testFirstPartyServicesKeepTheirName() {
        XCTAssertEqual(parseServiceName("com.barry.api"), ServiceName(name: "api", owner: nil))
        XCTAssertEqual(parseServiceName("com.barry.web"), ServiceName(name: "web", owner: nil))
        XCTAssertEqual(parseServiceName("com.barry.caddy"), ServiceName(name: "caddy", owner: nil))
        XCTAssertEqual(parseServiceName("com.barry.cloudflared"), ServiceName(name: "cloudflared", owner: nil))
    }

    func testBagServiceLeadsWithItemAndCreditsBag() {
        XCTAssertEqual(
            parseServiceName("com.barry.bag.bdiff.review"),
            ServiceName(name: "review", owner: "bdiff")
        )
        XCTAssertEqual(
            parseServiceName("com.barry.bag.slack-app.events"),
            ServiceName(name: "events", owner: "slack-app")
        )
        XCTAssertEqual(
            parseServiceName("com.barry.bag.sessions.store"),
            ServiceName(name: "store", owner: "sessions")
        )
    }

    /// `bag.job.<bag>.<job>` and `bag.<bag>.<item>` share the `bag.` prefix.
    /// If the service form were tested first, every job would report its bag
    /// as the literal "job" and file under the wrong owner.
    func testBagJobsAreNotParsedAsAServiceOwnedByJob() {
        XCTAssertEqual(
            parseServiceName("com.barry.bag.job.metrics.sample"),
            ServiceName(name: "sample", owner: "metrics")
        )
        XCTAssertEqual(
            parseServiceName("com.barry.bag.job.reminders.dispatch"),
            ServiceName(name: "dispatch", owner: "reminders")
        )
    }

    func testFirstPartyJobsDropTheJobPrefix() {
        XCTAssertEqual(
            parseServiceName("com.barry.job.health-check"),
            ServiceName(name: "health-check", owner: nil)
        )
        XCTAssertEqual(
            parseServiceName("com.barry.job.disk-retention"),
            ServiceName(name: "disk-retention", owner: nil)
        )
    }

    /// The whole point of the change: an app row should read "Identities",
    /// not "bag.identities.app.Identities".
    func testAppDropsRedundantBagOwner() {
        XCTAssertEqual(
            parseServiceName("com.barry.bag.identities.app.Identities"),
            ServiceName(name: "Identities", owner: nil)
        )
        XCTAssertEqual(
            parseServiceName("com.barry.bag.services.app.BarryServices"),
            ServiceName(name: "BarryServices", owner: nil)
        )
        XCTAssertEqual(
            parseServiceName("com.barry.bag.events.app.BarryEvents"),
            ServiceName(name: "BarryEvents", owner: nil)
        )
    }

    /// "sessions-macos" restates "BarrySessions" once the Barry prefix and the
    /// platform suffix are discounted, so it is still noise.
    func testAppOwnerSuppressedAcrossBarryPrefixAndPlatformSuffix() {
        XCTAssertEqual(
            parseServiceName("com.barry.bag.sessions-macos.app.BarrySessions"),
            ServiceName(name: "BarrySessions", owner: nil)
        )
    }

    /// But a genuinely different bag name still earns its place on the row.
    func testAppKeepsOwnerWhenItAddsInformation() {
        XCTAssertEqual(
            parseServiceName("com.barry.bag.telemetry.app.Dashboard"),
            ServiceName(name: "Dashboard", owner: "telemetry")
        )
    }

    func testMcpReadsAsBareNameOwnedByMcp() {
        XCTAssertEqual(
            parseServiceName("com.barry.mcp.barry"),
            ServiceName(name: "barry", owner: "mcp")
        )
    }

    func testHyphenatedBagNamesSurviveIntact() {
        XCTAssertEqual(
            parseServiceName("com.barry.bag.github-app.webhook"),
            ServiceName(name: "webhook", owner: "github-app")
        )
    }

    func testLabelWithoutComBarryPrefixParsesTheSame() {
        XCTAssertEqual(
            parseServiceName("bag.coffee.daemon"),
            ServiceName(name: "daemon", owner: "coffee")
        )
    }

    /// Malformed or truncated labels must degrade to showing something rather
    /// than crashing or rendering an empty row.
    func testDegenerateLabelsStillProduceAName() {
        // A bare `bag.` with nothing after it has no item to show, so it falls
        // back to the label itself rather than rendering an empty row.
        XCTAssertEqual(parseServiceName("com.barry.bag."), ServiceName(name: "bag.", owner: nil))
        XCTAssertEqual(parseServiceName("com.barry.bag.solo"), ServiceName(name: "solo", owner: nil))
        XCTAssertFalse(parseServiceName("com.barry.bag.x.").name.isEmpty)
        XCTAssertFalse(parseServiceName("com.barry.").name.isEmpty)
        XCTAssertFalse(parseServiceName("com.barry.bag.job.").name.isEmpty)
    }

    /// Every label actually installed on this machine must yield a non-empty
    /// name — an empty row is invisible and unclickable.
    func testAllKnownLabelsProduceNonEmptyNames() {
        let labels = [
            "com.barry.api", "com.barry.bag.bdiff.review", "com.barry.bag.coffee.daemon",
            "com.barry.bag.coffee.reconcile", "com.barry.bag.events.app.BarryEvents",
            "com.barry.bag.github-app.webhook", "com.barry.bag.identities.app.Identities",
            "com.barry.bag.job.metrics.sample", "com.barry.bag.job.metrics.sweep",
            "com.barry.bag.job.reminders.dispatch", "com.barry.bag.metrics.web",
            "com.barry.bag.services.app.BarryServices",
            "com.barry.bag.sessions-macos.app.BarrySessions", "com.barry.bag.sessions.store",
            "com.barry.bag.slack-app.events", "com.barry.caddy", "com.barry.cloudflared",
            "com.barry.job.backup", "com.barry.job.disk-retention", "com.barry.job.health-check",
            "com.barry.job.log-maintenance", "com.barry.mcp.barry", "com.barry.web"
        ]
        for label in labels {
            let parsed = parseServiceName(label)
            XCTAssertFalse(parsed.name.isEmpty, "empty name for \(label)")
            XCTAssertFalse(parsed.name.hasPrefix("bag."), "unstripped bag prefix in \(label)")
            XCTAssertNotEqual(parsed.owner, "job", "job prefix leaked as owner for \(label)")
        }
    }
}
