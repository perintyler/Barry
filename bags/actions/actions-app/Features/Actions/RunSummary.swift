import Foundation

/// Where a run got to. Mirrors `action_runs.status`.
///
/// `failed` is a CLOSED run whose declared post-conditions did not hold — the
/// work was done and reported, the check disagreed. It must not be shown as
/// though it were `started`, which means nobody ever closed the run at all.
/// Those are different problems: one is a bad result, the other is an
/// abandoned run, and `list-open-action-runs` exists to hunt only the second.
public enum RunStatus: String, Sendable {
    case started
    case complete
    case failed

    /// Unknown strings map to `started` rather than being dropped. A status
    /// this build has not heard of still describes a real run, and hiding it
    /// would make the list quietly incomplete.
    public init(wire: String) {
        self = RunStatus(rawValue: wire) ?? .started
    }
}

/// One row in the run list. Carries no deliverable — the list endpoint omits
/// outputs on purpose, and `hasOutput` says which rows are worth opening.
public struct RunSummary: Identifiable, Sendable, Equatable {
    public let id: String
    public let action: String
    public let bag: String
    public let sessionId: String?
    public let status: RunStatus
    public let summary: String?
    public let startedAt: Date
    public let completedAt: Date?
    public let hasOutput: Bool

    public init(
        id: String,
        action: String,
        bag: String,
        sessionId: String?,
        status: RunStatus,
        summary: String?,
        startedAt: Date,
        completedAt: Date?,
        hasOutput: Bool
    ) {
        self.id = id
        self.action = action
        self.bag = bag
        self.sessionId = sessionId
        self.status = status
        self.summary = summary
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.hasOutput = hasOutput
    }

    /// How long the run took, or nil while it is still open.
    public var duration: TimeInterval? {
        guard let completedAt else { return nil }
        return completedAt.timeIntervalSince(startedAt)
    }
}

/// The input side of a run, as recorded in `action_runs.metadata`.
///
/// THREE-VALUED ON PURPOSE. A run predating input capture, a run whose action
/// declares no inputs, and a run called with inputs are different facts, and
/// collapsing them would put an empty pane on screen that reads identically to
/// "we recorded nothing" — the failure this app exists to avoid.
public enum InputSide: Sendable, Equatable {
    /// No `prompt` key at all: this run was recorded before input capture
    /// existed. Nothing was lost; it was never written.
    case notRecorded
    /// Captured, and the action declared no inputs (wrap-up's case).
    case noInputs(prompt: String)
    /// Captured, with the values the caller supplied.
    case inputs(values: [String: String], prompt: String)

    public var prompt: String? {
        switch self {
        case .notRecorded: return nil
        case let .noInputs(prompt): return prompt
        case let .inputs(_, prompt): return prompt
        }
    }
}

/// A run in full: the deliverable and the input side that produced it.
public struct RunDetail: Sendable, Equatable {
    public let summary: RunSummary
    public let inputSide: InputSide
    public let output: String?
    public let validationFailures: [String]
    /// True when the stored prompt was cut at the metadata cap. Surfaced so a
    /// cut prompt is never mistaken for a short one.
    public let promptTruncated: Bool
    /// Anything else the run recorded — the provider a detached run used, and
    /// whatever a future writer adds. Kept so a key this build has never heard
    /// of is still shown rather than silently dropped.
    public let extras: [Extra]

    /// A named pair. A struct rather than a tuple so `RunDetail` can stay
    /// `Equatable` and drive SwiftUI's diffing.
    public struct Extra: Sendable, Equatable, Identifiable {
        public let key: String
        public let value: String
        public var id: String { key }

        public init(key: String, value: String) {
            self.key = key
            self.value = value
        }
    }

    public init(
        summary: RunSummary,
        inputSide: InputSide,
        output: String?,
        validationFailures: [String],
        promptTruncated: Bool,
        extras: [Extra] = []
    ) {
        self.summary = summary
        self.inputSide = inputSide
        self.output = output
        self.validationFailures = validationFailures
        self.promptTruncated = promptTruncated
        self.extras = extras
    }
}
