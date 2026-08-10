import SwiftUI
import AppKit
import BDiffCore

/// Toolbar pill + branch picker popover.
/// Design: design/branch-selector.md, mockup: design/branch-selector-mockup.html
struct BranchDropdown: View {
    @Bindable var appState: AppState
    @State private var showPicker = false
    @State private var showCopied = false

    var body: some View {
        HStack(spacing: 4) {
            Button {
                showPicker.toggle()
            } label: {
                pill
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showPicker, arrowEdge: .bottom) {
                BranchPickerView(appState: appState) { showPicker = false }
            }

            if let name = copyableName {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(name, forType: .string)
                    showCopied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                        showCopied = false
                    }
                } label: {
                    Image(systemName: showCopied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 10))
                        .foregroundStyle(showCopied ? Theme.green : Theme.overlay0)
                        .frame(width: 22, height: 22)
                        .background(Theme.surface0)
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                        .overlay(
                            RoundedRectangle(cornerRadius: 5)
                                .strokeBorder(Theme.surface2.opacity(0.5), lineWidth: 0.5)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Copy branch name")
            }
        }
    }

    /// The branch or session name that can be copied from the toolbar.
    private var copyableName: String? {
        if let sel = appState.selected {
            return sel.entry.name
        }
        return nil
    }

    private var pill: some View {
        HStack(spacing: 7) {
            if appState.selectedSession?.isLive == true || appState.selected?.entry.isLive == true {
                Circle()
                    .fill(Theme.green)
                    .frame(width: 6, height: 6)
                    .shadow(color: Theme.green.opacity(0.55), radius: 3)
            } else if appState.isSessionScope {
                Image(systemName: "diamond.fill")
                    .font(.system(size: 8))
                    .foregroundStyle(Theme.mauve)
            } else {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.subtext1)
            }

            if let session = appState.selectedSession {
                Text(session.repos.joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.subtext1)
                Text("/")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.overlay0)
                Text(session.name)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
            } else if let sel = appState.selected {
                Text(sel.repoName)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.subtext1)
                Text("/")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.overlay0)
                Text(sel.entry.name)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
                    .lineLimit(1)
            } else {
                Text("Select session or branch")
                    .font(.system(size: 12, weight: .medium))
            }

            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Theme.subtext1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Theme.surface0)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(Theme.surface2.opacity(0.5), lineWidth: 0.5)
        )
    }
}

// MARK: - Picker Popover

enum PickerTab: String {
    case sessions, branches
}

struct BranchPickerView: View {
    @Bindable var appState: AppState
    var dismiss: () -> Void

    @State private var filter = ""
    @State private var revealed: [String: Int] = [:]  // repoPath → extra rows paged in
    @State private var keyboardIndex = 0
    @FocusState private var filterFocused: Bool
    @AppStorage("branchPickerWindow") private var windowRaw = TimeWindow.week.rawValue
    @AppStorage("pickerTab") private var tabRaw = PickerTab.sessions.rawValue

    private var window: TimeWindow { TimeWindow(rawValue: windowRaw) ?? .week }
    private var tab: PickerTab { PickerTab(rawValue: tabRaw) ?? .sessions }

    private var sessionRows: [SessionSummary] {
        appState.pickerSessions.filter { SessionVisibility.matches($0, filter: filter) }
    }

    /// Per-repo display state: rows currently shown plus paging info.
    /// `startIndex` is the row's offset in the flattened keyboard order.
    private struct RepoDisplay: Identifiable {
        let repo: RepoBranches
        let rows: [BranchEntry]
        let baseCount: Int
        let remaining: Int
        let startIndex: Int
        var id: String { repo.repoPath }
    }

    private var repoDisplays: [RepoDisplay] {
        var result: [RepoDisplay] = []
        var runningIndex = 0
        for repo in appState.repoGroups {
            let (eligible, rest) = BranchVisibility.split(repo.branches, window: window)
            let combined = eligible + rest
            guard !combined.isEmpty else { continue }
            let base = min(BranchVisibility.pageSize, eligible.count)
            let shown = min(combined.count, base + (revealed[repo.repoPath] ?? 0))
            result.append(RepoDisplay(
                repo: repo,
                rows: Array(combined.prefix(shown)),
                baseCount: base,
                remaining: combined.count - shown,
                startIndex: runningIndex
            ))
            runningIndex += shown
        }
        return result
    }

    private var filterMatches: [(repo: RepoBranches, entry: BranchEntry)] {
        let needle = filter.lowercased()
        return appState.repoGroups.flatMap { repo in
            repo.branches
                .filter { $0.name.lowercased().contains(needle) || repo.repoName.lowercased().contains(needle) }
                .map { (repo, $0) }
        }
    }

    /// Rows in display order — drives ↑↓/↩ keyboard navigation.
    private var keyboardRows: [(repo: RepoBranches, entry: BranchEntry)] {
        if filter.isEmpty {
            return repoDisplays.flatMap { display in
                display.rows.map { (display.repo, $0) }
            }
        }
        return filterMatches
    }

    private var keyboardRowCount: Int {
        tab == .sessions ? sessionRows.count : keyboardRows.count
    }

    var body: some View {
        VStack(spacing: 0) {
            tabBar
            Divider()
            filterField
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    if tab == .sessions {
                        sessionsList
                    } else if filter.isEmpty {
                        groupedList
                    } else {
                        filteredList
                    }
                }
                .frame(maxHeight: 480)
                .onChange(of: keyboardIndex) { _, index in
                    // Keep the keyboard highlight visible on long lists
                    proxy.scrollTo("kb-\(index)", anchor: nil)
                }
            }
            if tab == .branches {
                Divider()
                windowBar
            }
        }
        .frame(width: 390)
        .onAppear { filterFocused = true }
        .onChange(of: filter) { _, _ in keyboardIndex = 0 }
        .onChange(of: tabRaw) { _, _ in keyboardIndex = 0 }
        .onChange(of: windowRaw) { _, _ in
            revealed = [:]
            keyboardIndex = 0
        }
    }

    // MARK: Tabs

    private var tabBar: some View {
        HStack(spacing: 3) {
            tabButton("Sessions", .sessions)
            tabButton("Branches", .branches)
        }
        .padding(4)
        .frame(maxWidth: .infinity)
    }

    private func tabButton(_ title: String, _ value: PickerTab) -> some View {
        Button {
            tabRaw = value.rawValue
        } label: {
            Text(title)
                .font(.system(size: 11.5, weight: tab == value ? .semibold : .regular))
                .foregroundStyle(tab == value ? Theme.text : Theme.overlay1)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 5)
                        .fill(tab == value ? Theme.surface1 : Color.clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Sessions list

    private var sessionsList: some View {
        let rows = sessionRows
        return LazyVStack(alignment: .leading, spacing: 0) {
            if rows.isEmpty {
                Text(filter.isEmpty ? "No sessions" : "No matches")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.overlay0)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 34)
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, session in
                    SessionRow(
                        session: session,
                        isSelected: appState.selectedSession?.id == session.id,
                        isKeyboardTarget: index == keyboardIndex
                    ) { select(session) }
                    .id("kb-\(index)")
                }
            }
        }
        .padding(.vertical, 8)
    }

    // MARK: Filter field

    private var filterField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(Theme.overlay0)
            TextField(tab == .sessions ? "Filter sessions" : "Filter branches", text: $filter)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .focused($filterFocused)
                .onKeyPress(.downArrow) {
                    keyboardIndex = min(keyboardIndex + 1, max(0, keyboardRowCount - 1))
                    return .handled
                }
                .onKeyPress(.upArrow) {
                    keyboardIndex = max(keyboardIndex - 1, 0)
                    return .handled
                }
                .onSubmit {
                    if tab == .sessions {
                        let rows = sessionRows
                        guard rows.indices.contains(keyboardIndex) else { return }
                        select(rows[keyboardIndex])
                    } else {
                        let rows = keyboardRows
                        guard rows.indices.contains(keyboardIndex) else { return }
                        let row = rows[keyboardIndex]
                        select(row.repo, row.entry)
                    }
                }
        }
        .padding(.horizontal, 13)
        .frame(height: 38)
    }

    // MARK: Grouped list (default)

    private var groupedList: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(repoDisplays) { display in
                repoHeader(display.repo)

                ForEach(Array(display.rows.enumerated()), id: \.element.id) { offset, entry in
                    BranchRow(
                        entry: entry,
                        isSelected: isSelected(display.repo, entry),
                        isKeyboardTarget: display.startIndex + offset == keyboardIndex,
                        repoPrefix: nil
                    ) { select(display.repo, entry) }
                    .id("kb-\(display.startIndex + offset)")
                }

                pagingRow(display)

                if display.id != repoDisplays.last?.id {
                    Divider().padding(.top, 8)
                }
            }
        }
        .padding(.vertical, 8)
    }

    private func repoHeader(_ repo: RepoBranches) -> some View {
        Text(repo.repoName.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(0.8)
            .foregroundStyle(Theme.overlay0)
            .padding(.horizontal, 21)
            .padding(.top, 10)
            .padding(.bottom, 4)
    }

    @ViewBuilder
    private func pagingRow(_ display: RepoDisplay) -> some View {
        if display.remaining > 0 {
            pagingButton("show \(min(BranchVisibility.pageSize, display.remaining)) more") {
                revealed[display.repo.repoPath, default: 0] += BranchVisibility.pageSize
            }
        } else if display.rows.count > display.baseCount {
            pagingButton("show less") {
                revealed[display.repo.repoPath] = nil
            }
        }
    }

    private func pagingButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 10.5))
                .foregroundStyle(Theme.overlay0)
                .padding(.horizontal, 13)
                .frame(height: 24)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, 21)
    }

    // MARK: Filtered list (flattened across repos)

    private var filteredList: some View {
        let matches = filterMatches

        return LazyVStack(alignment: .leading, spacing: 0) {
            if matches.isEmpty {
                Text("No matches")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.overlay0)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 34)
            } else {
                ForEach(Array(matches.enumerated()), id: \.offset) { index, match in
                    BranchRow(
                        entry: match.entry,
                        isSelected: isSelected(match.repo, match.entry),
                        isKeyboardTarget: index == keyboardIndex,
                        repoPrefix: match.repo.repoName
                    ) { select(match.repo, match.entry) }
                    .id("kb-\(index)")
                }
            }
        }
        .padding(.vertical, 8)
    }

    // MARK: Activity window bar

    private var windowBar: some View {
        HStack(spacing: 3) {
            Text("activity window")
                .font(.system(size: 10))
                .foregroundStyle(Theme.overlay0)
            Spacer()
            ForEach(TimeWindow.allCases, id: \.rawValue) { option in
                Button {
                    windowRaw = option.rawValue
                } label: {
                    Text(option.label)
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(option == window ? Theme.text : Theme.overlay1)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(
                            RoundedRectangle(cornerRadius: 5)
                                .fill(option == window ? Theme.surface1 : Color.clear)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 13)
        .frame(height: 32)
    }

    // MARK: Actions

    private func isSelected(_ repo: RepoBranches, _ entry: BranchEntry) -> Bool {
        appState.selected?.repoPath == repo.repoPath && appState.selected?.entry.name == entry.name
    }

    private func select(_ repo: RepoBranches, _ entry: BranchEntry) {
        appState.selectBranch(repo: repo, entry: entry)
        dismiss()
    }

    private func select(_ session: SessionSummary) {
        appState.selectSession(session)
        dismiss()
    }
}

// MARK: - Session Row

private struct SessionRow: View {
    let session: SessionSummary
    let isSelected: Bool
    var isKeyboardTarget = false
    let action: () -> Void

    @State private var isHovered = false
    @State private var pulsing = false

    /// Ended sessions with no file changes are dimmed — selecting them
    /// shows an empty diff, but they're still reachable.
    private var isDimmed: Bool {
        !session.isLive && session.hasChanges == false
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "diamond.fill")
                    .font(.system(size: 7))
                    .foregroundStyle(isDimmed ? Theme.overlay0 : Theme.mauve.opacity(0.8))
                    .frame(width: 13)

                Text(session.name)
                    .font(.system(size: 11.5))
                    .foregroundStyle(isDimmed ? Theme.overlay0 : Theme.text)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Text(session.repos.joined(separator: " · "))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(isDimmed ? Theme.overlay0 : Theme.overlay1)
                    .lineLimit(1)

                Spacer(minLength: 8)

                if session.isLive {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(Theme.green)
                            .frame(width: 6, height: 6)
                            .shadow(color: Theme.green.opacity(0.5), radius: 3)
                            .opacity(pulsing ? 0.4 : 1)
                            .onAppear {
                                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                                    pulsing = true
                                }
                            }
                        Text("live")
                            .font(.system(size: 10))
                            .foregroundStyle(Theme.subtext1)
                    }
                } else if let ago = session.endedAgo {
                    Text("ended \(ago)")
                        .font(.system(size: 10))
                        .monospacedDigit()
                        .foregroundStyle(Theme.overlay0)
                }

                Text(isSelected ? "✓" : "")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 12)
            }
            .padding(.horizontal, 13)
            .frame(height: 30)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isSelected ? Theme.accent.opacity(0.14)
                          : (isHovered || isKeyboardTarget) ? Theme.surface1.opacity(0.5)
                          : Color.clear)
            )
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}

// MARK: - Row

private struct BranchRow: View {
    let entry: BranchEntry
    let isSelected: Bool
    var isKeyboardTarget = false
    let repoPrefix: String?
    let action: () -> Void

    @State private var isHovered = false
    @State private var pulsing = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                // Activity slot: the live dot is the only loud element
                ZStack {
                    if entry.isLive {
                        Circle()
                            .fill(Theme.green)
                            .frame(width: 6, height: 6)
                            .shadow(color: Theme.green.opacity(0.5), radius: 3)
                            .opacity(pulsing ? 0.4 : 1)
                            .onAppear {
                                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                                    pulsing = true
                                }
                            }
                    }
                }
                .frame(width: 13)

                Group {
                    if let repoPrefix {
                        Text("\(repoPrefix) / ").foregroundStyle(Theme.overlay0)
                        + Text(entry.name).foregroundStyle(entry.isAgent ? Theme.subtext1 : Theme.text)
                    } else {
                        Text(entry.name)
                            .foregroundStyle(entry.isAgent ? Theme.subtext1 : Theme.text)
                    }
                }
                .font(.system(size: 11.5, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.tail)

                if entry.isAgent {
                    Text("✦")
                        .font(.system(size: 9))
                        .foregroundStyle(Theme.mauve.opacity(0.7))
                }

                Spacer(minLength: 8)

                if entry.kind == .worktree || entry.kind == .checkout {
                    if entry.kind == .worktree {
                        Text("wt")
                            .font(.system(size: 9, design: .monospaced))
                            .tracking(0.5)
                            .foregroundStyle(isHovered || isSelected ? Theme.orange.opacity(0.8) : Theme.overlay1)
                            .help(entry.worktreePath ?? "worktree")
                    }
                }

                if let date = entry.lastCommitDate {
                    Text(RelativeTime.short(from: date))
                        .font(.system(size: 10.5))
                        .monospacedDigit()
                        .foregroundStyle(Theme.overlay0)
                        .frame(minWidth: 26, alignment: .trailing)
                }

                Text(isSelected ? "✓" : "")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 12)
            }
            .padding(.horizontal, 13)
            .frame(height: 30)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isSelected ? Theme.accent.opacity(0.14)
                          : (isHovered || isKeyboardTarget) ? Theme.surface1.opacity(0.5)
                          : Color.clear)
            )
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .contextMenu {
            Button("Copy Branch Name") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(entry.name, forType: .string)
            }
        }
    }
}
