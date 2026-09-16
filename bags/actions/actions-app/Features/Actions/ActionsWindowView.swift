import Components
import SwiftUI

public struct ActionsWindowView: View {
    @State private var state: ActionsState
    @State private var showingTrigger = false

    /// The state is injected rather than defaulted: `ActionsState` is
    /// `@MainActor`, and a default argument is evaluated in a nonisolated
    /// context, so `= ActionsState()` does not compile under Swift 6
    /// isolation checking. The app delegate owns the instance anyway.
    public init(state: ActionsState) {
        _state = State(wrappedValue: state)
    }

    public var body: some View {
        NavigationSplitView {
            RunListView(state: state, showingTrigger: $showingTrigger)
                .navigationSplitViewColumnWidth(min: 280, ideal: 340)
        } detail: {
            RunDetailView(state: state)
        }
        .background(Palette.windowBackground)
        // NavigationSplitView reports no intrinsic content size, and an
        // NSHostingController sizes itself from that — the window came up
        // 1x80pt, technically "running" while showing nothing. A minimum
        // frame is what makes the configured contentRect hold.
        .frame(minWidth: 720, minHeight: 420)
        .task { await state.load() }
        .sheet(isPresented: $showingTrigger) {
            TriggerSheet(state: state) {
                showingTrigger = false
                state.dismissTrigger()
            }
        }
    }
}

// MARK: - List

struct RunListView: View {
    @Bindable var state: ActionsState
    @Binding var showingTrigger: Bool

    var body: some View {
        VStack(spacing: 0) {
            header

            switch state.runs {
            case .idle, .loading:
                Spacer()
                ProgressView().controlSize(.small)
                Spacer()

            // Distinct from .loaded([]) below — this is the state that must
            // never be allowed to look like an empty list.
            case let .failed(message):
                FetchFailureView(message: message) {
                    Task { await state.load() }
                }

            case let .loaded(runs) where runs.isEmpty:
                Spacer()
                VStack(spacing: 6) {
                    Text("No runs recorded")
                        .font(AppFont.sans(size: 13, weight: .medium))
                    Text(state.actionFilter.map { "Nothing has run \($0) yet." }
                        ?? "Runs appear here once an action is used.")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.secondary)
                }
                Spacer()

            case let .loaded(runs):
                List(runs, selection: $state.selectedRunId) { run in
                    RunRow(run: run).tag(run.id)
                }
                .listStyle(.sidebar)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Picker("", selection: $state.actionFilter) {
                Text("All actions").tag(String?.none)
                ForEach(state.knownActions, id: \.self) { action in
                    Text(action).tag(String?.some(action))
                }
            }
            .labelsHidden()
            .controlSize(.small)

            Spacer()

            Button {
                showingTrigger = true
            } label: {
                Image(systemName: "play.circle")
            }
            .buttonStyle(.borderless)
            .help("Run an action")
            .accessibilityIdentifier("TriggerActionButton")

            Button {
                Task { await state.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .disabled(state.runs.isLoading)
            .help("Refresh")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

struct RunRow: View {
    let run: RunSummary

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            StatusDot(status: run.status)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(run.action)
                        .font(AppFont.sans(size: 12, weight: .medium))
                        .lineLimit(1)
                    if run.hasOutput {
                        // Matches `barry action runs`, which marks a run
                        // carrying a deliverable with the same glyph.
                        Text("✎")
                            .font(AppFont.sans(size: 10))
                            .foregroundStyle(.secondary)
                            .help("Has a recorded deliverable")
                    }
                }

                if let summary = run.summary {
                    Text(summary)
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Text(RelativeTime.describe(run.startedAt))
                    .font(AppFont.sans(size: 10))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 3)
    }
}

struct StatusDot: View {
    let status: RunStatus

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .padding(.top, 4)
            .help(label)
    }

    private var color: Color {
        switch status {
        case .started: return Palette.amber
        case .complete: return Palette.green
        case .failed: return Palette.red
        }
    }

    // "failed" and "still open" are different problems and must not read the
    // same — see RunStatus.
    private var label: String {
        switch status {
        case .started: return "Started — never closed"
        case .complete: return "Complete"
        case .failed: return "Closed, but a declared check did not hold"
        }
    }
}

// MARK: - Shared

struct FetchFailureView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 22))
                .foregroundStyle(Palette.amber)
            Text("Could not load")
                .font(AppFont.sans(size: 13, weight: .medium))
            Text(message)
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button("Retry", action: retry)
                .controlSize(.small)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

enum RelativeTime {
    static func describe(_ date: Date, now: Date = Date()) -> String {
        let seconds = Int(now.timeIntervalSince(date).rounded())
        if seconds < 60 { return "\(max(seconds, 0))s ago" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        return "\(hours / 24)d ago"
    }

    static func duration(_ interval: TimeInterval) -> String {
        interval < 60
            ? String(format: "%.1fs", interval)
            : "\(Int(interval) / 60)m \(Int(interval) % 60)s"
    }
}
