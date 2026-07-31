import SwiftUI
import BDiffCore

/// Flat row type for truly lazy rendering — one level of ForEach.
private struct FlatRow: Identifiable {
    enum Kind {
        case fileHeader(DiffFile)
        case hunkHeader(DiffHunk, file: DiffFile, index: Int)
        case line(DiffLine, file: DiffFile)
        case commentThread(CommentAnchor, [ReviewComment])
        case composer(CommentAnchor, lineContent: String)
        case expandDown(DiffFile)
    }
    let id: String
    let kind: Kind
}

struct DiffContentView: View {
    @Bindable var appState: AppState

    var body: some View {
        if appState.isLoading && appState.files.isEmpty {
            loadingView
        } else if let error = appState.error {
            errorView(error)
        } else if appState.files.isEmpty {
            emptyView
        } else {
            switch appState.viewMode {
            case .stream:
                streamView
            case .file:
                fileView
            }
        }
    }

    // MARK: - Stream View

    /// Flatten files → hunks → lines into a single array for true LazyVStack performance.
    private var streamRows: [FlatRow] {
        var rows: [FlatRow] = []
        rows.reserveCapacity(appState.files.count * 20) // rough estimate
        for file in appState.files {
            rows.append(FlatRow(id: "fh-\(file.id)", kind: .fileHeader(file)))
            if !appState.isCollapsed(file.id) {
                for (index, hunk) in file.hunks.enumerated() {
                    rows.append(FlatRow(id: "hh-\(file.id)-\(hunk.id)", kind: .hunkHeader(hunk, file: file, index: index)))
                    for line in hunk.lines {
                        rows.append(FlatRow(id: "ln-\(line.id)", kind: .line(line, file: file)))
                        appendCommentRows(for: line, file: file, to: &rows)
                    }
                }
                if appState.canExpandDown(file) {
                    rows.append(FlatRow(id: "xd-\(file.id)", kind: .expandDown(file)))
                }
            }
        }
        return rows
    }

    /// Append the comment thread and/or composer rows attached to a diff line.
    private func appendCommentRows(for line: DiffLine, file: DiffFile, to rows: inout [FlatRow]) {
        guard let anchor = CommentAnchor(filePath: file.displayPath, repoPath: file.repoPath, diffLine: line) else { return }
        if let thread = appState.commentsByAnchor[anchor], !thread.isEmpty {
            rows.append(FlatRow(id: "ct-\(line.id)", kind: .commentThread(anchor, thread)))
        }
        if appState.composingAnchor == anchor {
            rows.append(FlatRow(id: "cc-\(line.id)", kind: .composer(anchor, lineContent: line.content)))
        }
    }

    private var streamView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(streamRows) { row in
                        switch row.kind {
                        case .fileHeader(let file):
                            streamFileHeader(file)
                                .id("file-\(file.id)")
                        case .hunkHeader(let hunk, let file, let index):
                            hunkHeader(hunk, file: file, index: index)
                        case .line(let line, let file):
                            diffLine(line, file: file)
                        case .commentThread(_, let thread):
                            CommentThreadView(appState: appState, comments: thread)
                        case .composer(_, let lineContent):
                            CommentComposerView(appState: appState, lineContent: lineContent)
                        case .expandDown(let file):
                            expandDownRow(file)
                        }
                    }
                }
                .padding(.bottom, 20)
                .textSelection(.enabled)
            }
            .onChange(of: appState.selectedFileId) { _, fileId in
                if let fileId {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        proxy.scrollTo("file-\(fileId)", anchor: .top)
                    }
                }
            }
        }
        .background(Theme.mantle)
    }

    private func streamFileHeader(_ file: DiffFile) -> some View {
        HStack(spacing: 8) {
            Image(systemName: appState.isCollapsed(file.id) ? "chevron.right" : "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Theme.overlay0)
                .frame(width: 14)

            statusBadge(file.status)

            // Session diffs can span repos — prefix the owning repo
            if let repoName = file.repoName {
                Text("\(repoName) ›")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Theme.overlay0)
            }

            Text(file.displayPath)
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer()

            HStack(spacing: 6) {
                if file.insertions > 0 {
                    Text("+\(file.insertions)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.added)
                }
                if file.deletions > 0 {
                    Text("-\(file.deletions)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Theme.deleted)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Theme.base)
        .overlay(alignment: .bottom) { Divider() }
        .contentShape(Rectangle())
        .onTapGesture { appState.toggleCollapse(file.id) }
    }

    // MARK: - File View

    /// Flat rows for the selected file only.
    private var fileRows: [FlatRow] {
        guard let file = selectedFile else { return [] }
        var rows: [FlatRow] = []
        rows.reserveCapacity(file.hunks.count * 30)
        for (index, hunk) in file.hunks.enumerated() {
            rows.append(FlatRow(id: "hh-\(file.id)-\(hunk.id)", kind: .hunkHeader(hunk, file: file, index: index)))
            for line in hunk.lines {
                rows.append(FlatRow(id: "ln-\(line.id)", kind: .line(line, file: file)))
            }
        }
        return rows
    }

    @Environment(\.colorScheme) private var colorScheme

    private var fileView: some View {
        VStack(spacing: 0) {
            if let file = selectedFile {
                fileViewHeader(file)
            }

            if appState.isLoadingFileContents {
                VStack(spacing: 12) {
                    ProgressView()
                        .scaleEffect(0.8)
                    Text("Loading file...")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.subtext1)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.mantle)
            } else {
                MonacoDiffView(
                    original: appState.monacoOriginal,
                    modified: appState.monacoModified,
                    language: appState.monacoLanguage,
                    filePath: appState.monacoFilePath,
                    isDark: colorScheme == .dark,
                    comments: appState.commentsForSelectedFile,
                    commentingEnabled: appState.reviewServiceAvailable && !appState.isSessionScope,
                    revealToken: revealToken,
                    onSubmitComment: { side, lineStart, line, lineContent, body in
                        Task { @MainActor in
                            await appState.submitMonacoComment(
                                side: side, lineStart: lineStart, line: line,
                                lineContent: lineContent, body: body
                            )
                        }
                    },
                    onReply: { id, body in
                        Task { @MainActor in
                            if let comment = appState.comments.first(where: { $0.id == id }) {
                                await appState.replyToComment(comment, body: body)
                            }
                        }
                    },
                    onDelete: { id in
                        Task { @MainActor in
                            if let comment = appState.comments.first(where: { $0.id == id }) {
                                await appState.deleteComment(comment)
                            }
                        }
                    }
                )
            }
        }
    }

    private var selectedFile: DiffFile? {
        if let id = appState.selectedFileId {
            return appState.files.first(where: { $0.id == id })
        }
        return appState.files.first
    }

    private func fileViewHeader(_ file: DiffFile) -> some View {
        HStack(spacing: 8) {
            statusBadge(file.status)

            Text(file.displayPath)
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer()

            // Comment count — click reveals the first commented line in Monaco
            if appState.commentCount(forFile: file.displayPath) > 0 {
                Button {
                    revealToken += 1
                } label: {
                    Label("\(appState.commentCount(forFile: file.displayPath))", systemImage: "text.bubble")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Theme.accent.opacity(0.12))
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .help("Jump to the first comment")
            }

            if let idx = appState.selectedFileIndex {
                Text("\(idx + 1) of \(appState.files.count)")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.overlay0)
            }

            HStack(spacing: 4) {
                Button(action: { appState.selectPreviousFile() }) {
                    Image(systemName: "chevron.up")
                        .font(.system(size: 10, weight: .medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(appState.selectedFileIndex == 0)

                Button(action: { appState.selectNextFile() }) {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(appState.selectedFileIndex == appState.files.count - 1)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Theme.base)
        .overlay(alignment: .bottom) { Divider() }
    }

    // MARK: - Shared Components

    private func statusBadge(_ status: FileStatus) -> some View {
        Text(statusLabel(status))
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundStyle(Theme.statusColor(status))
            .frame(width: 16, height: 16)
            .background(Theme.statusColor(status).opacity(Theme.statusBadgeBgOpacity))
            .clipShape(RoundedRectangle(cornerRadius: 3))
    }

    private func statusLabel(_ status: FileStatus) -> String {
        switch status {
        case .added: return "A"
        case .deleted: return "D"
        case .modified: return "M"
        case .renamed: return "R"
        }
    }

    private func hunkHeader(_ hunk: DiffHunk, file: DiffFile, index: Int) -> some View {
        HStack(spacing: 8) {
            // GitHub-style context expander: reveal lines above this hunk
            if DiffExpansion.isExpandable(file), DiffExpansion.gapAbove(file, hunkIndex: index) > 0 {
                Button {
                    Task { @MainActor in
                        await appState.expandContext(fileId: file.id, direction: .up(hunkIndex: index))
                    }
                } label: {
                    Image(systemName: "chevron.up")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .frame(width: 22, height: 16)
                        .background(Theme.accent.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
                .help("Show \(min(DiffExpansion.step, DiffExpansion.gapAbove(file, hunkIndex: index))) lines above")
            }

            Text(hunk.header)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.overlay1)

            if let context = hunk.contextHeader {
                Text(context)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.overlay0)
            }

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 3)
        .background(Theme.hunkHeaderBg)
        .overlay(alignment: .bottom) { Divider() }
    }

    /// Reveal lines below the file's last hunk (shown until EOF is visible).
    private func expandDownRow(_ file: DiffFile) -> some View {
        Button {
            Task { @MainActor in
                await appState.expandContext(fileId: file.id, direction: .down)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 22, height: 16)
                    .background(Theme.accent.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                Text("show more")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Theme.overlay0)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 3)
            .background(Theme.hunkHeaderBg)
            .overlay(alignment: .bottom) { Divider() }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Warm the content cache so the row self-removes when EOF is already visible
        .task { await appState.prefetchFileLines(file) }
    }

    @State private var hoveredLineId: Int?
    @State private var revealToken = 0

    private func diffLine(_ line: DiffLine, file: DiffFile) -> some View {
        let anchor = CommentAnchor(filePath: file.displayPath, repoPath: file.repoPath, diffLine: line)
        let hasComments = anchor.map { !(appState.commentsByAnchor[$0]?.isEmpty ?? true) } ?? false
        let canComment = anchor != nil && appState.reviewServiceAvailable

        return HStack(alignment: .top, spacing: 0) {
            // Single number column: new line number (old for deleted lines)
            Text((line.newLineNumber ?? line.oldLineNumber).map(String.init) ?? "")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.lineNumberColor(line.type))
                .frame(width: 45, alignment: .trailing)
                .padding(.trailing, 4)

            Rectangle()
                .fill(Theme.surface2.opacity(0.4))
                .frame(width: 1)

            // Gutter stripe — primary diff signal
            Rectangle()
                .fill(Theme.gutterStripeColor(line.type) ?? .clear)
                .frame(width: 3)

            // Marker column doubles as the comment affordance on hover
            ZStack {
                Text(lineMarker(line.type))
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Theme.markerColor(line.type))

                if canComment, hoveredLineId == line.id, let anchor {
                    Button {
                        // Shift-click extends the composing range GitHub-style
                        if NSEvent.modifierFlags.contains(.shift), appState.composingAnchor != nil {
                            appState.extendComposingRange(to: anchor)
                        } else {
                            appState.beginComment(anchor: anchor)
                        }
                    } label: {
                        Image(systemName: "plus.square.fill")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.accent)
                            .background(Theme.base)
                    }
                    .buttonStyle(.plain)
                    .help(appState.composingAnchor == nil
                        ? "Add review comment"
                        : "⇧-click to extend the comment range")
                }
            }
            .frame(width: 16, alignment: .center)

            lineContent(line)
                .frame(maxWidth: .infinity, alignment: .leading)

            if hasComments {
                Image(systemName: "text.bubble.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.accent.opacity(0.7))
                    .padding(.trailing, 8)
                    .padding(.top, 2)
            }
        }
        .padding(.vertical, 0.5)
        .background(Theme.lineBackground(line.type))
        .overlay(
            // Ranged-comment span tint
            (anchor.map { appState.isInCommentRange($0) } ?? false)
                ? Theme.accent.opacity(0.06) : Color.clear
        )
        .onHover { hovering in
            if hovering {
                hoveredLineId = line.id
            } else if hoveredLineId == line.id {
                hoveredLineId = nil
            }
        }
    }

    private func lineContent(_ line: DiffLine) -> some View {
        Group {
            if let wordChanges = line.wordChanges, !wordChanges.isEmpty {
                // Word-diff highlighting takes priority, overlay on syntax colors
                Text(buildWordDiffString(line.content, changes: wordChanges, lineType: line.type, syntaxBase: appState.syntaxHighlights[line.id]))
                    .font(.system(size: 13, design: .monospaced))
            } else if let syntaxHighlighted = appState.syntaxHighlights[line.id] {
                // Pure syntax highlighting, no word diffs
                Text(syntaxHighlighted)
                    .font(.system(size: 13, design: .monospaced))
            } else {
                Text(line.content)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Theme.text)
            }
        }
    }

    /// Merge word-diff background highlights with optional syntax coloring.
    private func buildWordDiffString(_ content: String, changes: [WordChange], lineType: LineType, syntaxBase: AttributedString?) -> AttributedString {
        let highlightColor: Color = Theme.wordHighlight(lineType)

        // Start with syntax-highlighted base if available, otherwise plain
        var result = syntaxBase ?? AttributedString(content)

        // Apply word-diff backgrounds on top of syntax colors
        for change in changes {
            guard change.range.lowerBound >= content.startIndex,
                  change.range.upperBound <= content.endIndex,
                  change.range.lowerBound < change.range.upperBound else { continue }

            let charStart = content.distance(from: content.startIndex, to: change.range.lowerBound)
            let charLen = content.distance(from: change.range.lowerBound, to: change.range.upperBound)
            guard charLen > 0 else { continue }

            // Safely compute attributed string range
            let attrCharCount = result.characters.count
            guard charStart >= 0, charStart + charLen <= attrCharCount else { continue }
            let attrStart = result.index(result.startIndex, offsetByCharacters: charStart)
            let attrEnd = result.index(attrStart, offsetByCharacters: charLen)

            result[attrStart..<attrEnd].backgroundColor = highlightColor
        }

        return result
    }

    private func lineMarker(_ type: LineType) -> String {
        switch type {
        case .context: return " "
        case .addition: return "+"
        case .deletion: return "-"
        }
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
                .scaleEffect(0.8)
            Text("Loading diff...")
                .font(.system(size: 13))
                .foregroundStyle(Theme.subtext1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28))
                .foregroundStyle(Theme.warning)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(Theme.subtext1)
                .multilineTextAlignment(.center)
            Button("Retry") { appState.refresh() }
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var emptyView: some View {
        VStack(spacing: 12) {
            Image(systemName: appState.isSessionScope ? "sparkles" : "checkmark.circle")
                .font(.system(size: 28))
                .foregroundStyle(appState.isSessionScope ? Theme.mauve : Theme.green)
            Text(appState.isSessionScope ? "No tracked changes" : "No changes")
                .font(.system(size: 13, weight: .medium))
            Text(appState.isSessionScope
                ? "No tracked changes for this session"
                : "Working tree is clean")
                .font(.system(size: 12))
                .foregroundStyle(Theme.subtext1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
