import Components
import SwiftUI

/// Create a named scope, from the Scopes tab.
///
/// Carried over from the retired menu bar app — it was the one capability the
/// window rewrite left behind. Scopes only ever accumulate restrictions, so
/// every field here is a deny list; there is no allow form to get wrong.
struct CreateScopeSheet: View {
    @Bindable var editor: IdentityEditor
    @Binding var isPresented: Bool

    @State private var name = ""
    @State private var description = ""
    @State private var deniedTools: [String] = []
    @State private var deniedAccess: [String] = []
    @State private var fileDeny: [String] = []
    @State private var bashDeny: [String] = []
    @State private var networkActions: Set<String> = []
    @State private var isSaving = false
    @State private var errorMessage: String?

    private var canCreate: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("New Scope")
                    .font(AppFont.sans(size: 13, weight: .semibold))
                Spacer()
                Button("Cancel") { isPresented = false }
                    .font(AppFont.sans(size: 11))
                Button(isSaving ? "Creating…" : "Create") {
                    Task { await create() }
                }
                .font(AppFont.sans(size: 11, weight: .semibold))
                .disabled(!canCreate)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            Divider()

            if let errorMessage {
                MessageBanner(icon: "exclamationmark.octagon", tint: Palette.red, text: errorMessage)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    field("Name") {
                        TextField("e.g. safe-deploy", text: $name)
                            .textFieldStyle(.plain)
                            .font(AppFont.sans(size: 12))
                            .padding(6)
                            .background(Palette.hover, in: RoundedRectangle(cornerRadius: 5))
                    }
                    field("Description") {
                        TextField("What this scope restricts…", text: $description)
                            .textFieldStyle(.plain)
                            .font(AppFont.sans(size: 12))
                            .padding(6)
                            .background(Palette.hover, in: RoundedRectangle(cornerRadius: 5))
                    }

                    Divider()

                    tagField("Denied tools", hint: "Blocked entirely — Bash, Write, Edit", tags: $deniedTools)
                    tagField("Denied access", hint: "\"write\" blocks all writes, or name a namespace", tags: $deniedAccess)
                    tagField("File deny globs", hint: "*.env, .ssh/**", tags: $fileDeny)
                    tagField("Bash deny patterns", hint: "Command patterns the agent cannot run", tags: $bashDeny)

                    VStack(alignment: .leading, spacing: 4) {
                        Text("NETWORK")
                            .font(AppFont.sans(size: 9, weight: .semibold))
                            .tracking(0.5)
                            .foregroundStyle(.tertiary)
                        ForEach(ScopeRecord.AgentScope.networkActionChoices, id: \.self) { action in
                            Button {
                                if networkActions.contains(action) {
                                    networkActions.remove(action)
                                } else {
                                    networkActions.insert(action)
                                }
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: networkActions.contains(action) ? "checkmark.square.fill" : "square")
                                        .font(.system(size: 12))
                                        .foregroundStyle(networkActions.contains(action) ? Palette.red : Color.secondary)
                                    Text("deny \(action)").font(AppFont.mono(size: 11))
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                        Text("\"all\" covers both; \"write\" still permits reads.")
                            .font(AppFont.sans(size: 10))
                            .foregroundStyle(.quaternary)
                    }
                }
                .padding(14)
            }
        }
        .frame(width: 420, height: 500)
    }

    @ViewBuilder
    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(AppFont.sans(size: 9, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(.tertiary)
            content()
        }
    }

    @ViewBuilder
    private func tagField(_ label: String, hint: String, tags: Binding<[String]>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(AppFont.sans(size: 9, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(.tertiary)
            ScopeTagInput(tags: tags)
            Text(hint)
                .font(AppFont.sans(size: 10))
                .foregroundStyle(.quaternary)
        }
    }

    private func create() async {
        isSaving = true
        errorMessage = nil
        let created = await editor.createScope(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.isEmpty ? nil : description.trimmingCharacters(in: .whitespacesAndNewlines),
            deniedTools: deniedTools,
            deniedAccess: deniedAccess,
            fileDeny: fileDeny,
            bashDeny: bashDeny,
            network: networkActions.isEmpty ? nil : .init(actions: networkActions.sorted())
        )
        // Always cleared, on both paths. The old create view left `isCreating`
        // true forever on success and only happened to look right because the
        // view was replaced.
        isSaving = false
        if created != nil {
            isPresented = false
        } else {
            // createScope routes failures to the editor; surface it here rather
            // than dismissing over a scope that was never created.
            errorMessage = editor.errorMessage ?? "Could not create the scope."
        }
    }
}

/// Free-text list input: type, press return, get a removable pill.
/// Shared with the edit sheet, which needs the identical control.
struct ScopeTagInput: View {
    @Binding var tags: [String]
    @State private var input = ""

    var body: some View {
        FlowLayout(spacing: 4) {
            ForEach(tags, id: \.self) { tag in
                HStack(spacing: 3) {
                    Text(tag).font(AppFont.mono(size: 10))
                    Button {
                        tags.removeAll { $0 == tag }
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 7, weight: .bold))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .foregroundStyle(Palette.red)
                .background(Palette.red.opacity(0.10), in: RoundedRectangle(cornerRadius: 4))
            }

            TextField("Add…", text: $input)
                .textFieldStyle(.plain)
                .font(AppFont.mono(size: 10))
                .frame(minWidth: 60)
                .onSubmit {
                    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty, !tags.contains(trimmed) { tags.append(trimmed) }
                    input = ""
                }
        }
        .padding(6)
        .background(Palette.hover, in: RoundedRectangle(cornerRadius: 5))
    }
}

/// Wraps subviews onto as many rows as they need.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                proposal: .unspecified
            )
        }
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0

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
