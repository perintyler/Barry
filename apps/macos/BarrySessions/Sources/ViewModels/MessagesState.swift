import SwiftUI

/// Paginated message loading for a session.
/// Loads the most recent messages initially, supports loading older messages
/// on scroll-to-top, and polls for new messages on running sessions.
///
/// Data + pagination only — no scroll logic lives here. Scroll policy is in
/// `ChatScrollModel`; the view learns *what* changed via `mutationGeneration`
/// / `lastMutation` and reacts (follow-pin, prepend-compensate, unseen-count).
@Observable
@MainActor
final class MessagesState {
    /// What the most recent `messages` mutation was, so the view can pick the
    /// right scroll response.
    enum MutationKind: Equatable {
        case initial
        case prepend(count: Int)
        case append(count: Int)
        case detailUpdate
    }

    let sessionId: String
    let isRunning: Bool
    let targetSequence: Int?

    var messages: [Message] = []
    var hasOlder = false
    var hasNewer = false
    var isLoadingOlder = false
    var isLoadingNewer = false
    var isLoadingInitial = true
    var errorMessage: String?
    var loadingDetails: Set<Int> = []

    /// Cached render segments — rebuilt once per mutation via `commit(_:)`, not
    /// per body evaluation.
    private(set) var segments: [RenderedSegment] = []
    /// Bumped on every mutation so the view's `onChange(of:)` fires exactly once.
    private(set) var mutationGeneration = 0
    private(set) var lastMutation: MutationKind = .initial

    private var lowestSeq: Int?
    private var highestSeq: Int?
    private var seenKeys: Set<String> = []
    private var pollTask: Task<Void, Never>?
    private let client = BarryClient()

    init(sessionId: String, isRunning: Bool, targetSequence: Int? = nil) {
        self.sessionId = sessionId
        self.isRunning = isRunning
        self.targetSequence = targetSequence
    }

    /// Rebuild cached segments and publish the mutation event. Called at the end
    /// of every `messages` mutation. Runs inside a no-animation transaction so
    /// turn re-identity at pagination boundaries doesn't flash.
    private func commit(_ kind: MutationKind) {
        withTransaction(Transaction(animation: nil)) {
            segments = buildSegments(messages)
            lastMutation = kind
            mutationGeneration += 1
        }
    }

    // MARK: - Refresh

    /// Clear all state and reload from scratch.
    func refresh() async {
        stopPolling()
        messages = []
        seenKeys = []
        lowestSeq = nil
        highestSeq = nil
        hasOlder = false
        hasNewer = false
        loadingDetails = []
        commit(.initial)
        await loadInitial()
    }

    // MARK: - Initial Load

    func loadInitial() async {
        isLoadingInitial = true
        errorMessage = nil
        do {
            let response: MessagesResponse
            if let target = targetSequence {
                // Load a window of messages around the target sequence
                response = try await client.fetchMessages(
                    sessionId: sessionId, after: max(0, target - 7), limit: 14, summary: true
                )
            } else {
                response = try await client.fetchMessages(sessionId: sessionId, limit: 30, summary: true)
            }
            let deduped = dedup(response.messages)
            messages = deduped
            if targetSequence != nil {
                hasOlder = true
                hasNewer = response.hasMore
            } else {
                hasOlder = response.hasMore
            }
            updateSeqBounds()
            commit(.initial)
        } catch let decodingError as DecodingError {
            switch decodingError {
            case .typeMismatch(let type, let context):
                errorMessage = "Type mismatch: expected \(type) at \(context.codingPath.map(\.stringValue).joined(separator: "."))"
            case .keyNotFound(let key, let context):
                errorMessage = "Missing key '\(key.stringValue)' at \(context.codingPath.map(\.stringValue).joined(separator: "."))"
            case .valueNotFound(let type, let context):
                errorMessage = "Null value for \(type) at \(context.codingPath.map(\.stringValue).joined(separator: "."))"
            case .dataCorrupted(let context):
                errorMessage = "Data corrupted at \(context.codingPath.map(\.stringValue).joined(separator: ".")): \(context.debugDescription)"
            @unknown default:
                errorMessage = decodingError.localizedDescription
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingInitial = false

        if isRunning {
            startPolling()
        }
    }

    // MARK: - Load Older (scroll-to-top)

    func loadOlder() async {
        guard hasOlder, !isLoadingOlder, let lowest = lowestSeq else { return }
        isLoadingOlder = true
        do {
            let response = try await client.fetchMessages(
                sessionId: sessionId, before: lowest, limit: 50, summary: true
            )
            let deduped = dedup(response.messages)
            if !deduped.isEmpty {
                messages.insert(contentsOf: deduped, at: 0)
                hasOlder = response.hasMore
                updateSeqBounds()
                commit(.prepend(count: deduped.count))
            } else {
                hasOlder = response.hasMore
            }
        } catch {
            // Silently fail on older message loads
        }
        isLoadingOlder = false
    }

    // MARK: - Load Newer (scroll-to-bottom, when loaded around a target)

    func loadNewer() async {
        guard hasNewer, !isLoadingNewer, let highest = highestSeq else { return }
        isLoadingNewer = true
        do {
            let response = try await client.fetchMessages(
                sessionId: sessionId, after: highest, limit: 10, summary: true
            )
            let deduped = dedup(response.messages)
            if !deduped.isEmpty {
                messages.append(contentsOf: deduped)
                updateSeqBounds()
                commit(.append(count: deduped.count))
            }
            hasNewer = response.hasMore
        } catch {
            // Silently fail on newer message loads
        }
        isLoadingNewer = false
    }

    // MARK: - Poll for New

    func startPolling() {
        stopPolling()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled, let self else { return }
                await self.pollForNew()
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func pollForNew() async {
        // Defer while a prepend is in flight: an append committed in the same
        // frame would contaminate the prepend's height-delta compensation.
        // The next poll tick (5s) picks these up.
        guard !isLoadingOlder else { return }
        guard let highest = highestSeq else { return }
        do {
            let response = try await client.fetchMessages(
                sessionId: sessionId, after: highest, limit: 10, summary: true
            )
            let deduped = dedup(response.messages)
            if !deduped.isEmpty {
                messages.append(contentsOf: deduped)
                updateSeqBounds()
                commit(.append(count: deduped.count))
            }
        } catch {
            // Silently fail on polls
        }
    }

    // MARK: - Detail Loading

    /// Fetch full input/result for a tool call and update the message in place.
    func loadDetail(for sequence: Int) async {
        guard !loadingDetails.contains(sequence) else { return }
        loadingDetails.insert(sequence)
        do {
            let detail = try await client.fetchMessageDetail(sessionId: sessionId, sequence: sequence)
            if let idx = messages.firstIndex(where: { $0.sequence == sequence && $0.isToolCall }) {
                messages[idx].input = detail.input
                messages[idx].result = detail.result
                messages[idx].hasDetail = nil
                // Segments hold value copies of Message — rebuild so the expanded
                // row renders the loaded detail.
                commit(.detailUpdate)
            }
        } catch {
            // Silently fail — user can retry by collapsing and re-expanding
        }
        loadingDetails.remove(sequence)
    }

    // MARK: - Derived

    /// Timestamp of the last message, for the Info panel
    var lastMessageDate: Date? {
        guard let last = messages.last, let iso = last.createdAt else { return nil }
        return ISO8601DateFormatter().date(from: iso)
    }

    // MARK: - Private

    /// Deduplicate by (sequence, type) pair.
    /// The change-tracker hook and WS persistence can both fire for the same
    /// tool call, producing two rows with the same sequence and type.
    private func dedup(_ incoming: [Message]) -> [Message] {
        var result: [Message] = []
        for msg in incoming {
            let key = "\(msg.sequence):\(msg.type)"
            if !seenKeys.contains(key) {
                seenKeys.insert(key)
                result.append(msg)
            }
        }
        return result
    }

    private func updateSeqBounds() {
        guard !messages.isEmpty else { return }
        lowestSeq = messages.first?.sequence
        highestSeq = messages.last?.sequence
    }
}
