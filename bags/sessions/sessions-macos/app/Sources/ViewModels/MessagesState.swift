import SwiftUI
import BarrySessionsCore

/// Paginated message loading for a session.
/// Loads the most recent messages initially, supports loading older messages
/// on scroll-to-top, and polls for new messages on running sessions.
///
/// Data + pagination only — no scroll logic lives here. Scroll policy is in
/// `ChatScrollModel`; the view learns *what* changed via `mutationGeneration`
/// / `lastMutation` and reacts (follow-pin, prepend-compensate, unseen-count).
///
/// astra review F14: this used to have no bound on how much it retained, and
/// rebuilt `segments` from the full `messages` array on every mutation — a
/// long-running session (hours of 5s polling, or deep scrollback) grew both
/// without bound. `MessageRetention` caps what's kept; `appendSegments`/
/// `prependSegments` (`ConversationSegments.swift`) patch only the mutation's
/// boundary instead of re-walking everything; `MessagePolling` bounds how
/// many pages one poll tick may catch up across.
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

    /// Cached render segments — rebuilt (fully, on `.initial`/`.detailUpdate`,
    /// or incrementally, on `.append`/`.prepend`) once per mutation via
    /// `commit*`, not per body evaluation.
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

    /// Full rebuild — used only where there is no single boundary to patch:
    /// the initial load (nothing to patch onto) and a detail update (a
    /// message in the MIDDLE of the list changed in place, not at an edge).
    /// Runs inside a no-animation transaction so turn re-identity at
    /// pagination boundaries doesn't flash.
    private func commit(_ kind: MutationKind) {
        withTransaction(Transaction(animation: nil)) {
            segments = buildSegments(messages)
            lastMutation = kind
            mutationGeneration += 1
        }
    }

    /// Incremental commit for messages appended at the end (poll, loadNewer).
    /// `newlyAppended` must be exactly the messages just added to the tail of
    /// `messages` — the caller already applied the mutation before calling this.
    private func commitAppend(newlyAppended: [Message]) {
        withTransaction(Transaction(animation: nil)) {
            segments = appendSegments(to: segments, appending: newlyAppended)
            lastMutation = .append(count: newlyAppended.count)
            mutationGeneration += 1
        }
    }

    /// Incremental commit for messages prepended at the start (loadOlder).
    /// `newlyPrepended` must be exactly the messages just added to the head of
    /// `messages` — the caller already applied the mutation before calling this.
    private func commitPrepend(newlyPrepended: [Message]) {
        withTransaction(Transaction(animation: nil)) {
            segments = prependSegments(to: segments, prepending: newlyPrepended)
            lastMutation = .prepend(count: newlyPrepended.count)
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
        // `defer`, not a statement after the `do` block: this runs inside a
        // `.task`, the popover is `.transient`, and closing it mid-fetch
        // cancels the task at an `await` — so the function never resumes and
        // a trailing assignment never runs. The flag stays true, and because
        // the state object outlives the view, reopening shows a spinner that
        // never resolves.
        defer { isLoadingInitial = false }
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
        // Same cancellation hazard as `loadInitial`: the guard above means a
        // stuck flag blocks every later attempt, not just this one.
        defer { isLoadingOlder = false }
        do {
            let response = try await client.fetchMessages(
                sessionId: sessionId, before: lowest, limit: 50, summary: true
            )
            let deduped = dedup(response.messages)
            if !deduped.isEmpty {
                messages.insert(contentsOf: deduped, at: 0)
                hasOlder = response.hasMore
                updateSeqBounds()
                commitPrepend(newlyPrepended: deduped)
                // No retention trim here: the user just explicitly asked for
                // more history by scrolling up. Trimming the tail they can't
                // even see right now would be invisible and pointless; the
                // append paths (poll / loadNewer) are where unbounded growth
                // actually comes from, so trimming happens there instead.
            } else {
                hasOlder = response.hasMore
            }
        } catch is CancellationError {
            // Expected: the view went away mid-scroll.
        } catch {
            // Not surfaced in the UI — the list still holds what it had, and a
            // banner over a scroll gesture is worse than the gap. Logged so a
            // failing page-back is diagnosable instead of invisible.
            NSLog("loadOlder failed for \(sessionId): \(error.localizedDescription)")
        }
    }

    // MARK: - Load Newer (scroll-to-bottom, when loaded around a target)

    func loadNewer() async {
        guard hasNewer, !isLoadingNewer, let highest = highestSeq else { return }
        isLoadingNewer = true
        defer { isLoadingNewer = false }
        do {
            let response = try await client.fetchMessages(
                sessionId: sessionId, after: highest, limit: 10, summary: true
            )
            let deduped = dedup(response.messages)
            if !deduped.isEmpty {
                messages.append(contentsOf: deduped)
                updateSeqBounds()
                commitAppend(newlyAppended: deduped)
                trimIfNeeded()
            }
            hasNewer = response.hasMore
        } catch is CancellationError {
            // Expected: the view went away mid-scroll.
        } catch {
            NSLog("loadNewer failed for \(sessionId): \(error.localizedDescription)")
        }
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

    /// Fetch new messages since `highestSeq`, catching up across more than
    /// one page in a single tick if a burst left a backlog — bounded by
    /// `MessagePolling.maxPagesPerTick` so a pathological backlog can't block
    /// this `Task` in one long `await` chain. Any remainder is picked up by
    /// the next 5s tick, same shape as `SessionPaging`'s load-more sentinel.
    private func pollForNew() async {
        // Defer while a prepend is in flight: an append committed in the same
        // frame would contaminate the prepend's height-delta compensation.
        // The next poll tick (5s) picks these up.
        guard !isLoadingOlder else { return }

        var pagesFetched = 0
        var hasMore = true
        while hasMore {
            guard let highest = highestSeq else { return }
            do {
                let response = try await client.fetchMessages(
                    sessionId: sessionId, after: highest, limit: 10, summary: true
                )
                let deduped = dedup(response.messages)
                if !deduped.isEmpty {
                    messages.append(contentsOf: deduped)
                    updateSeqBounds()
                    commitAppend(newlyAppended: deduped)
                    trimIfNeeded()
                }
                hasMore = response.hasMore
                pagesFetched += 1
            } catch is CancellationError {
                // Expected: polling stopped.
                return
            } catch {
                // The 5s loop retries, so one failure is not worth a banner — but a
                // live session that quietly stops updating looks identical to one
                // with nothing to say, so it is logged.
                NSLog("poll failed for \(sessionId): \(error.localizedDescription)")
                return
            }
            guard MessagePolling.shouldFetchAnotherPage(hasMore: hasMore, pagesFetched: pagesFetched) else { break }
        }
    }

    // MARK: - Detail Loading

    /// Fetch full input/result for a tool call and update the message in place.
    func loadDetail(for sequence: Int) async {
        guard !loadingDetails.contains(sequence) else { return }
        loadingDetails.insert(sequence)
        // Must be `defer`: the guard above treats a lingering entry as "already
        // loading", so a cancelled fetch would spin that row forever and refuse
        // every retry.
        defer { loadingDetails.remove(sequence) }
        do {
            let detail = try await client.fetchMessageDetail(sessionId: sessionId, sequence: sequence)
            if let idx = messages.firstIndex(where: { $0.sequence == sequence && $0.isToolCall }) {
                messages[idx].input = detail.input
                messages[idx].result = detail.result
                messages[idx].hasDetail = nil
                // Segments hold value copies of Message — rebuild so the expanded
                // row renders the loaded detail. A detail update changes one
                // message in the MIDDLE of the list, not at an edge, so there is
                // no single boundary for appendSegments/prependSegments to patch.
                commit(.detailUpdate)
            }
        } catch is CancellationError {
            // Expected: the row collapsed or the popover closed.
        } catch {
            // Retry by collapsing and re-expanding, which the `defer` above is
            // what actually makes possible.
            NSLog("loadDetail(\(sequence)) failed for \(sessionId): \(error.localizedDescription)")
        }
    }

    // MARK: - Derived

    /// Built once: this is read from `InfoPanel`'s body, so allocating a
    /// formatter per call put it in the render path.
    private static let isoFormatter = ISO8601DateFormatter()

    /// Timestamp of the last message, for the Info panel
    var lastMessageDate: Date? {
        guard let last = messages.last, let iso = last.createdAt else { return nil }
        return Self.isoFormatter.date(from: iso)
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

    /// Drop the oldest messages once the retained count exceeds
    /// `MessageRetention.retainedMessageCap`, rebuilding `segments` fully
    /// (the trim removes from the FRONT, same shape as a prepend, but in
    /// reverse — cheaper to just rebuild than to invent a third patch
    /// direction for something that only happens once every `trimBatchSize`
    /// messages). Forces `hasOlder = true`: real history above the trim
    /// point still exists even if the server had already reported none, and
    /// `loadOlder`'s next page will re-fetch across the trimmed gap.
    ///
    /// Only ever called from the append paths (poll / loadNewer) — see
    /// `loadOlder`'s comment for why a prepend never trims.
    private func trimIfNeeded() {
        let drop = MessageRetention.trimCount(currentCount: messages.count)
        guard drop > 0 else { return }
        let dropped = messages.prefix(drop)
        for msg in dropped {
            seenKeys.remove("\(msg.sequence):\(msg.type)")
        }
        messages.removeFirst(drop)
        hasOlder = true
        updateSeqBounds()
        commit(lastMutation)
    }
}
