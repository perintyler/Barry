import Testing
@testable import BDiffCore

@Suite("Diff context expansion")
struct DiffExpansionTests {

    /// 60-line file: "line 1" … "line 60"; change at new line 30 and 50.
    private var fileLines: [String] { (1...60).map { "line \($0)" } }

    /// Two hunks: @@ -28,5 +28,5 @@ (change at 30) and @@ -48,5 +48,5 @@ (change at 50).
    /// Old/new offsets are 0 for simplicity.
    private func makeFile() -> DiffFile {
        func hunk(id: Int, start: Int, changed: Int) -> DiffHunk {
            var lineId = id * 100
            var lines: [DiffLine] = []
            for n in start..<(start + 5) {
                if n == changed {
                    lines.append(DiffLine(id: lineId, type: .deletion, content: "old \(n)", oldLineNumber: n, newLineNumber: nil, wordChanges: nil))
                    lineId += 1
                    lines.append(DiffLine(id: lineId, type: .addition, content: "line \(n)", oldLineNumber: nil, newLineNumber: n, wordChanges: nil))
                } else {
                    lines.append(DiffLine(id: lineId, type: .context, content: "line \(n)", oldLineNumber: n, newLineNumber: n, wordChanges: nil))
                }
                lineId += 1
            }
            return DiffHunk(id: id, header: "@@ -\(start),5 +\(start),5 @@", contextHeader: nil,
                            oldStart: start, oldCount: 5, newStart: start, newCount: 5, lines: lines)
        }
        return DiffFile(id: "a.txt", oldPath: "a.txt", newPath: "a.txt", status: .modified,
                        hunks: [hunk(id: 0, start: 28, changed: 30), hunk(id: 1, start: 48, changed: 50)])
    }

    @Test func gapAboveComputesBoundaries() {
        let file = makeFile()
        #expect(DiffExpansion.gapAbove(file, hunkIndex: 0) == 27)   // to top of file
        #expect(DiffExpansion.gapAbove(file, hunkIndex: 1) == 15)   // 33..47 between hunks
    }

    @Test func expandUpRevealsStepLinesAboveFirstHunk() {
        var id = -1
        let expanded = DiffExpansion.expandUp(file: makeFile(), hunkIndex: 0, fileLines: fileLines, nextLineId: &id)

        let hunk = expanded.hunks[0]
        #expect(hunk.newStart == 8)     // 28 - 20
        #expect(hunk.newCount == 25)
        #expect(hunk.oldStart == 8)
        #expect(hunk.header == "@@ -8,25 +8,25 @@")
        #expect(hunk.lines.first?.content == "line 8")
        #expect(hunk.lines.first?.type == .context)
        #expect(hunk.lines.first?.newLineNumber == 8)
        // Expansion ids are negative and unique
        let negIds = hunk.lines.filter { $0.id < 0 }.map(\.id)
        #expect(negIds.count == 20)
        #expect(Set(negIds).count == 20)
        // Still a gap above (7 lines to file top)
        #expect(DiffExpansion.gapAbove(expanded, hunkIndex: 0) == 7)
    }

    @Test func expandUpMergesHunksWhenGapExhausted() {
        var id = -1
        // Gap between hunks is 15 (< step 20) — expanding up hunk 1 merges
        let expanded = DiffExpansion.expandUp(file: makeFile(), hunkIndex: 1, fileLines: fileLines, nextLineId: &id)

        #expect(expanded.hunks.count == 1)
        let merged = expanded.hunks[0]
        #expect(merged.newStart == 28)
        #expect(merged.newCount == 25)  // 5 + 15 + 5
        #expect(merged.header == "@@ -28,25 +28,25 @@")
        // Continuity: context lines 33...47 spliced between the original hunks
        let numbers = merged.lines.compactMap(\.newLineNumber)
        #expect(numbers.contains(33) && numbers.contains(47))
    }

    @Test func expandDownRevealsBelowLastHunkAndStopsAtEOF() {
        var id = -1
        var file = DiffExpansion.expandDown(file: makeFile(), fileLines: fileLines, nextLineId: &id)
        var last = file.hunks.last!
        #expect(last.newCount == 13)    // 5 + 8 (only 8 lines remain: 53..60)
        #expect(last.lines.last?.content == "line 60")
        #expect(!DiffExpansion.hasLinesBelow(file, fileLineCount: fileLines.count))

        // Expanding again is a no-op
        file = DiffExpansion.expandDown(file: file, fileLines: fileLines, nextLineId: &id)
        last = file.hunks.last!
        #expect(last.newCount == 13)
    }

    @Test func addedAndDeletedFilesAreNotExpandable() {
        let added = DiffFile(id: "n", oldPath: "/dev/null", newPath: "n", status: .added, hunks: [])
        let deleted = DiffFile(id: "d", oldPath: "d", newPath: "/dev/null", status: .deleted, hunks: [])
        #expect(!DiffExpansion.isExpandable(added))
        #expect(!DiffExpansion.isExpandable(deleted))
        #expect(DiffExpansion.isExpandable(makeFile()))
    }

    @Test func expandUpWithOldNewOffsetRecoversOldNumbers() {
        // Hunk where new numbers run 3 ahead of old (earlier insertions)
        let hunk = DiffHunk(id: 0, header: "@@ -37,3 +40,3 @@", contextHeader: nil,
                            oldStart: 37, oldCount: 3, newStart: 40, newCount: 3,
                            lines: (40..<43).map {
                                DiffLine(id: $0, type: .context, content: "line \($0)", oldLineNumber: $0 - 3, newLineNumber: $0, wordChanges: nil)
                            })
        let file = DiffFile(id: "o.txt", oldPath: "o.txt", newPath: "o.txt", status: .modified, hunks: [hunk])
        var id = -1
        let expanded = DiffExpansion.expandUp(file: file, hunkIndex: 0, fileLines: fileLines, nextLineId: &id)
        let first = expanded.hunks[0].lines.first!
        #expect(first.newLineNumber == 20)
        #expect(first.oldLineNumber == 17)  // offset -3 preserved
    }
}
