import SwiftUI

struct SessionListView: View {
    @Bindable var appState: AppState
    var onSearch: () -> Void = {}
    var onNewSession: () -> Void = {}

    @State private var renamingSessionId: String?
    @State private var renameText: String = ""
    @State private var isRefreshing = false

    private var visibleSessions: [Session] {
        appState.sessions.filter(\.hasMessages)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Barry Sessions")
                    .font(AppFont.sans(size: 13, weight: .semibold))
                Spacer()

                Button(action: onNewSession) {
                    Image(systemName: "plus")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .help("New session")
                .keyboardShortcut("n", modifiers: .command)

                Button(action: onSearch) {
                    Image(systemName: "magnifyingglass")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .help("Search messages")
                .keyboardShortcut("f", modifiers: .command)

                Button {
                    guard !isRefreshing else { return }
                    isRefreshing = true
                    Task {
                        await appState.refreshSessionList()
                        isRefreshing = false
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isRefreshing ? 360 : 0))
                        .animation(isRefreshing ? .linear(duration: 0.6).repeatForever(autoreverses: false) : .default, value: isRefreshing)
                }
                .buttonStyle(.borderless)
                .help("Refresh sessions")
                .disabled(isRefreshing)

                ConnectionBadge(isConnected: appState.isConnected)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider()

            // Session list
            if visibleSessions.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(visibleSessions) { session in
                            SessionRow(
                                session: session,
                                isRenaming: renamingSessionId == session.id,
                                renameText: renamingSessionId == session.id ? $renameText : nil,
                                onStartRename: { startRename(session) },
                                onCommitRename: { commitRename(session) },
                                onCancelRename: { cancelRename() },
                                onTogglePin: { togglePin(session) }
                            )
                            .contentShape(Rectangle())
                            .onTapGesture {
                                if renamingSessionId != session.id {
                                    appState.selectedSessionId = session.id
                                }
                            }
                        }

                        // Load more trigger
                        if appState.hasMoreRecent {
                            if appState.isLoadingMore {
                                ProgressView()
                                    .controlSize(.small)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                            } else {
                                Color.clear
                                    .frame(height: 1)
                                    .onAppear {
                                        Task { await appState.loadMoreRecent() }
                                    }
                            }
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray")
                .font(AppFont.sans(size: 32))
                .foregroundStyle(.tertiary)
            Text("No sessions")
                .font(AppFont.sans(size: 13))
                .foregroundStyle(.secondary)
            Text("Sessions will appear here when running")
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Rename

    private func startRename(_ session: Session) {
        renameText = session.name
        renamingSessionId = session.id
    }

    private func commitRename(_ session: Session) {
        let newName = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !newName.isEmpty, newName != session.name else {
            cancelRename()
            return
        }
        let sessionId = session.id
        renamingSessionId = nil
        Task {
            try? await appState.renameSession(sessionId: sessionId, name: newName)
        }
    }

    private func cancelRename() {
        renamingSessionId = nil
        renameText = ""
    }

    // MARK: - Pin

    private func togglePin(_ session: Session) {
        let newPinned = !(session.pinned ?? false)
        Task {
            try? await appState.togglePin(sessionId: session.id, pinned: newPinned)
        }
    }
}

struct SessionRow: View {
    let session: Session
    let isRenaming: Bool
    var renameText: Binding<String>?
    let onStartRename: () -> Void
    let onCommitRename: () -> Void
    let onCancelRename: () -> Void
    let onTogglePin: () -> Void

    @FocusState private var isRenameFocused: Bool

    private static let isoFormatterFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private func parseISO(_ iso: String) -> Date? {
        Self.isoFormatterFractional.date(from: iso) ?? Self.isoFormatter.date(from: iso)
    }

    private func relativeTimestamp(_ iso: String) -> String {
        guard let date = parseISO(iso) else { return iso }
        let seconds = -date.timeIntervalSinceNow
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h ago" }
        if seconds < 604800 { return "\(Int(seconds / 86400))d ago" }
        let df = DateFormatter()
        df.dateFormat = "MMM d"
        return df.string(from: date)
    }

    private var statusColor: Color {
        if session.isRunning { return .green }
        if session.isPending { return .orange }
        return .secondary.opacity(0.4)
    }

    private func statusUpdateColor(_ phase: String?) -> Color {
        switch phase {
        case "complete": return .green
        case "blocked": return .red
        case "building", "reviewing", "planning": return .blue
        default: return .secondary
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                if isRenaming, let binding = renameText {
                    TextField("Session name", text: binding)
                        .textFieldStyle(.plain)
                        .font(AppFont.sans(size: 13, weight: .medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.primary.opacity(0.06))
                        .overlay(
                            RoundedRectangle(cornerRadius: 5)
                                .strokeBorder(Color.blue, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                        .focused($isRenameFocused)
                        .onSubmit { onCommitRename() }
                        .onExitCommand { onCancelRename() }
                        .onAppear { isRenameFocused = true }
                } else {
                    Text(session.name)
                        .font(AppFont.sans(size: 13, weight: .medium))
                        .lineLimit(1)
                }
                HStack(spacing: 4) {
                    Text(session.displayPath)
                        .lineLimit(1)
                    if let lastMsg = session.lastMessageAt {
                        Text("·")
                        Text(relativeTimestamp(lastMsg))
                    }
                }
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.secondary)

                if let update = session.statusUpdate,
                   let summary = update.summary, !summary.isEmpty {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(statusUpdateColor(update.phase))
                            .frame(width: 5, height: 5)
                        Text(summary)
                            .lineLimit(1)
                    }
                    .font(AppFont.sans(size: 11))
                    .foregroundStyle(.secondary)
                    .help(summary)
                }
            }

            Spacer()

            // Action buttons
            HStack(spacing: 2) {
                Button(action: onStartRename) {
                    Image(systemName: "pencil")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.borderless)
                .help("Rename")

                if session.repoPath != nil {
                    Button {
                        openInBDiff(sessionId: session.id)
                    } label: {
                        Image(systemName: "rectangle.split.2x1")
                            .font(AppFont.sans(size: 11))
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.borderless)
                    .help("Open in BDiff")
                }

                Button(action: onTogglePin) {
                    Image(systemName: session.pinned == true ? "star.fill" : "star")
                        .font(AppFont.sans(size: 11))
                        .foregroundColor(session.pinned == true ? .blue : .secondary.opacity(0.4))
                }
                .buttonStyle(.borderless)
                .help(session.pinned == true ? "Unpin" : "Pin")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(isRenaming ? Color.blue.opacity(0.04) : Color.clear)
        .contentShape(Rectangle())
    }
}

/// Open a session in BDiff via its URL scheme.
func openInBDiff(sessionId: String) {
    if let url = URL(string: "bdiff://session/\(sessionId)") {
        NSWorkspace.shared.open(url)
    }
}

struct ConnectionBadge: View {
    let isConnected: Bool

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(isConnected ? Color.green : Color.red)
                .frame(width: 6, height: 6)
            Text(isConnected ? "Connected" : "Disconnected")
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.secondary)
        }
    }
}
