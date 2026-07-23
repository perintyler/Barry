import SwiftUI

struct ContentView: View {
    @Bindable var appState: AppState
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            if appState.isSessionScope {
                sessionHeaderBar
                Divider()
            }
            HSplitView {
                if appState.mode == .history {
                    CommitListView(appState: appState)
                        .frame(minWidth: 200, idealWidth: 260, maxWidth: 360)
                }
                FileSidebar(appState: appState)
                    .frame(minWidth: 180, idealWidth: 240, maxWidth: 320)
                DiffContentView(appState: appState)
                    .frame(minWidth: 400)
            }
            Divider()
            bottomBar
        }
        .background(Theme.base)
        .task { await appState.start() }
        .onChange(of: colorScheme) { _, newScheme in
            // Syntax highlight colors are theme-specific — recompute on appearance change
            appState.highlightCurrentFiles(isDark: newScheme == .dark)
        }
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack(spacing: 12) {
            BranchDropdown(appState: appState)

            Spacer()

            // Session scope has one content view (Changes, stream) — no mode
            // tabs, no view toggle
            if !appState.isSessionScope {
                // Mode picker (Working is a no-op for plain refs — no directory to diff)
                Picker("Mode", selection: Binding(
                    get: { appState.mode },
                    set: { appState.switchMode($0) }
                )) {
                    ForEach(DiffMode.allCases, id: \.self) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 240)
                .help(appState.selected?.entry.isCheckedOut == false
                      ? "Working mode unavailable — branch is not checked out"
                      : "")

                Spacer()

                // View toggle (stream / file)
                HStack(spacing: 0) {
                    viewToggleButton(
                        icon: "list.bullet",
                        mode: .stream,
                        tooltip: "Stream — all files"
                    )
                    viewToggleButton(
                        icon: "doc.text",
                        mode: .file,
                        tooltip: "File — one at a time"
                    )
                }
                .background(Theme.surface0)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(Theme.surface2.opacity(0.5), lineWidth: 0.5)
                )
            }

            // Live indicator
            if appState.selected?.entry.isLive == true {
                HStack(spacing: 5) {
                    Circle()
                        .fill(Theme.green)
                        .frame(width: 7, height: 7)
                    Text("Live")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.subtext1)
                }
            }

            Button(action: { appState.refresh() }) {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12))
            }
            .buttonStyle(.borderless)
            .disabled(appState.isLoading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(height: 44)
    }

    // MARK: - Session Header

    /// Minimal session context: `◆ name  +adds −dels · N files · N repos`
    private var sessionHeaderBar: some View {
        HStack(spacing: 10) {
            if let session = appState.selectedSession {
                HStack(spacing: 7) {
                    Image(systemName: "diamond.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(Theme.mauve)
                    Text(session.name)
                        .font(.system(size: 13, weight: .semibold))
                }

                if !appState.files.isEmpty {
                    HStack(spacing: 6) {
                        Text("+\(appState.totalInsertions)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Theme.added)
                        Text("-\(appState.totalDeletions)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Theme.deleted)
                        Text("· \(appState.files.count) file\(appState.files.count == 1 ? "" : "s")")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.overlay1)
                        if appState.sessionRepoCount > 1 {
                            Text("· \(appState.sessionRepoCount) repos")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.overlay1)
                        }
                    }
                }
            }

            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(Theme.mantle)
    }

    private func viewToggleButton(icon: String, mode: ViewMode, tooltip: String) -> some View {
        Button(action: { appState.viewMode = mode }) {
            Image(systemName: icon)
                .font(.system(size: 11))
                .frame(width: 28, height: 22)
                .foregroundStyle(appState.viewMode == mode ? Theme.text : Theme.overlay0)
                .background(appState.viewMode == mode ? Theme.surface1 : Color.clear)
        }
        .buttonStyle(.plain)
        .help(tooltip)
    }

    // MARK: - Bottom Bar

    private var bottomBar: some View {
        HStack(spacing: 12) {
            if let session = appState.selectedSession {
                HStack(spacing: 4) {
                    Circle()
                        .fill(session.isLive ? Theme.green : Theme.gray)
                        .frame(width: 6, height: 6)
                    Text(session.isLive
                        ? "Running"
                        : "Ended\(session.endedAgo.map { " \($0) ago" } ?? "")")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.subtext1)
                }
            } else if let sel = appState.selected {
                HStack(spacing: 4) {
                    Circle()
                        .fill(sel.entry.isLive ? Theme.green : Theme.gray)
                        .frame(width: 6, height: 6)
                    Text(sel.entry.isLive ? "Running" : "Idle")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.subtext1)
                }

                if !sel.entry.isCheckedOut {
                    Text("ref only")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.overlay0)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Theme.surface1.opacity(0.5))
                        .clipShape(RoundedRectangle(cornerRadius: 3))
                        .help("Not checked out — committed changes only")
                }

                if let base = appState.baseBranch, let current = appState.currentBranch {
                    Text("\(current) vs \(base)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.overlay0)
                }
            }

            Spacer()

            if !appState.files.isEmpty {
                Text("\(appState.files.count) file\(appState.files.count == 1 ? "" : "s")")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.subtext1)

                HStack(spacing: 6) {
                    Text("+\(appState.totalInsertions)")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(Theme.added)
                    Text("-\(appState.totalDeletions)")
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(Theme.deleted)
                }
            }

            if let time = appState.lastRefresh {
                Text(time, style: .relative)
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.overlay0)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .frame(height: 28)
    }
}
