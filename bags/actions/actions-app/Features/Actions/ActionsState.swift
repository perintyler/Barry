import Foundation
import Observation

/// Drives the window: the run list, the selected run, and the fetches behind
/// both.
@MainActor
@Observable
public final class ActionsState {
    public private(set) var runs: LoadState<[RunSummary]> = .idle
    public private(set) var detail: LoadState<RunDetail> = .idle
    public private(set) var catalog: LoadState<[CatalogEntry]> = .idle
    public private(set) var trigger: TriggerOutcome = .idle

    /// Where a triggered session runs. Empty means the API's own cwd.
    public var triggerRepoPath: String = ""
    /// Free text appended to the seeded instruction as context for the run.
    public var triggerExtra: String = ""

    /// Which catalog action the trigger sheet is configuring. A form of nine
    /// fields cannot live inside a list row, so picking an action opens a
    /// detail pane beside the list rather than running it immediately.
    public var selectedActionId: String?

    /// In-progress form values, keyed by action id. Kept per action so a
    /// half-filled form survives clicking another row and coming back —
    /// otherwise a nine-field form is lost to a stray click.
    public var inputDrafts: [String: InputDraft] = [:]

    /// The draft for an action, creating an empty one on first access.
    public func draft(for entry: CatalogEntry) -> InputDraft {
        inputDrafts[entry.id] ?? InputDraft()
    }

    public func setDraft(_ draft: InputDraft, for entry: CatalogEntry) {
        inputDrafts[entry.id] = draft
    }

    /// Filter by action name; nil means all.
    public var actionFilter: String? {
        didSet { if actionFilter != oldValue { Task { await load() } } }
    }

    public var selectedRunId: String? {
        didSet { if selectedRunId != oldValue { Task { await loadDetail() } } }
    }

    private let client: ActionsClient

    public init(client: ActionsClient = ActionsClient()) {
        self.client = client
    }

    /// Every distinct action seen in the current list, for the filter menu.
    /// Derived from the loaded rows rather than the catalog: this menu exists
    /// to narrow what is on screen, and offering an action with no runs would
    /// only ever produce an empty list.
    public var knownActions: [String] {
        Array(Set(runs.value?.map(\.action) ?? [])).sorted()
    }

    public func load() async {
        runs = .loading
        do {
            runs = .loaded(try await client.listRuns(action: actionFilter))
        } catch {
            // Never .loaded([]) on failure — see LoadState's doc comment.
            runs = .failed(describeFetchFailure(error))
        }
    }

    public func loadDetail() async {
        guard let id = selectedRunId else {
            detail = .idle
            return
        }

        detail = .loading
        do {
            detail = .loaded(try await client.run(id: id))
        } catch {
            detail = .failed(describeFetchFailure(error))
        }
    }

    public func loadCatalog() async {
        catalog = .loading
        do {
            catalog = .loaded(try await client.listCatalog())
        } catch {
            catalog = .failed(describeFetchFailure(error))
        }
    }

    /// Run an action in a fresh session.
    ///
    /// On success the run list is refreshed so the new row appears — the whole
    /// point of triggering from here is watching it land. The row is written
    /// by the spawned agent when it calls `use_action`, so it may take a
    /// moment; a refresh that shows nothing yet is not an error.
    public func runAction(_ entry: CatalogEntry) async {
        trigger = .starting
        do {
            // Only what the user actually filled in. An untouched field is
            // omitted so the agent still infers it — see InputDraft.
            let values = draft(for: entry).values(for: entry.inputs)
            let sessionId = try await client.trigger(
                action: entry.qualifiedName,
                repoPath: triggerRepoPath.isEmpty ? nil : triggerRepoPath,
                extra: triggerExtra,
                inputs: values.isEmpty ? nil : values
            )
            trigger = .started(sessionId: sessionId, action: entry.name)
            triggerExtra = ""
            inputDrafts[entry.id] = nil
            await load()
        } catch {
            trigger = .failed(describeFetchFailure(error))
        }
    }

    public func dismissTrigger() {
        trigger = .idle
    }

    /// Re-read the list, keeping the selection if it survived.
    public func refresh() async {
        await load()
        if let id = selectedRunId, runs.value?.contains(where: { $0.id == id }) == false {
            selectedRunId = nil
        }
    }
}
