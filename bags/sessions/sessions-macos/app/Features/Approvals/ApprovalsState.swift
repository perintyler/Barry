import BarryKit
import BarrySessionsCore
import Components
import SwiftUI

/// Pending-approval state: what the user has been asked, and their answer.
///
/// Kept apart from `EventsState` on purpose. An event is something that already
/// happened; an approval is an agent **blocked right now**, and the two should
/// not compete for the same attention or the same list.
@MainActor
public final class ApprovalsState: ObservableObject {
    @Published public private(set) var pending: [Approval] = []
    @Published public private(set) var errorMessage: String?
    /// Distinguishes "nothing pending" from "we cannot tell".
    @Published public private(set) var hasLoadedOnce = false
    /// Set when a banner could not be posted -- denied or alerts disabled.
    /// Surfaced in the view, because an approval nobody can see blocks an agent
    /// indefinitely and would otherwise look like an unanswered question.
    @Published public private(set) var deliveryWarning: String?

    private let client: ApprovalsClient
    private var timer: Timer?
    /// Requests already banner-ed, so a refresh does not re-announce them.
    private var notified: Set<String> = []

    /// How often to re-check.
    ///
    /// Polling rather than riding the realtime bus, deliberately. The approvals
    /// service is a separate process and `publishToTopic` is only callable
    /// in-process, so pushing would mean a new authenticated publish route on
    /// the API — a cross-service write path any secret-holder could use to
    /// spoof any topic. That is a lot of surface to buy a few seconds.
    ///
    /// 5s against a localhost service is ~12 requests a minute, and the banner
    /// fires on the poll that finds the request, so worst-case latency from
    /// request to notification is one interval.
    private let pollInterval: TimeInterval = 5

    public init(baseURL: URL? = nil, secret: String? = nil) {
        let core = BarryCore()
        let resolved = baseURL ?? URL(string: "http://127.0.0.1:3866")!
        self.client = ApprovalsClient(baseURL: resolved, secret: secret ?? core.authToken)
    }

    public func start() {
        // Do not inherit whatever grant the events feed happened to obtain --
        // if that never ran, approval banners silently did nothing.
        ApprovalNotification.requestAuthorizationIfNeeded()
        Task { await refresh() }
        let timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
    }

    public func refresh() async {
        do {
            let latest = try await client.pending()
            let live = Set(latest.map(\.id))

            // Banner anything new. Posting before updating `pending` would risk
            // announcing a request the list never shows.
            for approval in latest where !notified.contains(approval.id) {
                ApprovalNotification.submit(approval) { [weak self] reason in
                    Task { @MainActor in self?.deliveryWarning = reason }
                }
                notified.insert(approval.id)
            }

            // Pull banners for requests that are no longer pending — decided
            // elsewhere, or expired. A button that silently does nothing reads
            // as a broken app.
            for id in notified.subtracting(live) {
                ApprovalNotification.withdraw(id: id)
            }
            notified.formIntersection(live)

            pending = latest
            errorMessage = nil
            hasLoadedOnce = true
        } catch {
            // Surfaced rather than swallowed: if this list is silently empty
            // because the service is unreachable, the user sees "nothing to
            // approve" while an agent sits blocked.
            errorMessage = "Cannot reach the approvals service."
        }
    }

    public func decide(id: String, approved: Bool, decidedBy: String = "app") async {
        do {
            _ = try await client.decide(id: id, approved: approved, decidedBy: decidedBy)
        } catch {
            errorMessage = "Could not record the decision."
        }
        // Refresh either way. On a 409 the request was already settled, and the
        // list must show the verdict that actually stands rather than the one
        // just attempted.
        ApprovalNotification.withdraw(id: id)
        await refresh()
    }
}
