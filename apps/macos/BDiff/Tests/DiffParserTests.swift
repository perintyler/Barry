import Testing
@testable import BDiffCore

@Suite("DiffParser")
struct DiffParserTests {

    // MARK: - Empty / Invalid Input

    @Test func emptyInput() {
        let files = DiffParser.parse("")
        #expect(files.isEmpty)
    }

    @Test func garbageInput() {
        let files = DiffParser.parse("this is not a diff")
        #expect(files.isEmpty)
    }

    // MARK: - Basic Parsing

    @Test func singleFileModification() {
        let diff = """
        diff --git a/foo.swift b/foo.swift
        --- a/foo.swift
        +++ b/foo.swift
        @@ -1,3 +1,4 @@
         line one
        -line two
        +line two modified
        +line three new
         line four
        """
        let files = DiffParser.parse(diff)
        #expect(files.count == 1)
        #expect(files[0].status == .modified)
        #expect(files[0].oldPath == "foo.swift")
        #expect(files[0].newPath == "foo.swift")
        #expect(files[0].filename == "foo.swift")
        #expect(files[0].insertions == 2)
        #expect(files[0].deletions == 1)
    }

    @Test func newFile() {
        let diff = """
        diff --git a/new.txt b/new.txt
        new file mode 100644
        --- /dev/null
        +++ b/new.txt
        @@ -0,0 +1,2 @@
        +hello
        +world
        """
        let files = DiffParser.parse(diff)
        #expect(files.count == 1)
        #expect(files[0].status == .added)
        #expect(files[0].newPath == "new.txt")
        #expect(files[0].insertions == 2)
        #expect(files[0].deletions == 0)
    }

    @Test func deletedFile() {
        let diff = """
        diff --git a/old.txt b/old.txt
        deleted file mode 100644
        --- a/old.txt
        +++ /dev/null
        @@ -1,2 +0,0 @@
        -goodbye
        -world
        """
        let files = DiffParser.parse(diff)
        #expect(files.count == 1)
        #expect(files[0].status == .deleted)
        #expect(files[0].oldPath == "old.txt")
        #expect(files[0].deletions == 2)
    }

    @Test func renamedFile() {
        let diff = """
        diff --git a/old.txt b/new.txt
        rename from old.txt
        rename to new.txt
        """
        let files = DiffParser.parse(diff)
        #expect(files.count == 1)
        #expect(files[0].status == .renamed)
        #expect(files[0].oldPath == "old.txt")
        #expect(files[0].newPath == "new.txt")
    }

    @Test func multipleFiles() {
        let diff = """
        diff --git a/a.txt b/a.txt
        --- a/a.txt
        +++ b/a.txt
        @@ -1 +1 @@
        -old
        +new
        diff --git a/b.txt b/b.txt
        --- a/b.txt
        +++ b/b.txt
        @@ -1 +1 @@
        -foo
        +bar
        """
        let files = DiffParser.parse(diff)
        #expect(files.count == 2)
        #expect(files[0].newPath == "a.txt")
        #expect(files[1].newPath == "b.txt")
    }

    // MARK: - Binary Files

    @Test func binaryFileSkipped() {
        let diff = """
        diff --git a/image.png b/image.png
        Binary files a/image.png and b/image.png differ
        """
        let files = DiffParser.parse(diff)
        #expect(files.isEmpty)
    }

    @Test func gitBinaryPatchSkipped() {
        let diff = """
        diff --git a/data.o b/data.o
        GIT binary patch
        literal 1234
        some binary data
        """
        let files = DiffParser.parse(diff)
        #expect(files.isEmpty)
    }

    @Test func binaryExtensionSkipped() {
        let diff = """
        diff --git a/module.o b/module.o
        --- a/module.o
        +++ b/module.o
        @@ -1 +1 @@
        -old
        +new
        """
        let files = DiffParser.parse(diff)
        #expect(files.isEmpty)
    }

    // MARK: - Hunk Parsing

    @Test func hunkHeaderParsed() {
        let diff = """
        diff --git a/f.swift b/f.swift
        --- a/f.swift
        +++ b/f.swift
        @@ -10,5 +10,6 @@ func example()
         context
        +added
         more context
        """
        let files = DiffParser.parse(diff)
        #expect(files.count == 1)
        let hunk = files[0].hunks[0]
        #expect(hunk.oldStart == 10)
        #expect(hunk.oldCount == 5)
        #expect(hunk.newStart == 10)
        #expect(hunk.newCount == 6)
        #expect(hunk.contextHeader == "func example()")
    }

    @Test func lineNumbersCorrect() {
        let diff = """
        diff --git a/f.txt b/f.txt
        --- a/f.txt
        +++ b/f.txt
        @@ -5,4 +5,4 @@
         context
        -deleted
        +added
         context
        """
        let files = DiffParser.parse(diff)
        let lines = files[0].hunks[0].lines
        // context line: both line numbers
        #expect(lines[0].type == .context)
        #expect(lines[0].oldLineNumber == 5)
        #expect(lines[0].newLineNumber == 5)
        // deletion: only old line number
        #expect(lines[1].type == .deletion)
        #expect(lines[1].oldLineNumber == 6)
        #expect(lines[1].newLineNumber == nil)
        // addition: only new line number
        #expect(lines[2].type == .addition)
        #expect(lines[2].oldLineNumber == nil)
        #expect(lines[2].newLineNumber == 6)
    }

    // MARK: - Word-Level Diff

    @Test func wordChangesDetected() {
        let diff = """
        diff --git a/f.txt b/f.txt
        --- a/f.txt
        +++ b/f.txt
        @@ -1 +1 @@
        -let foo = 1
        +let bar = 1
        """
        let files = DiffParser.parse(diff)
        let lines = files[0].hunks[0].lines

        // Deletion line should have word changes
        let delLine = lines[0]
        #expect(delLine.type == .deletion)
        #expect(delLine.wordChanges != nil)
        #expect(!delLine.wordChanges!.isEmpty)

        // Addition line should have word changes
        let addLine = lines[1]
        #expect(addLine.type == .addition)
        #expect(addLine.wordChanges != nil)
        #expect(!addLine.wordChanges!.isEmpty)
    }

    @Test func longLinesSkipWordDiff() {
        // Lines with >50 tokens should skip word-level diff
        let longOld = (0..<60).map { "word\($0)" }.joined(separator: " ")
        let longNew = (0..<60).map { "changed\($0)" }.joined(separator: " ")
        let diff = """
        diff --git a/f.txt b/f.txt
        --- a/f.txt
        +++ b/f.txt
        @@ -1 +1 @@
        -\(longOld)
        +\(longNew)
        """
        let files = DiffParser.parse(diff)
        let lines = files[0].hunks[0].lines
        // Word changes should be nil or empty for long lines
        let delLine = lines[0]
        #expect(delLine.wordChanges == nil || delLine.wordChanges!.isEmpty)
    }

    // MARK: - Diff --no-index (untracked files)

    @Test func noIndexDiff() {
        let diff = """
        diff --no-index /dev/null b/new-file.txt
        --- /dev/null
        +++ b/new-file.txt
        @@ -0,0 +1 @@
        +hello
        """
        let files = DiffParser.parse(diff)
        #expect(files.count == 1)
        #expect(files[0].status == .added)
    }

    // MARK: - Model Properties

    @Test func directoryAndFilename() {
        let diff = """
        diff --git a/src/views/Main.swift b/src/views/Main.swift
        --- a/src/views/Main.swift
        +++ b/src/views/Main.swift
        @@ -1 +1 @@
        -old
        +new
        """
        let files = DiffParser.parse(diff)
        #expect(files[0].directory == "src/views")
        #expect(files[0].filename == "Main.swift")
    }

    @Test func deletedFileUsesOldPathForDisplay() {
        let diff = """
        diff --git a/src/Old.swift b/src/Old.swift
        deleted file mode 100644
        --- a/src/Old.swift
        +++ /dev/null
        @@ -1 +0,0 @@
        -gone
        """
        let files = DiffParser.parse(diff)
        #expect(files[0].filename == "Old.swift")
        #expect(files[0].directory == "src")
        #expect(files[0].displayPath == "src/Old.swift")
    }

    @Test func rootFileHasEmptyDirectory() {
        let diff = """
        diff --git a/README.md b/README.md
        --- a/README.md
        +++ b/README.md
        @@ -1 +1 @@
        -old
        +new
        """
        let files = DiffParser.parse(diff)
        #expect(files[0].directory == "")
        #expect(files[0].filename == "README.md")
    }
}
