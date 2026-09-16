import Components
import SwiftUI

/// Pending approvals, and the two buttons that answer them.
///
/// This exists because a banner is missable — it can be swiped away, arrive
/// while the screen is locked, or be suppressed entirely if notification
/// permission was never granted. An agent blocked on a decision needs a
/// surface that does not depend on catching a transient alert.
public struct ApprovalsView: View {
    @ObservedObject var state: ApprovalsState

    public init(state: ApprovalsState) {
        self.state = state
    }

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                // A banner that never appeared is not the same as no request:
                // the agent is blocked either way, but only one of them means
                // the user will never be told.
                if let warning = state.deliveryWarning, !state.pending.isEmpty {
                    Text(warning)
                        .font(.caption)
                        .foregroundStyle(Palette.amber)
                        .padding(12)
                }

                if let message = state.errorMessage {
                    // Distinct from "nothing pending": if the service is
                    // unreachable, an empty list would read as "all clear"
                    // while an agent sits blocked.
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(Palette.amber)
                        .padding(12)
                } else if state.pending.isEmpty && state.hasLoadedOnce {
                    Text("Nothing waiting on you.")
                        .font(.callout)
                        .foregroundStyle(Color.secondary)
                        .padding(12)
                }

                ForEach(state.pending) { approval in
                    ApprovalRow(approval: approval) { approved in
                        Task { await state.decide(id: approval.id, approved: approved) }
                    }
                    Divider()
                }
            }
        }
        .background(Palette.windowBackground)
        .task { await state.refresh() }
    }
}

struct ApprovalRow: View {
    let approval: Approval
    let onDecide: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(approval.requester)
                .font(.caption)
                .foregroundStyle(Color.secondary)

            Text(approval.subject)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Button("Approve") { onDecide(true) }
                    .buttonStyle(.borderedProminent)
                Button("Deny") { onDecide(false) }
                    .buttonStyle(.bordered)
                Spacer()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
    }
}
