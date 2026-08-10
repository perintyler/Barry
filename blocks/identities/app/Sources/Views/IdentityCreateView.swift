import SwiftUI
import BarryKit

struct CreateIdentityView: View {
    @Bindable var appState: AppState
    let onDismiss: () -> Void

    @State private var name = ""
    @State private var selectedAgent: String?
    @State private var selectedModel: String?
    @State private var selectedBlocks: Set<String> = []
    @State private var selectedTraits: Set<String> = []

    @State private var allBlocks: [BlockInfo] = []
    @State private var allTraits: [TraitInfo] = []
    @State private var modelCatalog: [String: ProviderModels] = [:]

    @State private var blocksExpanded = false
    @State private var traitsExpanded = false

    @State private var isCreating = false
    @State private var errorMessage: String?

    private let client = IdentityClient()

    private var canCreate: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isCreating
    }

    private var agents: [String] {
        var list = modelCatalog.isEmpty
            ? ["claude", "codex", "opencode", "cursor"]
            : modelCatalog.keys.sorted()
        if !list.contains("cursor") { list.append("cursor") }
        return list
    }

    private var modelOptions: [ModelInfo] {
        let provider = selectedAgent ?? "claude"
        return modelCatalog[provider]?.models.map {
            ModelInfo(id: $0.id, label: "\($0.label) — \($0.id)")
        } ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            // Nav header
            HStack(spacing: 8) {
                Button(action: onDismiss) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 11))
                        Text("Identities")
                            .font(.system(size: 13))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.blue)

                Text("New Identity")
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider()

            ScrollView {
                VStack(spacing: 0) {
                    // ── Identity ──
                    VStack(spacing: 14) {
                        formField("Name") {
                            TextField("e.g. my-project", text: $name)
                                .textFieldStyle(.plain)
                                .font(.system(size: 13))
                                .padding(8)
                                .background(.quaternary.opacity(0.5))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 8)

                    Divider().padding(.horizontal, 16)

                    // ── Defaults ──
                    SectionLabel(text: "Defaults")

                    VStack(spacing: 0) {
                        infoField("Agent") {
                            Picker("", selection: Binding(
                                get: { selectedAgent ?? "" },
                                set: { selectedAgent = $0.isEmpty ? nil : $0 }
                            )) {
                                Text("None").tag("")
                                ForEach(agents, id: \.self) { agent in
                                    Text(agent).tag(agent)
                                }
                            }
                            .pickerStyle(.menu)
                            .labelsHidden()
                            .fixedSize()
                        }

                        infoField("Model") {
                            Picker("", selection: Binding(
                                get: { selectedModel ?? "" },
                                set: { selectedModel = $0.isEmpty ? nil : $0 }
                            )) {
                                Text("None").tag("")
                                ForEach(modelOptions, id: \.id) { model in
                                    Text(model.label).tag(model.id)
                                }
                            }
                            .pickerStyle(.menu)
                            .labelsHidden()
                            .fixedSize()
                        }
                    }

                    Divider().padding(.horizontal, 16)

                    // ── Blocks ──
                    collapsibleSection(
                        title: "Blocks",
                        isExpanded: $blocksExpanded,
                        summary: blocksSummary
                    ) {
                        blocksContent
                    }

                    Divider().padding(.horizontal, 16)

                    // ── Traits ──
                    collapsibleSection(
                        title: "Traits",
                        isExpanded: $traitsExpanded,
                        summary: traitsSummary
                    ) {
                        traitsContent
                    }

                    Spacer(minLength: 12)
                }
            }

            // ── Error + Create ──
            if let err = errorMessage {
                Text(err)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
            }

            HStack {
                Spacer()
                Button(isCreating ? "Creating…" : "Create") { create() }
                    .buttonStyle(.plain)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(canCreate ? .white : .secondary)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 7)
                    .background(canCreate ? Color.green : Color(nsColor: .quaternaryLabelColor).opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                    .disabled(!canCreate)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .overlay(alignment: .top) { Divider() }
        }
        .task { await loadOptions() }
    }

    // MARK: - Blocks Content

    private var blocksSummary: String {
        "\(selectedBlocks.count) selected"
    }

    @ViewBuilder
    private var blocksContent: some View {
        ForEach(allBlocks) { block in
            Button {
                if selectedBlocks.contains(block.name) {
                    selectedBlocks.remove(block.name)
                } else {
                    selectedBlocks.insert(block.name)
                }
            } label: {
                HStack(spacing: 10) {
                    checkMark(isChecked: selectedBlocks.contains(block.name))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(block.name)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.primary)
                        if let desc = block.description {
                            Text(desc)
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    Text(block.type == "remote" ? "remote" : "local")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Traits Content

    private var traitsSummary: String {
        "\(selectedTraits.count) selected"
    }

    @ViewBuilder
    private var traitsContent: some View {
        ForEach(allTraits) { trait in
            Button {
                if selectedTraits.contains(trait.name) {
                    selectedTraits.remove(trait.name)
                } else {
                    selectedTraits.insert(trait.name)
                }
            } label: {
                HStack(spacing: 10) {
                    checkMark(isChecked: selectedTraits.contains(trait.name))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(trait.name)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.primary)
                        if let desc = trait.description {
                            Text(desc)
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    AccessBadge(access: trait.access)
                }
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func formField<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.tertiary)
            content()
        }
    }

    private func infoField<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .center, spacing: 0) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.tertiary)
                .frame(width: 84, alignment: .leading)
            content()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
    }

    @ViewBuilder
    private func collapsibleSection<Content: View>(
        title: String,
        isExpanded: Binding<Bool>,
        summary: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                isExpanded.wrappedValue.toggle()
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10))
                    .foregroundStyle(.quaternary)
                    .rotationEffect(isExpanded.wrappedValue ? .degrees(90) : .zero)
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Text(summary)
                    .font(.system(size: 11))
                    .foregroundStyle(.quaternary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        if isExpanded.wrappedValue {
            VStack(spacing: 0) {
                content()
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
        }
    }

    @ViewBuilder
    private func checkMark(isChecked: Bool) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4)
                .strokeBorder(isChecked ? Color.clear : Color.secondary.opacity(0.3), lineWidth: 1.5)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(isChecked ? Color.green : Color.clear)
                )
                .frame(width: 16, height: 16)

            if isChecked {
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
    }

    // MARK: - Data Loading

    private func loadOptions() async {
        do {
            async let p = client.fetchAvailableBlocks()
            async let t = client.fetchTraits()
            allBlocks = try await p
            allTraits = try await t
        } catch {
            // Best-effort — lists may be empty
        }
        if let catalog = try? await client.fetchModels() {
            modelCatalog = catalog
        }
    }

    // MARK: - Create

    private func create() {
        guard canCreate else { return }
        isCreating = true
        errorMessage = nil

        Task {
            do {
                // File-based is the canonical shape for a new Identity: the
                // directory is the source of truth and the DB row is a cache.
                var body: [String: Any] = [
                    "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
                    "source": "file"
                ]
                if !selectedBlocks.isEmpty {
                    body["blocks"] = Array(selectedBlocks).sorted()
                }
                if !selectedTraits.isEmpty {
                    body["traits"] = Array(selectedTraits).sorted()
                }
                if let selectedAgent {
                    body["defaultCodingAgent"] = selectedAgent
                }
                if let selectedModel {
                    body["defaultModel"] = selectedModel
                }

                let identity = try await appState.createIdentity(body: body)
                withAnimation(.easeInOut(duration: 0.2)) {
                    appState.selectedIdentityId = identity.id
                }
            } catch {
                errorMessage = error.localizedDescription
                isCreating = false
            }
        }
    }
}
