import Foundation
import Testing
@testable import BDiffCore

struct BranchVisibilityTests {
    private let now = ISO8601DateFormatter().date(from: "2026-07-10T12:00:00Z")!

    private func iso(daysAgo: Double) -> String {
        ISO8601DateFormatter().string(from: now.addingTimeInterval(-daysAgo * 86_400))
    }

    @Test func liveBranchesAlwaysVisible() {
        let stale = BranchEntry(name: "barry/xyz", kind: .worktree, lastCommitAt: iso(daysAgo: 120), isAgent: true, sessionIds: ["s1"])
        let (visible, hidden) = BranchVisibility.split([stale], now: now)
        #expect(visible.map(\.name) == ["barry/xyz"])
        #expect(hidden.isEmpty)
    }

    @Test func agentBranchesHiddenWithoutSession() {
        let agent = BranchEntry(name: "worktree-agent-a123", kind: .ref, lastCommitAt: iso(daysAgo: 0.1), isAgent: true)
        let (visible, hidden) = BranchVisibility.split([agent], now: now)
        #expect(visible.isEmpty)
        #expect(hidden.map(\.name) == ["worktree-agent-a123"])
    }

    @Test func humanWorktreesAlwaysVisibleEvenWhenStale() {
        let wt = BranchEntry(name: "fix/old-thing", kind: .worktree, lastCommitAt: iso(daysAgo: 90))
        let (visible, _) = BranchVisibility.split([wt], now: now)
        #expect(visible.map(\.name) == ["fix/old-thing"])
    }

    @Test func recentRefsVisibleStaleRefsHidden() {
        let recent = BranchEntry(name: "feat/new", kind: .ref, lastCommitAt: iso(daysAgo: 3))
        let stale = BranchEntry(name: "feat/old", kind: .ref, lastCommitAt: iso(daysAgo: 30))
        let (visible, hidden) = BranchVisibility.split([recent, stale], now: now)
        #expect(visible.map(\.name) == ["feat/new"])
        #expect(hidden.map(\.name) == ["feat/old"])
    }

    @Test func refWithoutDateHidden() {
        let unknown = BranchEntry(name: "mystery", kind: .ref)
        let (visible, hidden) = BranchVisibility.split([unknown], now: now)
        #expect(visible.isEmpty)
        #expect(hidden.count == 1)
    }

    @Test func orderPreserved() {
        let a = BranchEntry(name: "a", kind: .checkout, lastCommitAt: iso(daysAgo: 0))
        let b = BranchEntry(name: "b", kind: .ref, lastCommitAt: iso(daysAgo: 1))
        let c = BranchEntry(name: "c", kind: .worktree, lastCommitAt: iso(daysAgo: 2))
        let (visible, _) = BranchVisibility.split([a, b, c], now: now)
        #expect(visible.map(\.name) == ["a", "b", "c"])
    }

    @Test func windowControlsRefEligibility() {
        let fiveDays = BranchEntry(name: "feat/a", kind: .ref, lastCommitAt: iso(daysAgo: 5))
        let twentyDays = BranchEntry(name: "feat/b", kind: .ref, lastCommitAt: iso(daysAgo: 20))

        let (threeDay, _) = BranchVisibility.split([fiveDays, twentyDays], now: now, window: .threeDays)
        #expect(threeDay.isEmpty)

        let (week, _) = BranchVisibility.split([fiveDays, twentyDays], now: now, window: .week)
        #expect(week.map(\.name) == ["feat/a"])

        let (month, _) = BranchVisibility.split([fiveDays, twentyDays], now: now, window: .month)
        #expect(month.map(\.name) == ["feat/a", "feat/b"])
    }

    @Test func allWindowIncludesEverythingHuman() {
        let ancient = BranchEntry(name: "feat/old", kind: .ref, lastCommitAt: iso(daysAgo: 400))
        let agent = BranchEntry(name: "barry/x", kind: .ref, lastCommitAt: iso(daysAgo: 1), isAgent: true)
        let (eligible, rest) = BranchVisibility.split([ancient, agent], now: now, window: .all)
        #expect(eligible.map(\.name) == ["feat/old"])
        #expect(rest.map(\.name) == ["barry/x"])  // idle agents stay paged even at "all"
    }

    @Test func windowRoundTripsThroughRawValue() {
        for window in TimeWindow.allCases {
            #expect(TimeWindow(rawValue: window.rawValue) == window)
        }
        #expect(TimeWindow.threeDays.days == 3)
        #expect(TimeWindow.week.days == 7)
        #expect(TimeWindow.month.days == 30)
        #expect(TimeWindow.all.days == nil)
    }

    @Test func relativeTimeFormatting() {
        #expect(RelativeTime.short(from: now.addingTimeInterval(-30), to: now) == "now")
        #expect(RelativeTime.short(from: now.addingTimeInterval(-120), to: now) == "2m")
        #expect(RelativeTime.short(from: now.addingTimeInterval(-5 * 3600), to: now) == "5h")
        #expect(RelativeTime.short(from: now.addingTimeInterval(-32 * 3600), to: now) == "32h")
        #expect(RelativeTime.short(from: now.addingTimeInterval(-3 * 86_400), to: now) == "3d")
        #expect(RelativeTime.short(from: now.addingTimeInterval(-15 * 86_400), to: now) == "2w")
        #expect(RelativeTime.short(from: now.addingTimeInterval(-120 * 86_400), to: now) == "4mo")
    }

    @Test func decodesServerPayload() throws {
        let json = """
        {"ok":true,"repos":[{"repoPath":"/Users/t/repo","repoName":"repo","branches":[
          {"name":"main","kind":"checkout","worktreePath":"/Users/t/repo","lastCommitAt":"2026-07-10T01:02:08-04:00","isAgent":false,"sessionIds":["abc"]},
          {"name":"feat/x","kind":"ref","lastCommitAt":null,"isAgent":false,"sessionIds":[]}
        ]}]}
        """
        let decoded = try JSONDecoder().decode(RepoBranchesResponse.self, from: Data(json.utf8))
        let repo = try #require(decoded.repos.first)
        #expect(repo.hasLive)
        #expect(repo.branches[0].isCheckedOut)
        #expect(repo.branches[0].lastCommitDate != nil)
        #expect(repo.branches[1].kind == .ref)
    }
}
