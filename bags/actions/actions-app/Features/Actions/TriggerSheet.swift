import Components
import SwiftUI

/// Pick an action and run it in a fresh session.
struct TriggerSheet: View {
    @Bindable var state: ActionsState
    let dismiss: () -> Void

    @State private var search = ""

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(width: 820, height: 560)
        .background(Palette.windowBackground)
        .task { await state.loadCatalog() }
    }

    private var header: some View {
        HStack {
            Text("Run an action")
                .font(AppFont.sans(size: 14, weight: .semibold))
            Spacer()
            Button("Close", action: dismiss).controlSize(.small)
        }
        .padding(12)
    }

    @ViewBuilder
    private var content: some View {
        switch state.catalog {
        case .idle, .loading:
            ProgressView().controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case let .failed(message):
            FetchFailureView(message: message) {
                Task { await state.loadCatalog() }
            }

        case let .loaded(entries):
            let matches = filter(entries)
            VStack(spacing: 0) {
                TextField("Filter actions", text: $search)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("ActionFilterField")
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)

                if matches.isEmpty {
                    Spacer()
                    // Says which of the two empties this is: nothing installed,
                    // or nothing matching what was typed.
                    Text(entries.isEmpty
                        ? "No actions are installed."
                        : "No action matches “\(search)”.")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.secondary)
                    Spacer()
                } else {
                    HStack(spacing: 0) {
                        // Rows are buttons rather than a `List(selection:)`.
                        // Selection-by-click alone is unreachable to anything
                        // but a mouse — no keyboard activation, nothing for
                        // VoiceOver or a UI test to press — and this list is
                        // now the only way to reach an action's form.
                        List(matches) { entry in
                            Button {
                                state.selectedActionId = entry.id
                            } label: {
                                CatalogRow(entry: entry)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("action:\(entry.name)")
                            .listRowBackground(
                                entry.id == state.selectedActionId
                                    ? Palette.hover : Color.clear
                            )
                        }
                        .listStyle(.inset)
                        .frame(width: 240)

                        Divider()

                        detailPane(matches)
                    }
                }
            }
        }
    }

    /// The selected action's configuration: what it does, its declared inputs,
    /// and where to run it.
    ///
    /// A form of nine fields cannot live inside a list row, which is why Run
    /// moved here from the row. For the 15 actions declaring no inputs this is
    /// just description + extra + Run — strictly what the sheet showed before.
    @ViewBuilder
    private func detailPane(_ matches: [CatalogEntry]) -> some View {
        if let selected = matches.first(where: { $0.id == state.selectedActionId }) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(selected.name)
                            .font(AppFont.sans(size: 13, weight: .semibold))
                        Text(selected.description)
                            .font(AppFont.sans(size: 10))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if !selected.inputs.isEmpty {
                        Divider()
                        // Says the quiet part out loud: the form is a set of
                        // steers, not a questionnaire to complete.
                        Text("Anything you leave blank, the action decides.")
                            .font(AppFont.sans(size: 10))
                            .foregroundStyle(.tertiary)
                        InputFormView(
                            fields: selected.inputs,
                            draft: Binding(
                                get: { state.draft(for: selected) },
                                set: { state.setDraft($0, for: selected) }
                            )
                        )
                    }

                    Divider()

                    TextField(
                        "Repository path (optional — defaults to the API's directory)",
                        text: $state.triggerRepoPath
                    )
                    .textFieldStyle(.roundedBorder)
                    .font(AppFont.sans(size: 11))

                    TextField("Extra context for the run (optional)", text: $state.triggerExtra)
                        .textFieldStyle(.roundedBorder)
                        .font(AppFont.sans(size: 11))

                    HStack {
                        Spacer()
                        Button("Run") {
                            Task { await state.runAction(selected) }
                        }
                        .controlSize(.regular)
                        .keyboardShortcut(.defaultAction)
                        .disabled(state.trigger == .starting)
                        .accessibilityIdentifier("RunActionButton")
                    }
                }
                .padding(12)
            }
            .frame(maxWidth: .infinity)
        } else {
            VStack {
                Spacer()
                Text("Select an action.")
                    .font(AppFont.sans(size: 11))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .frame(maxWidth: .infinity)
        }
    }

    // Repo path and extra context moved into the detail pane, beside the
    // action they configure. The status line stays here: it reports on the
    // sheet as a whole, and a result that vanished when the selection changed
    // would be worse than one that outlives it.
    private var footer: some View {
        TriggerStatusView(outcome: state.trigger)
            .font(AppFont.sans(size: 11))
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func filter(_ entries: [CatalogEntry]) -> [CatalogEntry] {
        guard !search.isEmpty else { return entries }
        return entries.filter {
            $0.name.localizedCaseInsensitiveContains(search)
                || $0.description.localizedCaseInsensitiveContains(search)
        }
    }
}

struct CatalogRow: View {
    let entry: CatalogEntry

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(entry.name)
                        .font(AppFont.sans(size: 12, weight: .medium))
                    Text(entry.bag)
                        .font(AppFont.sans(size: 9))
                        .foregroundStyle(.tertiary)
                    if entry.executable {
                        Text("detachable")
                            .font(AppFont.sans(size: 9))
                            .foregroundStyle(Palette.blue)
                            .help("Can also run without a conversation (do_action)")
                    }
                }

                Text(entry.shortDescription)
                    .font(AppFont.sans(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)

                if !entry.inputNames.isEmpty {
                    // A count, not the names: the names are now rendered as
                    // actual controls in the detail pane, and repeating them
                    // here would only crowd a 240pt row.
                    Text("\(entry.inputNames.count) input\(entry.inputNames.count == 1 ? "" : "s")")
                        .font(AppFont.mono(size: 9))
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()
        }
        .padding(.vertical, 3)
    }
}

struct TriggerStatusView: View {
    let outcome: TriggerOutcome

    var body: some View {
        switch outcome {
        case .idle:
            // Reserve the line so the sheet does not jump when a result lands.
            Text(" ").font(AppFont.sans(size: 10))
        case .starting:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Starting…").font(AppFont.sans(size: 10))
            }
        case let .started(sessionId, action):
            // Naming the session matters: a trigger whose only feedback is a
            // spinner vanishing looks identical to one that quietly failed.
            Text("Started \(action) in session \(sessionId). The run appears in the list once the agent records it.")
                .font(AppFont.sans(size: 10))
                .foregroundStyle(Palette.green)
                .textSelection(.enabled)
        case let .failed(message):
            Text(message)
                .font(AppFont.sans(size: 10))
                .foregroundStyle(Palette.red)
                .textSelection(.enabled)
        }
    }
}
