import SwiftUI

struct SessionDetailView: View {
    let session: Session
    let scrollToSequence: Int?
    let onBack: () -> Void
    let onSessionUpdated: () -> Void

    @State private var editor: SessionEditor
    @State private var messagesState: MessagesState

    init(session: Session, scrollToSequence: Int? = nil, onBack: @escaping () -> Void, onSessionUpdated: @escaping () -> Void = {}) {
        self.session = session
        self.scrollToSequence = scrollToSequence
        self.onBack = onBack
        self.onSessionUpdated = onSessionUpdated
        self._editor = State(initialValue: SessionEditor(session: session))
        self._messagesState = State(initialValue: MessagesState(
            sessionId: session.id,
            isRunning: session.isRunning,
            targetSequence: scrollToSequence
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Nav header
            HStack(spacing: 8) {
                Button(action: onBack) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(AppFont.sans(size: 11))
                        Text("Sessions")
                            .font(AppFont.sans(size: 13))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.blue)

                Text(session.name)
                    .font(AppFont.sans(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()

                Button {
                    Task { await messagesState.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(AppFont.sans(size: 12))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.borderless)
                .help("Refresh messages")

                if session.repoPath != nil {
                    Button {
                        openInBDiff(sessionId: session.id)
                    } label: {
                        Image(systemName: "rectangle.split.2x1")
                            .font(AppFont.sans(size: 12))
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.borderless)
                    .help("Open in BDiff")
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider()

            // Top-level tabs: Messages | Tooling | Info
            Picker("", selection: $editor.topTab) {
                ForEach(SessionEditor.TopTab.allCases, id: \.self) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 6)

            // Tab content
            switch editor.topTab {
            case .messages:
                messagesContent
            case .tooling:
                toolingContent
            case .info:
                InfoPanel(
                    session: session,
                    messagesState: messagesState,
                    onSessionUpdated: onSessionUpdated
                )
            }
        }
        .task {
            async let loadTools: () = editor.load()
            async let loadMsgs: () = messagesState.loadInitial()
            _ = await (loadTools, loadMsgs)
        }
        .onDisappear {
            messagesState.stopPolling()
        }
    }

    // MARK: - Messages

    // Invariant: MessagesPanel is only mounted after the initial load completes
    // (the `isLoadingInitial` branch below). MessagesPanel.init relies on this —
    // it resolves the deep-link scroll target from `state.segments`, which exist
    // only once messages have loaded.
    @ViewBuilder
    private var messagesContent: some View {
        if messagesState.isLoadingInitial {
            Spacer()
            ProgressView()
                .controlSize(.small)
            Spacer()
        } else if let err = messagesState.errorMessage {
            Spacer()
            VStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .font(AppFont.sans(size: 24))
                    .foregroundStyle(.tertiary)
                Text(err)
                    .font(AppFont.sans(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(20)
            Spacer()
        } else if messagesState.messages.isEmpty {
            Spacer()
            VStack(spacing: 8) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(AppFont.sans(size: 24))
                    .foregroundStyle(.tertiary)
                Text("No messages yet")
                    .font(AppFont.sans(size: 13))
                    .foregroundStyle(.secondary)
            }
            Spacer()
        } else {
            if session.isRunning {
                RunningIndicator()
            }
            MessagesPanel(state: messagesState, scrollToSequence: scrollToSequence)
        }
    }

    // MARK: - Tooling

    @ViewBuilder
    private var toolingContent: some View {
        // Sub-tabs: Traits | Namespaces | Tools (underline style in SwiftUI)
        HStack(spacing: 0) {
            ForEach(SessionEditor.ToolingTab.allCases, id: \.self) { tab in
                toolingSubTab(tab)
            }
        }
        .padding(.horizontal, 16)
        .overlay(alignment: .bottom) {
            Divider()
        }

        // Filter
        HStack {
            Image(systemName: "magnifyingglass")
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.tertiary)
            TextField("Filter...", text: $editor.filterText)
                .textFieldStyle(.plain)
                .font(AppFont.sans(size: 12))
            if !editor.filterText.isEmpty {
                Button {
                    editor.filterText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 4)

        // Content
        ScrollView {
            switch editor.toolingTab {
            case .traits:
                TraitsPanel(editor: editor)
            case .namespaces:
                NamespacesPanel(editor: editor)
            case .tools:
                ToolsPanel(editor: editor)
            }
        }

        // Pending changes bar
        if editor.hasPendingChanges {
            PendingChangesBar(
                changeCount: editor.pendingChangeCount,
                onReset: { editor.reset() },
                onApply: { Task { await editor.apply() } }
            )
        }
    }

    private func toolingSubTab(_ tab: SessionEditor.ToolingTab) -> some View {
        let isActive = editor.toolingTab == tab
        let count: Int = {
            switch tab {
            case .traits: return editor.selectedTraits.count
            case .namespaces: return editor.selectedNamespaces.count
            case .tools: return editor.selectedTools.count
            }
        }()

        return Button {
            editor.toolingTab = tab
            editor.filterText = ""
        } label: {
            VStack(spacing: 0) {
                HStack(spacing: 3) {
                    Text(tab.rawValue)
                        .font(AppFont.sans(size: 11, weight: .medium))
                    if count > 0 {
                        Text("\(count)")
                            .font(AppFont.sans(size: 10, weight: .semibold))
                            .foregroundStyle(.green)
                    }
                }
                .foregroundStyle(isActive ? .primary : .tertiary)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)

                Rectangle()
                    .fill(isActive ? Color.primary : Color.clear)
                    .frame(height: 2)
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Running Indicator

private struct RunningIndicator: View {
    @State private var isPulsing = false

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color.green)
                .frame(width: 6, height: 6)
                .opacity(isPulsing ? 0.4 : 1.0)
                .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true), value: isPulsing)
                .onAppear { isPulsing = true }
            Text("Running")
                .font(AppFont.sans(size: 11))
                .foregroundStyle(Color.green.opacity(0.7))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.green.opacity(0.06))
        .overlay(alignment: .bottom) {
            Divider().background(Color.green.opacity(0.1))
        }
    }
}
