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
        .frame(width: 620, height: 520)
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
                    List(matches) { entry in
                        CatalogRow(entry: entry, state: state)
                    }
                    .listStyle(.inset)
                }
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(
                "Repository path (optional — defaults to the API's directory)",
                text: $state.triggerRepoPath
            )
            .textFieldStyle(.roundedBorder)

            TextField("Extra context for the run (optional)", text: $state.triggerExtra)
                .textFieldStyle(.roundedBorder)

            TriggerStatusView(outcome: state.trigger)
        }
        .font(AppFont.sans(size: 11))
        .padding(12)
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
    @Bindable var state: ActionsState

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
                    // Named rather than collected: this app has no per-action
                    // input form yet, so the honest thing is to say what the
                    // action expects and let the free-text box carry it.
                    Text("inputs: \(entry.inputNames.joined(separator: ", "))")
                        .font(AppFont.mono(size: 9))
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()

            Button("Run") {
                Task { await state.runAction(entry) }
            }
            .controlSize(.small)
            .disabled(state.trigger == .starting)
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
