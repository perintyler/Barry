import Foundation

// Models for the repo-keyed branch selector (GET /repos/branches).
// Design: design/branch-selector.md

public enum BranchKind: String, Codable, Sendable {
    case checkout   // HEAD of the main working copy
    case worktree   // HEAD of a linked worktree
    case ref        // plain branch ref, not checked out anywhere
}

public struct BranchEntry: Codable, Identifiable, Hashable, Sendable {
    public let name: String
    public let kind: BranchKind
    public let worktreePath: String?
    public let lastCommitAt: String?
    public let isAgent: Bool
    public let sessionIds: [String]

    public init(
        name: String,
        kind: BranchKind,
        worktreePath: String? = nil,
        lastCommitAt: String? = nil,
        isAgent: Bool = false,
        sessionIds: [String] = []
    ) {
        self.name = name
        self.kind = kind
        self.worktreePath = worktreePath
        self.lastCommitAt = lastCommitAt
        self.isAgent = isAgent
        self.sessionIds = sessionIds
    }

    public var id: String { name }
    public var isLive: Bool { !sessionIds.isEmpty }

    /// True when the branch exists as a real directory (working copy or
    /// worktree) — diffs include uncommitted changes and Working mode works.
    public var isCheckedOut: Bool { kind != .ref }

    public var lastCommitDate: Date? {
        lastCommitAt.flatMap { Self.iso.date(from: $0) }
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
}

public struct RepoBranches: Codable, Identifiable, Sendable {
    public let repoPath: String
    public let repoName: String
    public let branches: [BranchEntry]

    public init(repoPath: String, repoName: String, branches: [BranchEntry]) {
        self.repoPath = repoPath
        self.repoName = repoName
        self.branches = branches
    }

    public var id: String { repoPath }
    public var hasLive: Bool { branches.contains { $0.isLive } }
}

public struct RepoBranchesResponse: Codable, Sendable {
    public let repos: [RepoBranches]
}

/// How far back a ref's last commit may be to count as "recent".
public enum TimeWindow: String, CaseIterable, Sendable {
    case threeDays = "3d"
    case week = "1w"
    case month = "1m"
    case all = "all"

    /// nil = no cutoff
    public var days: Int? {
        switch self {
        case .threeDays: return 3
        case .week: return 7
        case .month: return 30
        case .all: return nil
        }
    }

    public var label: String { rawValue }
}

public enum BranchVisibility {
    /// Rows shown per repo before "show 5 more" starts paging.
    public static let pageSize = 5

    /// Split branches into eligible rows (tier A) and the paged tail (tier B).
    ///
    /// Eligible: live sessions, human checkouts/worktrees, and refs committed
    /// to within the window. Tail: stale refs and agent branches without a
    /// live session. Server recency order is preserved in both lists.
    public static func split(
        _ branches: [BranchEntry],
        now: Date = Date(),
        window: TimeWindow = .week
    ) -> (eligible: [BranchEntry], rest: [BranchEntry]) {
        let cutoff = window.days.map { now.addingTimeInterval(-TimeInterval($0) * 86_400) }
        var eligible: [BranchEntry] = []
        var rest: [BranchEntry] = []
        for branch in branches {
            if branch.isLive {
                eligible.append(branch)
            } else if branch.isAgent {
                rest.append(branch)
            } else if branch.isCheckedOut {
                eligible.append(branch)
            } else if cutoff == nil {
                eligible.append(branch)
            } else if let date = branch.lastCommitDate, let cutoff, date >= cutoff {
                eligible.append(branch)
            } else {
                rest.append(branch)
            }
        }
        return (eligible, rest)
    }
}

/// Compact relative times for branch rows: 2m, 5h, 32h, 3d, 2w, 4mo.
public enum RelativeTime {
    public static func short(from date: Date, to now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "now" }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(minutes)m" }
        let hours = Int(seconds / 3600)
        if hours < 48 { return "\(hours)h" }
        let days = Int(seconds / 86_400)
        if days < 14 { return "\(days)d" }
        if days < 60 { return "\(days / 7)w" }
        return "\(days / 30)mo"
    }
}
