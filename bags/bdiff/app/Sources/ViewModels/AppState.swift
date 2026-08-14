import SwiftUI
import AppKit
import BDiffCore

enum DiffMode: String, CaseIterable {
    case working = "Working"
    case branch = "Branch"
    case history = "History"
}

enum ViewMode: String {
    case stream  // All files in one scroll, collapsible
    case file    // One file at a time (GitHub Desktop style)
}

/// The branch the user is viewing: a repo plus one of its branch entries.
struct SelectedBranch: Equatable {
    let repoPath: String
    let repoName: String
    let entry: BranchEntry

    /// Directory to run git operations in — the entry's own checkout if it has one.
    var diffPath: String { entry.worktreePath ?? repoPath }

    /// Branch query param for the API — only set for refs not checked out anywhere.
    var refBranch: String? { entry.isCheckedOut ? nil : entry.name }
}

private struct CachedFileContents {
    let original: String
    let modified: String
    let language: String
}

// MainActor-isolated: @Observable state must be mutated on the main thread —
// nonisolated async methods resume on the global executor, which caused views
// to observe `files` updates inconsistently (sidebar empty, diff pane full).
@MainActor
@Observable
final class AppState {
    // Branch selector
    var repoGroups: [RepoBranches] = []
    var selected: SelectedBranch?

    // Session scope (mutually exclusive with branch selection)
    var selectedSession: SessionSummary?
    var pickerSessions: [SessionSummary] = []
    var isSessionScope: Bool { selectedSession != nil }

    // Diff state
    var mode: DiffMode = .branch
    var viewMode: ViewMode = .file
    var files: [DiffFile] = []
    var selectedFileId: String?
    var collapsedFileIds: Set<String> = []
    var commits: [GitCommit] = []
    var selectedCommitHash: String?

    // Syntax highlighting (pre-computed, keyed by DiffLine.id)
    var syntaxHighlights: [Int: AttributedString] = [:]

    // Context expansion (GitHub-style reveal above/below hunks)
    var downExhausted: Set<String> = []           // file ids with EOF revealed
    private var fileLinesCache: [String: [String]] = [:]
    private var expansionLineId = -1              // negative: never collides with parser ids
    /// Revealed new-line ranges per file id — survives poll reloads so live
    /// sessions don't collapse your expanded context every 30s.
    private var revealedRanges: [String: [ClosedRange<Int>]] = [:]

    // Monaco DiffEditor state (per-file original + modified content)
    var monacoOriginal: String = ""
    var monacoModified: String = ""
    var monacoLanguage: String = "plaintext"
    var monacoFilePath: String = ""
    var isLoadingFileContents = false
    private var fileContentsInFlight: String? // file ID currently loading
    private var fileContentsCache: [String: CachedFileContents] = [:]

    // Metadata
    var baseBranch: String?
    var currentBranch: String?

    // Review comments (bdiff review service)
    var comments: [ReviewComment] = []
    var commentsByAnchor: [CommentAnchor: [ReviewComment]] = [:]
    var composingAnchor: CommentAnchor?
    var composingLineStart: Int?
    var commentDraft = ""
    var replyDrafts: [String: String] = [:]
    var reviewServiceAvailable = false
    /// Anchors covered by ranged comments — drives the range row tint.
    var rangeLineAnchors: Set<CommentAnchor> = []

    // Loading
    var isLoading = false
    var lastRefresh: Date?
    var error: String?
    var isConnected = false
    private var loadInFlight = false
    private var branchLoadInFlight = false

    // URL scheme entry
    var pendingSessionId: String?

    private let client = BarryClient()
    private let reviewClient = ReviewClient()
    private let highlighter = SyntaxHighlighter()
    // nonisolated(unsafe): touched from deinit; all other access is MainActor
    private nonisolated(unsafe) var pollTimer: Timer?
    private var highlightTask: Task<Void, Never>?

    deinit { pollTimer?.invalidate() }

    // MARK: - Lifecycle

    func start() async {
        await checkConnection()
        startPolling()
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func startPolling() {
        pollTimer?.invalidate()
        let timer = Timer(timeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.loadInFlight, !self.branchLoadInFlight else { return }
                // Refresh the diff only when a live session may be changing it
                let shouldRefreshDiff = self.selected?.entry.isLive == true
                    || self.selectedSession?.isLive == true
                await self.loadRepoBranches()
                await self.loadPickerSessions()
                if shouldRefreshDiff {
                    await self.loadDiff()
                }
                // Always refresh comments — agent resolutions arrive by polling
                await self.loadComments()
            }
        }
        // .common keeps the timer firing during UI interaction (scroll, resize)
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    // MARK: - URL Scheme

    func openFromURL(sessionId: String) {
        pendingSessionId = sessionId
        Task { @MainActor in
            // Prefer the session view for session deep links
            await loadPickerSessions()
            if let session = pickerSessions.first(where: { $0.id == sessionId }) {
                selectSession(session)
                pendingSessionId = nil
                return
            }

            // Fallback: select the branch the session works on (legacy behavior)
            await loadRepoBranches()
            outer: for repo in repoGroups {
                for entry in repo.branches where entry.sessionIds.contains(sessionId) {
                    selected = SelectedBranch(repoPath: repo.repoPath, repoName: repo.repoName, entry: entry)
                    await loadDiff()
                    break outer
                }
            }
            pendingSessionId = nil
        }
    }

    // MARK: - Connection

    func checkConnection() async {
        isConnected = await client.checkHealth()
        if isConnected {
            await loadRepoBranches()
            await loadPickerSessions()
            if selected == nil, let repo = repoGroups.first {
                let (visible, _) = BranchVisibility.split(repo.branches)
                if let entry = visible.first ?? repo.branches.first {
                    selected = SelectedBranch(repoPath: repo.repoPath, repoName: repo.repoName, entry: entry)
                    await loadDiff()
                }
            }
        }
    }

    // MARK: - Branches

    func loadRepoBranches() async {
        guard !branchLoadInFlight else { return }
        branchLoadInFlight = true
        defer { branchLoadInFlight = false }
        do {
            let response = try await client.fetchRepoBranches()
            let repos = response.repos
            repoGroups = repos

            // Keep the selection pointing at fresh entry data (live dots,
            // session ids) without changing what's selected
            if let sel = selected,
               let repo = repos.first(where: { $0.repoPath == sel.repoPath }),
               let entry = repo.branches.first(where: { $0.name == sel.entry.name }) {
                selected = SelectedBranch(repoPath: repo.repoPath, repoName: repo.repoName, entry: entry)
            }
        } catch {
            // Keep existing groups on failure
        }
    }

    func selectBranch(repo: RepoBranches, entry: BranchEntry) {
        selected = SelectedBranch(repoPath: repo.repoPath, repoName: repo.repoName, entry: entry)
        selectedSession = nil
        selectedFileId = nil
        selectedCommitHash = nil
        files = []
        commits = []
        clearComments()
        isLoading = true

        // Working mode needs a real directory — fall back for plain refs
        if mode == .working, !entry.isCheckedOut {
            mode = .branch
        }

        guard !loadInFlight else { return }
        Task { @MainActor in
            await loadDiff()
        }
    }

    // MARK: - Sessions

    func loadPickerSessions() async {
        do {
            let response = try await client.fetchSessionPicker()
            pickerSessions = SessionVisibility.sort(response.sessions ?? [])
            // Keep the selected session's status/name fresh (live → ended)
            if let current = selectedSession,
               let updated = pickerSessions.first(where: { $0.id == current.id }) {
                selectedSession = updated
            }
        } catch {
            // Keep existing rows on failure
        }
    }

    func selectSession(_ session: SessionSummary) {
        selectedSession = session
        selected = nil
        viewMode = .stream
        selectedFileId = nil
        selectedCommitHash = nil
        files = []
        commits = []
        clearComments()
        isLoading = true
        guard !loadInFlight else { return }
        Task { @MainActor in
            await loadDiff()
        }
    }

    private func loadSessionDiff(_ session: SessionSummary) async {
        do {
            let response = try await client.fetchSessionView(sessionId: session.id)
            var lineId = 0
            var parsed: [DiffFile] = []
            for repo in response.repos ?? [] {
                parsed.append(contentsOf: DiffParser.parse(
                    repo.diff ?? "",
                    repoPath: repo.repoPath,
                    repoName: repo.repoName,
                    lineIdStart: &lineId
                ))
            }
            baseBranch = nil
            currentBranch = nil
            setFilesWithHighlighting(parsed)
            lastRefresh = Date()
        } catch {
            self.error = error.localizedDescription
            files = []
        }
    }

    // MARK: - Diff Loading

    func loadDiff() async {
        if let session = selectedSession {
            guard !loadInFlight else { return }
            loadInFlight = true
            isLoading = true
            error = nil
            await loadSessionDiff(session)
            isLoading = false
            loadInFlight = false
            await loadComments()
            return
        }

        guard let sel = selected else { return }
        guard !loadInFlight else { return }
        loadInFlight = true
        isLoading = true
        error = nil

        do {
            switch mode {
            case .working:
                let response = try await client.fetchDiff(path: sel.diffPath, mode: "uncommitted")
                baseBranch = nil
                currentBranch = response.currentBranch ?? sel.entry.name
                setFilesWithHighlighting(DiffParser.parse(response.diff ?? ""))

            case .branch:
                let response = try await client.fetchDiff(path: sel.diffPath, mode: "branch", branch: sel.refBranch)
                baseBranch = response.baseBranch
                currentBranch = response.currentBranch
                setFilesWithHighlighting(DiffParser.parse(response.diff ?? ""))

            case .history:
                let logResponse = try await client.fetchGitLog(path: sel.diffPath, branch: sel.refBranch)
                baseBranch = logResponse.baseBranch
                currentBranch = logResponse.currentBranch
                commits = logResponse.commits ?? []

                if let first = commits.first {
                    selectedCommitHash = first.hash
                    await loadCommitDiff(hash: first.hash)
                } else {
                    files = []
                }
            }

            lastRefresh = Date()
        } catch {
            self.error = error.localizedDescription
            files = []
        }

        isLoading = false
        loadInFlight = false
        await loadComments()
    }

    func loadCommitDiff(hash: String) async {
        guard let sel = selected else { return }
        do {
            let response = try await client.fetchCommitDiff(path: sel.diffPath, commitHash: hash)
            setFilesWithHighlighting(DiffParser.parse(response.diff ?? ""))
        } catch {
            self.error = error.localizedDescription
        }
        await loadComments()
    }

    /// Parse diff text and kick off syntax highlighting + Monaco content loading.
    private func setFilesWithHighlighting(_ parsed: [DiffFile]) {
        files = parsed
        syntaxHighlights = [:]
        fileLinesCache = [:] // content may have changed — refetch on demand
        fileContentsCache = [:]
        downExhausted = []
        expansionLineId = -1
        if !revealedRanges.isEmpty {
            Task { @MainActor in await reapplyExpansions() }
        }
        // Auto-select first file if none selected
        if selectedFileId == nil || !parsed.contains(where: { $0.id == selectedFileId }) {
            selectedFileId = parsed.first?.id
        }
        // Highlight asynchronously — view renders plain text first, then upgrades
        highlightCurrentFiles()
        // Load file contents for Monaco DiffEditor
        loadFileContentsForSelected()
    }

    /// Load original + modified file contents for the currently selected file.
    /// Results are cached per file ID so revisiting a file is instant.
    func loadFileContentsForSelected() {
        guard let fileId = selectedFileId,
              let file = files.first(where: { $0.id == fileId }) else {
            monacoOriginal = ""
            monacoModified = ""
            monacoLanguage = "plaintext"
            monacoFilePath = ""
            return
        }

        let filePath = file.displayPath

        // Serve from cache — no network round-trip
        if let cached = fileContentsCache[fileId] {
            monacoOriginal = cached.original
            monacoModified = cached.modified
            monacoLanguage = cached.language
            monacoFilePath = filePath
            return
        }

        fileContentsInFlight = fileId

        Task { @MainActor [weak self] in
            guard let self, self.fileContentsInFlight == fileId else { return }
            self.isLoadingFileContents = true

            let path: String
            let mode: String
            var branch: String?
            var commit: String?
            if self.selectedSession != nil, let repoPath = file.repoPath {
                path = repoPath
                mode = "uncommitted"
            } else if let sel = self.selected {
                path = sel.diffPath
                mode = self.apiDiffMode
                branch = sel.refBranch
                commit = self.selectedCommitHash
            } else {
                self.isLoadingFileContents = false
                return
            }

            do {
                let response = try await self.client.fetchFileContents(
                    path: path,
                    file: filePath,
                    mode: mode,
                    branch: branch,
                    commit: commit
                )
                guard self.fileContentsInFlight == fileId else { return }
                let original = response.original ?? ""
                let modified = response.modified ?? ""
                let language = response.language ?? "plaintext"
                self.fileContentsCache[fileId] = CachedFileContents(
                    original: original, modified: modified, language: language
                )
                self.monacoOriginal = original
                self.monacoModified = modified
                self.monacoLanguage = language
                self.monacoFilePath = filePath
            } catch {
                guard self.fileContentsInFlight == fileId else { return }
                self.monacoOriginal = ""
                self.monacoModified = ""
                self.monacoLanguage = "plaintext"
                self.monacoFilePath = filePath
            }
            self.isLoadingFileContents = false
        }
    }

    /// Re-run syntax highlighting for the current files. The highlight theme is
    /// light/dark specific, so this must also run when the system appearance changes.
    func highlightCurrentFiles(isDark: Bool? = nil) {
        let current = files
        guard !current.isEmpty else { return }
        // Cancel any in-flight highlight pass — its results would be stale and
        // the queued work inside the SyntaxHighlighter actor leaks Mach ports
        // (every NSAttributedString HTML import spawns XPC connections).
        highlightTask?.cancel()
        highlightTask = Task { @MainActor [weak self] in
            guard let self else { return }
            let dark = isDark ?? (NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
            await self.highlighter.highlightFiles(current, isDarkMode: dark)
            guard !Task.isCancelled else { return }
            self.syntaxHighlights = await self.highlighter.allHighlights()
        }
    }

    /// The current DiffMode as the API's mode string.
    var apiDiffMode: String {
        switch mode {
        case .working: return "uncommitted"
        case .branch: return "branch"
        case .history: return "commit"
        }
    }

    func selectCommit(_ hash: String) {
        selectedCommitHash = hash
        composingAnchor = nil
        clearExpansionState()
        guard !loadInFlight else { return }
        Task { @MainActor in
            await loadCommitDiff(hash: hash)
        }
    }

    func switchMode(_ newMode: DiffMode) {
        // Working mode needs a real directory — unavailable for plain refs
        if newMode == .working, selected?.entry.isCheckedOut == false { return }
        mode = newMode
        selectedFileId = nil
        selectedCommitHash = nil
        files = []
        commits = []
        clearComments()
        isLoading = true
        guard !loadInFlight else { return }
        Task { @MainActor in
            await loadDiff()
        }
    }

    func refresh() {
        guard !loadInFlight && !branchLoadInFlight else { return }
        Task { @MainActor in
            await loadRepoBranches()
            await loadDiff()
        }
    }

    // MARK: - File Collapse

    func toggleCollapse(_ fileId: String) {
        if collapsedFileIds.contains(fileId) {
            collapsedFileIds.remove(fileId)
        } else {
            collapsedFileIds.insert(fileId)
        }
    }

    func isCollapsed(_ fileId: String) -> Bool {
        collapsedFileIds.contains(fileId)
    }

    // MARK: - File Navigation (file view mode)

    var selectedFileIndex: Int? {
        guard let id = selectedFileId else { return nil }
        return files.firstIndex(where: { $0.id == id })
    }

    func selectPreviousFile() {
        guard let idx = selectedFileIndex, idx > 0 else { return }
        selectedFileId = files[idx - 1].id
        loadFileContentsForSelected()
    }

    func selectNextFile() {
        guard let idx = selectedFileIndex, idx < files.count - 1 else { return }
        selectedFileId = files[idx + 1].id
        loadFileContentsForSelected()
    }

    // MARK: - Review Comments

    /// Branch context for comment scoping — only meaningful in branch mode.
    private var commentBranch: String? {
        mode == .branch ? selected?.entry.name : nil
    }

    /// Commit context for comment scoping — only meaningful in history mode.
    private var commentCommit: String? {
        mode == .history ? selectedCommitHash : nil
    }

    func loadComments() async {
        do {
            let fetched: [ReviewComment]
            if let session = selectedSession {
                fetched = try await reviewClient.fetchComments(sessionId: session.id)
            } else if let sel = selected {
                fetched = try await reviewClient.fetchComments(
                    repoPath: sel.diffPath,
                    mode: apiDiffMode,
                    branch: commentBranch,
                    commit: commentCommit
                )
            } else {
                return
            }
            comments = fetched
            reviewServiceAvailable = true
            rebuildCommentIndex()
        } catch {
            // Service down or unreachable — keep prior comments, hide affordance
            reviewServiceAvailable = false
        }
    }

    func beginComment(anchor: CommentAnchor) {
        composingAnchor = anchor
        composingLineStart = nil
        commentDraft = ""
    }

    func cancelComment() {
        composingAnchor = nil
        composingLineStart = nil
        commentDraft = ""
    }

    /// Shift-click on another line's "+" while composing extends the range
    /// (same file/side/repo); the composer follows the range end.
    func extendComposingRange(to anchor: CommentAnchor) {
        guard let current = composingAnchor,
              anchor.filePath == current.filePath,
              anchor.side == current.side,
              anchor.repoPath == current.repoPath else { return }
        let lines = [composingLineStart ?? current.line, current.line, anchor.line]
        let lo = lines.min()!
        let hi = lines.max()!
        composingAnchor = CommentAnchor(
            filePath: current.filePath, side: current.side, line: hi, repoPath: current.repoPath
        )
        composingLineStart = lo < hi ? lo : nil
    }

    /// Stream-composer path: uses the draft + composing state.
    func submitComment(lineContent: String) async {
        guard let anchor = composingAnchor else { return }
        let body = commentDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        let submitted = await submitComment(
            anchor: anchor, lineStart: composingLineStart, lineContent: lineContent, body: body
        )
        if submitted {
            composingAnchor = nil
            composingLineStart = nil
            commentDraft = ""
        }
    }

    /// Draft-independent create used by both the stream composer and Monaco.
    @discardableResult
    func submitComment(anchor: CommentAnchor, lineStart: Int?, lineContent: String, body: String) async -> Bool {
        let repoPath: String
        let mode: String
        let branch: String?
        let commitHash: String?
        let sessionId: String?
        if let session = selectedSession {
            // Session comments anchor to the file's own repo (may span repos).
            guard let anchorRepo = anchor.repoPath else { return false }
            repoPath = anchorRepo
            mode = "uncommitted"
            branch = nil
            commitHash = nil
            sessionId = session.id
        } else if let sel = selected {
            repoPath = sel.diffPath
            mode = apiDiffMode
            branch = commentBranch
            commitHash = commentCommit
            sessionId = nil
        } else {
            return false
        }

        do {
            let created = try await reviewClient.createComment(
                repoPath: repoPath,
                mode: mode,
                branch: branch,
                commitHash: commitHash,
                sessionId: sessionId,
                filePath: anchor.filePath,
                side: anchor.side,
                line: anchor.line,
                lineStart: lineStart,
                lineContent: lineContent,
                body: body
            )
            comments.append(created)
            rebuildCommentIndex()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Monaco file-view path (branch/working/commit scope — the file view is
    /// unreachable in session scope).
    func submitMonacoComment(side: String, lineStart: Int?, line: Int, lineContent: String, body: String) async {
        guard let fileId = selectedFileId,
              let file = files.first(where: { $0.id == fileId }) else { return }
        let anchor = CommentAnchor(filePath: file.displayPath, side: side, line: line, repoPath: file.repoPath)
        await submitComment(anchor: anchor, lineStart: lineStart, lineContent: lineContent, body: body)
    }

    func deleteComment(_ comment: ReviewComment) async {
        do {
            try await reviewClient.deleteComment(id: comment.id)
            comments.removeAll { $0.id == comment.id }
            rebuildCommentIndex()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func replyToComment(_ comment: ReviewComment, body: String) async {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            let reply = try await reviewClient.reply(id: comment.id, body: trimmed)
            if let idx = comments.firstIndex(where: { $0.id == comment.id }) {
                comments[idx] = comments[idx].appending(reply: reply)
                rebuildCommentIndex()
            }
            replyDrafts[comment.id] = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Open comments count for a file — shown in the file-view header pill.
    func commentCount(forFile filePath: String) -> Int {
        comments.filter { $0.filePath == filePath }.count
    }

    private func rebuildCommentIndex() {
        var index: [CommentAnchor: [ReviewComment]] = [:]
        var ranges: Set<CommentAnchor> = []
        for comment in comments {
            let display = displayAnchor(for: comment)
            index[display, default: []].append(comment)
            if let lineStart = comment.lineStart {
                let span = comment.line - lineStart
                guard span > 0 else { continue }
                for line in (display.line - span)...display.line {
                    ranges.insert(CommentAnchor(
                        filePath: display.filePath, side: display.side,
                        line: line, repoPath: display.repoPath
                    ))
                }
            }
        }
        commentsByAnchor = index
        rangeLineAnchors = ranges
    }

    /// Whether a line participates in a ranged comment or the composing range.
    func isInCommentRange(_ anchor: CommentAnchor) -> Bool {
        if rangeLineAnchors.contains(anchor) { return true }
        guard let current = composingAnchor, let start = composingLineStart,
              current.filePath == anchor.filePath,
              current.side == anchor.side,
              current.repoPath == anchor.repoPath else { return false }
        return (start...current.line).contains(anchor.line)
    }

    /// Comments on the currently selected file (both sides) — the Monaco set.
    var commentsForSelectedFile: [ReviewComment] {
        guard let fileId = selectedFileId,
              let file = files.first(where: { $0.id == fileId }) else { return [] }
        return comments.filter { comment in
            comment.filePath == file.displayPath
                && (file.repoPath == nil || comment.repoPath == file.repoPath)
        }
    }

    /// Where to render a comment in the current diff. Uses the stored anchor
    /// when the line there still matches the captured content; when the diff
    /// has drifted, relocates by content match within the same file (mirrors
    /// how the agent-side skill relocates comments). Falls back to the stored
    /// anchor when no match exists.
    private func displayAnchor(for comment: ReviewComment) -> CommentAnchor {
        let stored = CommentAnchor(comment: comment)
        let file = files.first(where: {
            $0.displayPath == comment.filePath
                && (stored.repoPath == nil || $0.repoPath == stored.repoPath)
        })
        guard let file else { return stored }

        var contentMatch: CommentAnchor?
        for hunk in file.hunks {
            for line in hunk.lines {
                guard let anchor = CommentAnchor(filePath: file.displayPath, repoPath: stored.repoPath, diffLine: line),
                      anchor.side == comment.side else { continue }
                if anchor == stored, line.content == comment.lineContent {
                    return stored // still exactly where it was left
                }
                if contentMatch == nil, line.content == comment.lineContent {
                    contentMatch = anchor
                }
            }
        }
        return contentMatch ?? stored
    }

    private func clearComments() {
        comments = []
        commentsByAnchor = [:]
        rangeLineAnchors = []
        composingAnchor = nil
        composingLineStart = nil
        commentDraft = ""
        replyDrafts = [:]
        clearExpansionState() // expansions belong to the previous selection
    }

    // MARK: - Context Expansion

    enum ExpandDirection {
        case up(hunkIndex: Int)
        case down
    }

    func expandContext(fileId: String, direction: ExpandDirection) async {
        guard let index = files.firstIndex(where: { $0.id == fileId }) else { return }
        let file = files[index]
        guard DiffExpansion.isExpandable(file) else { return }
        guard let lines = await fileLines(for: file) else { return }

        let updated: DiffFile
        switch direction {
        case .up(let hunkIndex):
            guard file.hunks.indices.contains(hunkIndex) else { return }
            let hunk = file.hunks[hunkIndex]
            let take = min(DiffExpansion.step, DiffExpansion.gapAbove(file, hunkIndex: hunkIndex))
            if take > 0 {
                recordRevealed(fileId: fileId, range: (hunk.newStart - take)...(hunk.newStart - 1))
            }
            updated = DiffExpansion.expandUp(
                file: file, hunkIndex: hunkIndex, fileLines: lines, nextLineId: &expansionLineId
            )
        case .down:
            if let last = file.hunks.last {
                let endNew = last.newStart + last.newCount
                let take = min(DiffExpansion.step, lines.count - (endNew - 1))
                if take > 0 {
                    recordRevealed(fileId: fileId, range: endNew...(endNew + take - 1))
                }
            }
            updated = DiffExpansion.expandDown(
                file: file, fileLines: lines, nextLineId: &expansionLineId
            )
            if !DiffExpansion.hasLinesBelow(updated, fileLineCount: lines.count) {
                downExhausted.insert(fileId)
            }
        }

        files[index] = updated
        highlightCurrentFiles()
    }

    /// Warm the content cache for a file so the expand-down affordance can
    /// self-correct (disappear) when the diff already reaches EOF.
    func prefetchFileLines(_ file: DiffFile) async {
        _ = await fileLines(for: file)
    }

    private func recordRevealed(fileId: String, range: ClosedRange<Int>) {
        revealedRanges[fileId, default: []].append(range)
    }

    private func clearExpansionState() {
        revealedRanges = [:]
        fileLinesCache = [:]
        downExhausted = []
    }

    /// Re-apply previously revealed context after a diff reload (e.g. the 30s
    /// poll re-parsing a live session's diff). Expands any hunk gap that
    /// overlaps a recorded range until covered; over-reveals at worst.
    private func reapplyExpansions() async {
        for (fileId, ranges) in revealedRanges {
            guard let startIndex = files.firstIndex(where: { $0.id == fileId }),
                  DiffExpansion.isExpandable(files[startIndex]),
                  let lines = await fileLines(for: files[startIndex]) else { continue }

            var iterations = 0
            var changed = true
            while changed && iterations < 100 {
                changed = false
                iterations += 1
                guard let idx = files.firstIndex(where: { $0.id == fileId }) else { break }
                let file = files[idx]

                for (i, hunk) in file.hunks.enumerated() {
                    let gap = DiffExpansion.gapAbove(file, hunkIndex: i)
                    guard gap > 0 else { continue }
                    let gapRange = (hunk.newStart - gap)...(hunk.newStart - 1)
                    if ranges.contains(where: { $0.overlaps(gapRange) }) {
                        files[idx] = DiffExpansion.expandUp(
                            file: file, hunkIndex: i, fileLines: lines, nextLineId: &expansionLineId
                        )
                        changed = true
                        break
                    }
                }
                if changed { continue }

                if let last = file.hunks.last {
                    let endNew = last.newStart + last.newCount
                    if DiffExpansion.hasLinesBelow(file, fileLineCount: lines.count),
                       ranges.contains(where: { $0.upperBound >= endNew }) {
                        files[idx] = DiffExpansion.expandDown(
                            file: file, fileLines: lines, nextLineId: &expansionLineId
                        )
                        changed = true
                    }
                }
            }

            if let idx = files.firstIndex(where: { $0.id == fileId }),
               !DiffExpansion.hasLinesBelow(files[idx], fileLineCount: lines.count) {
                downExhausted.insert(fileId)
            }
        }
        highlightCurrentFiles()
    }

    /// Whether the expand-down affordance should show for a file.
    func canExpandDown(_ file: DiffFile) -> Bool {
        guard DiffExpansion.isExpandable(file), !downExhausted.contains(file.id) else { return false }
        if let lines = fileLinesCache[file.id] {
            return DiffExpansion.hasLinesBelow(file, fileLineCount: lines.count)
        }
        return true // optimistic until content is fetched
    }

    /// Current (new-side) file content, cached per diff load.
    private func fileLines(for file: DiffFile) async -> [String]? {
        if let cached = fileLinesCache[file.id] { return cached }

        let path: String
        let mode: String
        var branch: String?
        var commit: String?
        if isSessionScope {
            guard let repoPath = file.repoPath else { return nil }
            path = repoPath
            mode = "uncommitted"
        } else if let sel = selected {
            path = sel.diffPath
            mode = apiDiffMode
            branch = sel.refBranch
            commit = selectedCommitHash
        } else {
            return nil
        }

        do {
            let response = try await client.fetchFileContents(
                path: path, file: file.displayPath, mode: mode, branch: branch, commit: commit
            )
            guard let modified = response.modified, !modified.isEmpty else { return nil }
            var lines = modified.components(separatedBy: "\n")
            if lines.last == "" { lines.removeLast() } // trailing newline artifact
            fileLinesCache[file.id] = lines
            if !DiffExpansion.hasLinesBelow(files.first(where: { $0.id == file.id }) ?? file,
                                            fileLineCount: lines.count) {
                downExhausted.insert(file.id)
            }
            return lines
        } catch {
            return nil
        }
    }

    // MARK: - Stats

    var totalInsertions: Int { files.reduce(0) { $0 + $1.insertions } }
    var totalDeletions: Int { files.reduce(0) { $0 + $1.deletions } }
    var sessionRepoCount: Int { Set(files.compactMap(\.repoName)).count }
}
