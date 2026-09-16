import Foundation

/// An action the user can trigger.
public struct CatalogEntry: Identifiable, Sendable, Equatable {
    public let name: String
    public let qualifiedName: String
    public let bag: String
    public let description: String
    /// True when the action can run detached (`do_action`). Informational
    /// here: the trigger seeds a session either way, because that path works
    /// for all sixteen actions rather than the one that is detachable.
    public let executable: Bool
    public let inputNames: [String]
    /// The declared inputs, parsed into form fields. Empty when the action
    /// declares none — which is 15 of the 16 shipped actions, so the detail
    /// pane must read well with no form at all.
    public let inputs: [InputField]

    public var id: String { qualifiedName }

    public init(
        name: String,
        qualifiedName: String,
        bag: String,
        description: String,
        executable: Bool,
        inputNames: [String],
        inputs: [InputField] = []
    ) {
        self.name = name
        self.qualifiedName = qualifiedName
        self.bag = bag
        self.description = description
        self.executable = executable
        self.inputNames = inputNames
        self.inputs = inputs
    }

    /// First line only. Descriptions are written to be MATCHED by
    /// `find_actions`, so they routinely run to a paragraph of "use when the
    /// user says…" phrasing — correct for retrieval, wrong under a list row.
    public var shortDescription: String {
        description
            .split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true)
            .first
            .map(String.init) ?? description
    }
}

/// What happened when the user pressed Run.
///
/// `.started` deliberately names the session: a trigger whose only feedback is
/// a spinner disappearing is indistinguishable from one that silently failed.
public enum TriggerOutcome: Sendable, Equatable {
    case idle
    case starting
    case started(sessionId: String, action: String)
    case failed(String)
}
