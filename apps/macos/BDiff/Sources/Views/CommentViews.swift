import SwiftUI

/// Inset from the left edge to clear the line-number column + gutter stripe.
private let commentInset: CGFloat = 53

/// Inline thread shown under a commented diff line: the comment body,
/// any replies, resolution note, and a reply field for open comments.
struct CommentThreadView: View {
    @Bindable var appState: AppState
    let comments: [ReviewComment]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(comments) { comment in
                commentCard(comment)
            }
        }
        .padding(.leading, commentInset)
        .padding(.trailing, 12)
        .padding(.vertical, 6)
        .background(Theme.mantle)
    }

    private func commentCard(_ comment: ReviewComment) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "person.circle.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.overlay1)
                Text("You")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.subtext1)

                if let rangeLabel = comment.rangeLabel {
                    Text(rangeLabel)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Theme.overlay0)
                }

                if comment.isResolved {
                    Label("Resolved", systemImage: "checkmark.circle.fill")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Theme.green)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Theme.green.opacity(0.12))
                        .clipShape(Capsule())
                }

                Spacer()

                if !comment.isResolved {
                    Button {
                        Task { @MainActor in
                            await appState.deleteComment(comment)
                        }
                    } label: {
                        Image(systemName: "trash")
                            .font(.system(size: 10))
                            .foregroundStyle(Theme.overlay0)
                    }
                    .buttonStyle(.plain)
                    .help("Delete comment")
                }
            }

            Text(comment.body)
                .font(.system(size: 12))
                .foregroundStyle(comment.isResolved ? Theme.subtext0 : Theme.text)
                .textSelection(.enabled)

            ForEach(comment.replies) { reply in
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: reply.author == "agent" ? "sparkles" : "person.circle.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(reply.author == "agent" ? Theme.mauve : Theme.overlay1)
                        .padding(.top, 2)
                    Text(reply.body)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.subtext1)
                        .textSelection(.enabled)
                }
                .padding(.leading, 4)
            }

            if let note = comment.resolutionNote {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.green)
                        .padding(.top, 2)
                    Text(note)
                        .font(.system(size: 12))
                        .italic()
                        .foregroundStyle(Theme.subtext1)
                        .textSelection(.enabled)
                }
                .padding(.leading, 4)
            }

            if !comment.isResolved {
                replyField(comment)
            }
        }
        .padding(10)
        .background(Theme.base)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(comment.isResolved ? Theme.green.opacity(0.35) : Theme.surface1, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .opacity(comment.isResolved ? 0.8 : 1)
    }

    private func replyField(_ comment: ReviewComment) -> some View {
        HStack(spacing: 6) {
            TextField(
                "Reply…",
                text: Binding(
                    get: { appState.replyDrafts[comment.id] ?? "" },
                    set: { appState.replyDrafts[comment.id] = $0 }
                ),
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(.system(size: 12))
            .lineLimit(1...4)
            .padding(6)
            .background(Theme.mantle)
            .clipShape(RoundedRectangle(cornerRadius: 5))
            .onSubmit { submitReply(comment) }

            Button {
                submitReply(comment)
            } label: {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(replyDraftEmpty(comment) ? Theme.overlay0 : Theme.accent)
            }
            .buttonStyle(.plain)
            .disabled(replyDraftEmpty(comment))
            .help("Send reply")
        }
        .padding(.top, 2)
    }

    private func replyDraftEmpty(_ comment: ReviewComment) -> Bool {
        (appState.replyDrafts[comment.id] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submitReply(_ comment: ReviewComment) {
        let draft = appState.replyDrafts[comment.id] ?? ""
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        Task { @MainActor in
            await appState.replyToComment(comment, body: draft)
        }
    }
}

/// Inline composer shown under the line being commented on.
struct CommentComposerView: View {
    @Bindable var appState: AppState
    let lineContent: String

    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let start = appState.composingLineStart, let anchor = appState.composingAnchor {
                Text("Lines \(start)–\(anchor.line)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Theme.accent)
            }

            TextField("Leave a comment…", text: $appState.commentDraft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .lineLimit(2...8)
                .focused($focused)
                .padding(8)
                .background(Theme.mantle)
                .clipShape(RoundedRectangle(cornerRadius: 5))

            HStack {
                if let session = appState.selectedSession {
                    Group {
                        if session.isLive {
                            Text("→ delivered to **\(session.name)** (live)")
                                .foregroundStyle(Theme.mauve)
                        } else {
                            Text("queued for the next session")
                                .foregroundStyle(Theme.overlay1)
                        }
                    }
                    .font(.system(size: 10.5))
                }
                Spacer()
                Button("Cancel") { appState.cancelComment() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .keyboardShortcut(.cancelAction)

                Button("Comment") {
                    Task { @MainActor in
                        await appState.submitComment(lineContent: lineContent)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(appState.commentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(10)
        .background(Theme.base)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(Theme.accent.opacity(0.5), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .padding(.leading, commentInset)
        .padding(.trailing, 12)
        .padding(.vertical, 6)
        .background(Theme.mantle)
        .onAppear { focused = true }
    }
}
