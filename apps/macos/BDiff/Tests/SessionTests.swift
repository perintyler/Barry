import Testing
@testable import BDiffCore

@Suite("Multi-repo diff parsing")
struct MultiRepoParseTests {

    private let diffA = """
    diff --git a/src/main.ts b/src/main.ts
    --- a/src/main.ts
    +++ b/src/main.ts
    @@ -1,2 +1,3 @@
     const a = 1;
    +const b = 2;
     export {};
    """

    private let diffB = """
    diff --git a/src/main.ts b/src/main.ts
    --- a/src/main.ts
    +++ b/src/main.ts
    @@ -5,1 +5,2 @@
     let x = 0;
    +let y = 1;
    """

    @Test func lineIdsStayUniqueAcrossRepoParses() {
        var lineId = 0
        let filesA = DiffParser.parse(diffA, repoPath: "/repos/alpha", repoName: "alpha", lineIdStart: &lineId)
        let filesB = DiffParser.parse(diffB, repoPath: "/repos/beta", repoName: "beta", lineIdStart: &lineId)

        let allIds = (filesA + filesB).flatMap(\.hunks).flatMap(\.lines).map(\.id)
        #expect(Set(allIds).count == allIds.count)
        #expect(!allIds.isEmpty)
    }

    @Test func fileIdsAreRepoQualified() {
        var lineId = 0
        let filesA = DiffParser.parse(diffA, repoPath: "/repos/alpha", repoName: "alpha", lineIdStart: &lineId)
        let filesB = DiffParser.parse(diffB, repoPath: "/repos/beta", repoName: "beta", lineIdStart: &lineId)

        // Same displayPath in two repos must not collide
        #expect(filesA[0].displayPath == filesB[0].displayPath)
        #expect(filesA[0].id != filesB[0].id)
        #expect(filesA[0].id == "/repos/alpha::src/main.ts")
        #expect(filesA[0].repoName == "alpha")
        #expect(filesB[0].repoPath == "/repos/beta")
    }

    @Test func nilRepoBehaviorUnchanged() {
        let files = DiffParser.parse(diffA)
        #expect(files.count == 1)
        #expect(files[0].id == "src/main.ts")
        #expect(files[0].repoPath == nil)
        #expect(files[0].repoName == nil)
    }
}

@Suite("Session visibility")
struct SessionVisibilityTests {

    private func session(_ id: String, status: String, startedAt: String? = nil, endedAt: String? = nil, repos: [String] = ["barry"], hasChanges: Bool? = nil) -> SessionSummary {
        SessionSummary(id: id, name: id, status: status, startedAt: startedAt, endedAt: endedAt, repos: repos, hasChanges: hasChanges)
    }

    @Test func liveSessionsSortFirst() {
        let sorted = SessionVisibility.sort([
            session("ended-new", status: "completed", endedAt: "2026-07-16T12:00:00Z"),
            session("live-old", status: "running", startedAt: "2026-07-16T08:00:00Z"),
            session("ended-old", status: "completed", endedAt: "2026-07-15T12:00:00Z"),
            session("live-new", status: "running", startedAt: "2026-07-16T10:00:00Z"),
        ])
        #expect(sorted.map(\.id) == ["live-new", "live-old", "ended-new", "ended-old"])
    }

    @Test func filterMatchesNameAndRepos() {
        let s = session("fix-auth-flow", status: "running", repos: ["barry", "core"])
        #expect(SessionVisibility.matches(s, filter: ""))
        #expect(SessionVisibility.matches(s, filter: "AUTH"))
        #expect(SessionVisibility.matches(s, filter: "core"))
        #expect(!SessionVisibility.matches(s, filter: "zebra"))
    }

    @Test func isLiveOnlyForRunning() {
        #expect(session("a", status: "running").isLive)
        #expect(!session("b", status: "completed").isLive)
        #expect(!session("c", status: "pending").isLive)
    }

    @Test func endedSessionsWithNoChangesAreKeptButSortedByRecency() {
        let sorted = SessionVisibility.sort([
            session("has-changes", status: "completed", endedAt: "2026-07-16T12:00:00Z", hasChanges: true),
            session("no-changes", status: "completed", endedAt: "2026-07-16T11:00:00Z", hasChanges: false),
            session("unknown", status: "completed", endedAt: "2026-07-16T10:00:00Z", hasChanges: nil),
        ])
        #expect(sorted.map(\.id) == ["has-changes", "no-changes", "unknown"])
    }

    @Test func liveSessionsKeptRegardlessOfHasChanges() {
        let sorted = SessionVisibility.sort([
            session("live-no-changes", status: "running", startedAt: "2026-07-16T10:00:00Z", hasChanges: false),
        ])
        #expect(sorted.map(\.id) == ["live-no-changes"])
    }
}
