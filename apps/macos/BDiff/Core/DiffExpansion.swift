import Foundation

/// GitHub-style context expansion: reveal unchanged lines above a hunk or
/// below the last hunk, splicing them into the DiffFile as context lines.
///
/// Works from the NEW side of the file (unchanged lines are identical on both
/// sides; old line numbers are recovered from the hunk's old/new offset).
/// Expansion lines consume ids from a caller-owned NEGATIVE counter so they
/// can never collide with parser-assigned ids (which start at 0).
public enum DiffExpansion {
    public static let step = 20

    /// Files whose content supports context expansion (added files have no
    /// surrounding context; deleted files have no new-side content to fetch).
    public static func isExpandable(_ file: DiffFile) -> Bool {
        file.status == .modified || file.status == .renamed
    }

    /// Unrevealed lines between hunk `hunkIndex` and the previous hunk
    /// (or the top of the file).
    public static func gapAbove(_ file: DiffFile, hunkIndex: Int) -> Int {
        guard file.hunks.indices.contains(hunkIndex) else { return 0 }
        let hunk = file.hunks[hunkIndex]
        let lowerBound = hunkIndex == 0
            ? 1
            : file.hunks[hunkIndex - 1].newStart + file.hunks[hunkIndex - 1].newCount
        return max(0, hunk.newStart - lowerBound)
    }

    /// Reveal up to `step` lines above hunk `hunkIndex`. Merges with the
    /// previous hunk when the gap is fully consumed.
    public static func expandUp(
        file: DiffFile,
        hunkIndex: Int,
        fileLines: [String],
        nextLineId: inout Int,
        step: Int = DiffExpansion.step
    ) -> DiffFile {
        guard file.hunks.indices.contains(hunkIndex) else { return file }
        let hunk = file.hunks[hunkIndex]
        let gap = gapAbove(file, hunkIndex: hunkIndex)
        guard gap > 0 else { return file }

        let take = min(step, gap)
        let firstRevealed = hunk.newStart - take
        let offset = hunk.oldStart - hunk.newStart

        let context = contextLines(
            newRange: firstRevealed..<hunk.newStart,
            offset: offset,
            fileLines: fileLines,
            nextLineId: &nextLineId
        )

        var hunks = file.hunks
        if take == gap && hunkIndex > 0 {
            // Gap exhausted — merge into the previous hunk
            let prev = hunks[hunkIndex - 1]
            let merged = DiffHunk(
                id: prev.id,
                header: header(oldStart: prev.oldStart, oldCount: prev.oldCount + take + hunk.oldCount,
                               newStart: prev.newStart, newCount: prev.newCount + take + hunk.newCount),
                contextHeader: prev.contextHeader,
                oldStart: prev.oldStart,
                oldCount: prev.oldCount + take + hunk.oldCount,
                newStart: prev.newStart,
                newCount: prev.newCount + take + hunk.newCount,
                lines: prev.lines + context + hunk.lines
            )
            hunks.replaceSubrange((hunkIndex - 1)...hunkIndex, with: [merged])
        } else {
            let expanded = DiffHunk(
                id: hunk.id,
                header: header(oldStart: hunk.oldStart - take, oldCount: hunk.oldCount + take,
                               newStart: hunk.newStart - take, newCount: hunk.newCount + take),
                contextHeader: hunk.contextHeader,
                oldStart: hunk.oldStart - take,
                oldCount: hunk.oldCount + take,
                newStart: hunk.newStart - take,
                newCount: hunk.newCount + take,
                lines: context + hunk.lines
            )
            hunks[hunkIndex] = expanded
        }

        return replacingHunks(of: file, with: hunks)
    }

    /// Reveal up to `step` lines below the last hunk. Returns the file
    /// unchanged when the end of the file is already visible.
    public static func expandDown(
        file: DiffFile,
        fileLines: [String],
        nextLineId: inout Int,
        step: Int = DiffExpansion.step
    ) -> DiffFile {
        guard let last = file.hunks.last, let lastIndex = file.hunks.indices.last else { return file }
        let endNew = last.newStart + last.newCount // first unrevealed new line number
        let available = fileLines.count - (endNew - 1)
        guard available > 0 else { return file }

        let take = min(step, available)
        let offset = (last.oldStart + last.oldCount) - (last.newStart + last.newCount)

        let context = contextLines(
            newRange: endNew..<(endNew + take),
            offset: offset,
            fileLines: fileLines,
            nextLineId: &nextLineId
        )

        var hunks = file.hunks
        hunks[lastIndex] = DiffHunk(
            id: last.id,
            header: header(oldStart: last.oldStart, oldCount: last.oldCount + take,
                           newStart: last.newStart, newCount: last.newCount + take),
            contextHeader: last.contextHeader,
            oldStart: last.oldStart,
            oldCount: last.oldCount + take,
            newStart: last.newStart,
            newCount: last.newCount + take,
            lines: last.lines + context
        )

        return replacingHunks(of: file, with: hunks)
    }

    /// Whether more lines exist below the last hunk.
    public static func hasLinesBelow(_ file: DiffFile, fileLineCount: Int) -> Bool {
        guard let last = file.hunks.last else { return false }
        return fileLineCount - (last.newStart + last.newCount - 1) > 0
    }

    // MARK: - Private

    private static func contextLines(
        newRange: Range<Int>,
        offset: Int,
        fileLines: [String],
        nextLineId: inout Int
    ) -> [DiffLine] {
        newRange.compactMap { newNumber in
            guard newNumber >= 1 && newNumber <= fileLines.count else { return nil }
            let line = DiffLine(
                id: nextLineId,
                type: .context,
                content: fileLines[newNumber - 1],
                oldLineNumber: newNumber + offset,
                newLineNumber: newNumber,
                wordChanges: nil
            )
            nextLineId -= 1
            return line
        }
    }

    private static func header(oldStart: Int, oldCount: Int, newStart: Int, newCount: Int) -> String {
        "@@ -\(oldStart),\(oldCount) +\(newStart),\(newCount) @@"
    }

    private static func replacingHunks(of file: DiffFile, with hunks: [DiffHunk]) -> DiffFile {
        DiffFile(
            id: file.id,
            oldPath: file.oldPath,
            newPath: file.newPath,
            status: file.status,
            hunks: hunks,
            repoPath: file.repoPath,
            repoName: file.repoName
        )
    }
}
