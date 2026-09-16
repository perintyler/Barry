import Components
import SwiftUI

/// The point of the app: one run, readable end to end.
///
/// A wrap-up report reaches a transcript as an escaped-newline wall inside a
/// collapsed tool call. Here the deliverable is rendered markdown, and the
/// request that produced it sits beside it instead of being lost.
struct RunDetailView: View {
    @Bindable var state: ActionsState

    var body: some View {
        switch state.detail {
        case .idle:
            placeholder("Select a run")
        case .loading:
            ProgressView().controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            FetchFailureView(message: message) {
                Task { await state.loadDetail() }
            }
        case let .loaded(detail):
            loaded(detail)
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text)
            .font(AppFont.sans(size: 12))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func loaded(_ detail: RunDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                RunHeaderView(run: detail.summary)

                if !detail.validationFailures.isEmpty {
                    Section("Checks failed") {
                        ForEach(detail.validationFailures, id: \.self) { failure in
                            Text("• \(failure)")
                                .font(AppFont.sans(size: 11))
                                .foregroundStyle(Palette.red)
                        }
                    }
                }

                InputSideView(inputSide: detail.inputSide, truncated: detail.promptTruncated)

                if !detail.extras.isEmpty {
                    Section("Recorded") {
                        ForEach(detail.extras) { extra in
                            HStack(alignment: .top, spacing: 6) {
                                Text(extra.key)
                                    .font(AppFont.mono(size: 10))
                                    .foregroundStyle(.secondary)
                                Text(extra.value)
                                    .font(AppFont.mono(size: 10))
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }

                OutputView(run: detail)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct RunHeaderView: View {
    let run: RunSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                StatusDot(status: run.status)
                Text(run.action)
                    .font(AppFont.sans(size: 16, weight: .semibold))
                    .textSelection(.enabled)
            }

            if let summary = run.summary {
                Text(summary)
                    .font(AppFont.sans(size: 12))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 10) {
                Label(RelativeTime.describe(run.startedAt), systemImage: "clock")
                if let duration = run.duration {
                    Label(RelativeTime.duration(duration), systemImage: "timer")
                }
                Text(run.id).font(AppFont.mono(size: 10)).textSelection(.enabled)
            }
            .font(AppFont.sans(size: 10))
            .foregroundStyle(.tertiary)
        }
    }
}

/// The input side. Its three states are rendered DIFFERENTLY on purpose —
/// collapsing them would put an empty pane on screen that reads the same
/// whether nothing was sent or nothing was recorded.
struct InputSideView: View {
    let inputSide: InputSide
    let truncated: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch inputSide {
            case .notRecorded:
                Section("Input") {
                    Text("Not recorded — this run predates input capture.")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.secondary)
                }

            case let .noInputs(prompt):
                Section("Input") {
                    Text("This action declares no inputs.")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.secondary)
                }
                promptSection(prompt)

            case let .inputs(values, prompt):
                Section("Input") {
                    ForEach(values.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                        HStack(alignment: .top, spacing: 6) {
                            Text(key)
                                .font(AppFont.mono(size: 11, weight: .medium))
                            Text(value)
                                .font(AppFont.mono(size: 11))
                                .textSelection(.enabled)
                        }
                    }
                }
                promptSection(prompt)
            }
        }
    }

    private func promptSection(_ prompt: String) -> some View {
        Section("Prompt") {
            if truncated {
                Text("Truncated at the metadata cap — this is the start of the prompt.")
                    .font(AppFont.sans(size: 10))
                    .foregroundStyle(Palette.amber)
            }
            Text(prompt)
                .font(AppFont.mono(size: 11))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct OutputView: View {
    let run: RunDetail

    var body: some View {
        Section("Output") {
            if let output = run.output {
                // Rendered, not escaped: a wrap-up report is markdown, and
                // seeing it as markdown is the whole reason this window exists.
                MarkdownText(content: output)
            } else {
                // Two different reasons for no deliverable — an open run and
                // an action that declares none. Saying which is the difference
                // between a bug report and a shrug.
                Text(run.summary.status == .started
                    ? "This run never completed, so no deliverable was recorded."
                    : "This action declares no output. See the summary above.")
                    .font(AppFont.sans(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// A titled block. Named `Section` locally to keep the call sites terse; it is
/// not SwiftUI's Section and carries no list semantics.
private struct Section<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(AppFont.sans(size: 9, weight: .semibold))
                .foregroundStyle(.tertiary)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
