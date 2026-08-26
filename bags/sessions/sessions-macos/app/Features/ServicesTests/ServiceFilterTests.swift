import XCTest
@testable import ServicesFeature

final class ServiceFilterTests: XCTestCase {
    private func matches(_ query: String, _ label: String) -> Bool {
        let parsed = parseServiceName(label)
        return serviceMatches(query: query, name: parsed.name, owner: parsed.owner, label: label)
    }

    func testEmptyQueryMatchesEverything() {
        XCTAssertTrue(matches("", "com.barry.api"))
        XCTAssertTrue(matches("   ", "com.barry.bag.coffee.daemon"))
    }

    func testPlainPrefixMatch() {
        XCTAssertTrue(matches("rev", "com.barry.bag.bdiff.review"))
        XCTAssertTrue(matches("api", "com.barry.api"))
    }

    func testMatchIsCaseInsensitive() {
        XCTAssertTrue(matches("IDENT", "com.barry.bag.identities.app.Identities"))
        XCTAssertTrue(matches("barrysessions", "com.barry.bag.sessions-macos.app.BarrySessions"))
    }

    func testSearchByOwningBag() {
        XCTAssertTrue(matches("coffee", "com.barry.bag.coffee.reconcile"))
        XCTAssertTrue(matches("metrics", "com.barry.bag.job.metrics.sweep"))
    }

    /// An app's owner is suppressed on the row, but people will still type the
    /// bag name to look for it — the raw label keeps that searchable.
    func testAppFoundByBagNameEvenThoughOwnerIsHidden() {
        XCTAssertTrue(matches("sessions", "com.barry.bag.sessions-macos.app.BarrySessions"))
        XCTAssertTrue(matches("macos", "com.barry.bag.sessions-macos.app.BarrySessions"))
    }

    func testSeparatorsNeedNotBeTyped() {
        XCTAssertTrue(matches("githubapp", "com.barry.bag.github-app.webhook"))
        XCTAssertTrue(matches("healthcheck", "com.barry.job.health-check"))
    }

    func testInitialsMatchCamelCaseAndHyphenNames() {
        XCTAssertTrue(matches("bs", "com.barry.bag.sessions-macos.app.BarrySessions"))
        XCTAssertTrue(matches("dr", "com.barry.job.disk-retention"))
        XCTAssertTrue(matches("hc", "com.barry.job.health-check"))
    }

    func testUnrelatedQueryDoesNotMatch() {
        XCTAssertFalse(matches("postgres", "com.barry.bag.bdiff.review"))
        XCTAssertFalse(matches("zzzz", "com.barry.api"))
    }

    /// Regression: an unrestricted subsequence test matched these, because
    /// short queries find scattered characters in long dotted labels. A filter
    /// that returns unrelated rows is worse than no filter at all.
    func testLooseSubsequenceFalsePositivesAreRejected() {
        // "coff" once matched bdiff.review via scattered characters.
        XCTAssertFalse(matches("coff", "com.barry.bag.bdiff.review"))
        // "mcp" once matched seven unrelated agents.
        XCTAssertFalse(matches("mcp", "com.barry.job.backup"))
        XCTAssertFalse(matches("mcp", "com.barry.bag.job.metrics.sample"))
        XCTAssertFalse(matches("mcp", "com.barry.bag.slack-app.events"))
        // "sess" once matched BarryServices.
        XCTAssertFalse(matches("sess", "com.barry.bag.services.app.BarryServices"))
    }

    /// The queries above must still find what they were actually aiming at.
    func testTighteningKeptTheIntendedHits() {
        XCTAssertTrue(matches("coff", "com.barry.bag.coffee.daemon"))
        XCTAssertTrue(matches("mcp", "com.barry.mcp.barry"))
        XCTAssertTrue(matches("sess", "com.barry.bag.sessions-macos.app.BarrySessions"))
        XCTAssertTrue(matches("sess", "com.barry.bag.sessions.store"))
    }
}
