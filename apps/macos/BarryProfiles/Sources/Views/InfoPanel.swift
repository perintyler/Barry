import SwiftUI
import BarryKit

struct InfoPanel: View {
    let profile: Profile
    @Bindable var editor: ProfileEditor
    let onProfileUpdated: () -> Void

    @State private var errorMessage: String?

    /// Agent options from the catalog's provider keys (fallback list until it
    /// loads). Cursor is a valid agent but has no catalog entry — always append.
    private var agents: [String] {
        var list = editor.modelCatalog.isEmpty
            ? ["claude", "codex", "opencode", "cursor"]
            : editor.modelCatalog.keys.sorted()
        if !list.contains("cursor") { list.append("cursor") }
        return list
    }

    /// Catalog models for the selected agent, with an off-catalog current
    /// value kept selectable so it never silently disappears.
    private var modelOptions: [ModelInfo] {
        let provider = editor.selectedAgent ?? "claude"
        var options = editor.modelCatalog[provider]?.models.map {
            ModelInfo(id: $0.id, label: "\($0.label) — \($0.id)")
        } ?? []
        if let current = editor.selectedModel, !options.contains(where: { $0.id == current }) {
            options.append(ModelInfo(id: current, label: "\(current) (custom)"))
        }
        return options
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                infoField("Name") {
                    Text(profile.name)
                        .font(.system(size: 13))
                }

                infoField("Token") {
                    HStack(spacing: 6) {
                        Text(profile.token)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        Button("Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(profile.token, forType: .string)
                        }
                        .buttonStyle(.plain)
                        .font(.system(size: 10))
                        .foregroundStyle(.blue)
                    }
                }

                if let created = profile.createdAt {
                    infoField("Created") {
                        Text(formatAbsoluteTime(created) ?? created)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                }

                infoField("Last Used") {
                    Text(profile.displayLastUsed)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }

                if let email = profile.vaultEmail {
                    infoField("Vault") {
                        HStack(spacing: 5) {
                            Circle()
                                .fill(Color.green)
                                .frame(width: 6, height: 6)
                            Text(email)
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Divider().padding(.horizontal, 16).padding(.vertical, 6)

                // Agent picker
                infoField("Agent") {
                    Picker("", selection: Binding(
                        get: { editor.selectedAgent ?? "" },
                        set: { val in Task { await editor.saveAgent(val.isEmpty ? nil : val) } }
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

                // Model picker — catalog models for the selected agent, plus the
                // current value when it's off-catalog (curated, not enforced)
                infoField("Model") {
                    Picker("", selection: Binding(
                        get: { editor.selectedModel ?? "" },
                        set: { val in Task { await editor.saveModel(val.isEmpty ? nil : val) } }
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

                Divider().padding(.horizontal, 16).padding(.vertical, 6)

                // Env var pills
                if !profile.envKeys.isEmpty {
                    SectionLabel(text: "Environment Variables")
                    FlowLayout(spacing: 6) {
                        ForEach(profile.envKeys, id: \.self) { key in
                            Text(key)
                                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .background(.quaternary.opacity(0.5))
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 6)
                                        .strokeBorder(.quaternary, lineWidth: 1)
                                )
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                }

                Divider().padding(.horizontal, 16).padding(.vertical, 6)

                // Default profile status
                if profile.isDefault {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 13))
                            .foregroundStyle(.green)
                        Text("Default profile")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.green)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                } else {
                    Button {
                        Task {
                            await editor.setAsDefault()
                            onProfileUpdated()
                        }
                    } label: {
                        Text("Set as Default")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 7)
                            .background(.quaternary.opacity(0.5))
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                            .overlay(
                                RoundedRectangle(cornerRadius: 7)
                                    .strokeBorder(.quaternary, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 4)
                }

                if let err = errorMessage {
                    Text(err)
                        .font(.system(size: 11))
                        .foregroundStyle(.red)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                }

                Spacer(minLength: 16)
            }
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
}

// MARK: - FlowLayout (wrapping pills)

struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrange(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y), proposal: .unspecified)
        }
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }

        return (CGSize(width: maxWidth, height: y + rowHeight), positions)
    }
}
