import BarryKit
import Foundation
import OpenAPIRuntime

/// Reads action runs from the Barry API.
///
/// Owns the mapping from the generated OpenAPI types to this app's models, so
/// views never touch generator-shaped values — the same boundary BarryKit's
/// transport draws for identities and sessions.
public actor ActionsClient {
    private let core = BarryCore()

    public init() {}

    public func listRuns(action: String? = nil, limit: Int = 100) async throws -> [RunSummary] {
        let response = try await core.transport.listActionRuns(action: action, limit: limit)
        return response.runs.map(Self.summary)
    }

    public func listCatalog() async throws -> [CatalogEntry] {
        let response = try await core.transport.listActionCatalog()
        return response.actions
            .map {
                CatalogEntry(
                    name: $0.name,
                    qualifiedName: $0.qualifiedName,
                    bag: $0.bag,
                    description: $0.description,
                    executable: $0.executable,
                    inputNames: $0.inputNames,
                    // An API predating the form sends no schema; that reads as
                    // "no form", which is also the honest answer for the 15
                    // actions that declare nothing.
                    inputs: InputField.parse(
                        schema: $0.inputSchema?.additionalProperties.mapValues(\.value)
                    )
                )
            }
            .sorted { $0.name < $1.name }
    }

    /// Start a session that runs an action, and return its id.
    ///
    /// Two calls on purpose. The first creates the session and returns the
    /// instruction to seed it with; the second sends that instruction, which
    /// is what spawns the agent. Splitting them is what leaves room to
    /// subscribe to the session before it starts producing output.
    ///
    /// The seeded text tells the agent to call `use_action` — it is NOT the
    /// action's composed prompt. That is what makes the agent record the run,
    /// and why exactly one row appears per trigger.
    public func trigger(
        action: String,
        repoPath: String?,
        extra: String?,
        inputs: [String: Any]? = nil
    ) async throws -> String {
        // Only fields the user touched arrive here, so an empty dictionary and
        // nil mean the same thing: nothing was decided, infer it all.
        var encoded: Components.Schemas.TriggerActionRequest.InputsPayload?
        if let inputs, !inputs.isEmpty {
            encoded = .init(
                additionalProperties: try inputs.mapValues {
                    try OpenAPIRuntime.OpenAPIValueContainer(unvalidatedValue: $0)
                }
            )
        }

        let response = try await core.transport.triggerAction(
            .init(
                action: action,
                repoPath: repoPath,
                extra: (extra?.isEmpty ?? true) ? nil : extra,
                inputs: encoded
            )
        )
        try await core.transport.sendSessionMessage(
            sessionId: response.sessionId,
            content: response.prompt,
            repoPath: repoPath
        )
        return response.sessionId
    }

    /// One run in full. `metadata` is decoded here into the three-way
    /// `InputSide` rather than being handed to the view as loose JSON.
    public func run(id: String) async throws -> RunDetail {
        let detail = try await core.transport.getActionRun(id: id)
        // An API predating input capture sends no `metadata` at all. That is
        // not an error — it reads as `.notRecorded`, the same as an old run on
        // a new server, which is the honest answer either way. Requiring the
        // field would kill the whole detail view against an API that simply
        // has not been restarted yet.
        let unwrapped = (detail.metadata?.additionalProperties ?? [:])
            .mapValues(\.value)
            .compactMapValues { $0 }

        return RunDetail(
            summary: RunSummary(
                id: detail.runId,
                action: detail.action,
                bag: detail.bag,
                sessionId: detail.sessionId,
                status: RunStatus(wire: detail.status),
                summary: detail.summary,
                startedAt: Self.date(detail.startedAt),
                completedAt: detail.completedAt.map(Self.date),
                hasOutput: detail.output != nil
            ),
            inputSide: MetadataReader.inputSide(from: unwrapped),
            output: detail.output,
            validationFailures: detail.validationFailures ?? [],
            promptTruncated: MetadataReader.promptTruncated(from: unwrapped),
            extras: MetadataReader.extras(from: unwrapped)
        )
    }

    /// Takes the list response's ITEM type, not `ActionRunSummary`. Nested
    /// objects are inlined throughout this contract (SessionListResponse does
    /// the same), so the generator mints a structurally identical nested type
    /// for the array element. Naming it here beats reshaping the contract for
    /// one consumer's convenience.
    private static func summary(
        _ run: Components.Schemas.ActionRunListResponse.RunsPayloadPayload
    ) -> RunSummary {
        RunSummary(
            id: run.runId,
            action: run.action,
            bag: run.bag,
            sessionId: run.sessionId,
            status: RunStatus(wire: run.status),
            summary: run.summary,
            startedAt: date(run.startedAt),
            completedAt: run.completedAt.map(date),
            hasOutput: run.hasOutput
        )
    }

    /// Timestamps arrive as ISO-8601 strings. Fractional seconds are present
    /// on some rows and not others (Postgres drops a trailing zero), so both
    /// spellings are tried before giving up.
    static func date(_ raw: String) -> Date {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = withFraction.date(from: raw) { return parsed }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw) ?? Date.distantPast
    }
}
