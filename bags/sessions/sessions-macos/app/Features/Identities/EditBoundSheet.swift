import Components
import SwiftUI

/// Edit an existing bound's description and deny rules.
///
/// The name is fixed. Traits reference bounds by name and file-based
/// identities copy the rules inline at assignment time, so renaming would
/// detach those references with nothing pointing at the break — the API
/// refuses it too.
struct EditBoundSheet: View {
    @Bindable var editor: IdentityEditor
    let bound: BoundRecord
    @Binding var editingBound: BoundRecord?

    @State private var description: String
    @State private var deniedTools: [String]
    @State private var deniedAccess: [String]
    @State private var fileDeny: [String]
    @State private var bashDeny: [String]
    @State private var networkActions: Set<String>
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(editor: IdentityEditor, bound: BoundRecord, editingBound: Binding<BoundRecord?>) {
        self.editor = editor
        self.bound = bound
        _editingBound = editingBound
        _description = State(initialValue: bound.description ?? "")
        _deniedTools = State(initialValue: bound.bound.deniedTools ?? [])
        _deniedAccess = State(initialValue: bound.bound.deniedAccess ?? [])
        _fileDeny = State(initialValue: bound.bound.files?.deny ?? [])
        _bashDeny = State(initialValue: bound.bound.bash?.deny ?? [])
        _networkActions = State(initialValue: Set(bound.bound.network?.actions ?? []))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Edit Bound").font(AppFont.sans(size: 13, weight: .semibold))
                    Text(bound.name).font(AppFont.mono(size: 10)).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Cancel") { editingBound = nil }
                    .font(AppFont.sans(size: 11))
                Button(isSaving ? "Saving…" : "Save") {
                    Task { await save() }
                }
                .font(AppFont.sans(size: 11, weight: .semibold))
                .disabled(isSaving)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            Divider()

            if let errorMessage {
                MessageBanner(icon: "exclamationmark.octagon", tint: Palette.red, text: errorMessage)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        fieldLabel("Description")
                        TextField("What this bound restricts…", text: $description)
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
                        fieldLabel("Network")
                        // A fixed hierarchy rather than free text: "all"
                        // expands to "write" and "read", and a mistyped tag
                        // would silently deny nothing.
                        ForEach(BoundRecord.AgentBound.networkActionChoices, id: \.self) { action in
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

    private func fieldLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(AppFont.sans(size: 9, weight: .semibold))
            .tracking(0.5)
            .foregroundStyle(.tertiary)
    }

    @ViewBuilder
    private func tagField(_ label: String, hint: String, tags: Binding<[String]>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            fieldLabel(label)
            BoundTagInput(tags: tags)
            Text(hint).font(AppFont.sans(size: 10)).foregroundStyle(.quaternary)
        }
    }

    private func save() async {
        isSaving = true
        errorMessage = nil
        let ok = await editor.updateBound(
            id: bound.id,
            description: description.isEmpty ? nil : description.trimmingCharacters(in: .whitespacesAndNewlines),
            deniedTools: deniedTools,
            deniedAccess: deniedAccess,
            fileDeny: fileDeny,
            bashDeny: bashDeny,
            network: networkActions.isEmpty ? nil : .init(actions: networkActions.sorted())
        )
        isSaving = false
        if ok {
            editingBound = nil
        } else {
            errorMessage = editor.errorMessage ?? "Could not save the bound."
        }
    }
}
