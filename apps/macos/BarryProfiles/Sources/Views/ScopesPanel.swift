import SwiftUI

struct ScopesPanel: View {
    @Bindable var editor: ProfileEditor
    @State private var showCreateScope = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SectionLabel(text: "Default Scope")
                Text("Applied to every session using this profile. Merges with any session-level scope (union of all denials).")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)

                // None option
                RadioRow(isSelected: editor.selectedScopeId == nil, action: { editor.selectScope(nil) }) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("None")
                            .font(.system(size: 13, weight: .medium))
                        Text("No restrictions \u{2014} full tool access")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                }

                // Named scopes
                ForEach(editor.allScopes) { scope in
                    RadioRow(isSelected: editor.selectedScopeId == scope.id, action: { editor.selectScope(scope.id) }) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(scope.name)
                                .font(.system(size: 13, weight: .medium))
                            if let desc = scope.description {
                                Text(desc)
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                            }
                            if !scope.denyPills.isEmpty {
                                FlowLayout(spacing: 4) {
                                    ForEach(scope.denyPills) { pill in
                                        DenyPillView(pill: pill)
                                    }
                                }
                                .padding(.top, 2)
                            }
                        }
                    }
                }

                // New scope button
                Button {
                    showCreateScope = true
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus")
                            .font(.system(size: 11))
                        Text("New Scope")
                            .font(.system(size: 12, weight: .medium))
                    }
                    .foregroundStyle(.blue)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color.blue.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(Color.blue.opacity(0.12), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 8)
            }
        }
        .sheet(isPresented: $showCreateScope) {
            CreateScopeView(editor: editor, isPresented: $showCreateScope)
        }
    }
}

// MARK: - Create Scope

struct CreateScopeView: View {
    @Bindable var editor: ProfileEditor
    @Binding var isPresented: Bool

    @State private var name = ""
    @State private var description = ""
    @State private var deniedTools: [String] = []
    @State private var deniedAccess: [String] = []
    @State private var fileDeny: [String] = []
    @State private var bashDeny: [String] = []
    @State private var isSaving = false

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack(spacing: 8) {
                Button("Cancel") { isPresented = false }
                    .buttonStyle(.plain)
                    .foregroundStyle(.blue)
                    .font(.system(size: 13))

                Text("New Scope")
                    .font(.system(size: 13, weight: .semibold))
                    .frame(maxWidth: .infinity)

                Button("Create") {
                    Task { await create() }
                }
                .buttonStyle(.plain)
                .foregroundStyle(name.isEmpty ? Color.secondary : Color.blue)
                .font(.system(size: 13, weight: .medium))
                .disabled(name.isEmpty || isSaving)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider()

            ScrollView {
                VStack(spacing: 12) {
                    formField("Name") {
                        TextField("e.g. safe-deploy", text: $name)
                            .textFieldStyle(.plain)
                            .font(.system(size: 13))
                            .padding(7)
                            .background(.quaternary.opacity(0.5))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }

                    formField("Description") {
                        TextField("What this scope restricts...", text: $description)
                            .textFieldStyle(.plain)
                            .font(.system(size: 13))
                            .padding(7)
                            .background(.quaternary.opacity(0.5))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }

                    Divider().padding(.horizontal, 16)

                    tagField("Denied Tools", hint: "Tools blocked entirely (e.g. Bash, Write, Edit)", tags: $deniedTools)
                    tagField("Denied Access", hint: "\"write\" blocks all writes, or namespace names", tags: $deniedAccess)
                    tagField("File Deny Patterns", hint: "Glob patterns (e.g. *.env, .ssh/**)", tags: $fileDeny)
                    tagField("Bash Deny Patterns", hint: "Command patterns the agent cannot run", tags: $bashDeny)
                }
                .padding(.top, 12)
                .padding(.bottom, 20)
            }
        }
        .frame(width: 380, height: 480)
        .background(.ultraThinMaterial)
    }

    @ViewBuilder
    private func formField<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .textCase(.uppercase)
                .tracking(0.5)
                .foregroundStyle(.tertiary)
            content()
        }
        .padding(.horizontal, 16)
    }

    @ViewBuilder
    private func tagField(_ label: String, hint: String, tags: Binding<[String]>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .textCase(.uppercase)
                .tracking(0.5)
                .foregroundStyle(.tertiary)
            TagInput(tags: tags)
            Text(hint)
                .font(.system(size: 10))
                .foregroundStyle(.quaternary)
        }
        .padding(.horizontal, 16)
    }

    private func create() async {
        isSaving = true
        let result = await editor.createScope(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.isEmpty ? nil : description.trimmingCharacters(in: .whitespacesAndNewlines),
            deniedTools: deniedTools,
            deniedAccess: deniedAccess,
            fileDeny: fileDeny,
            bashDeny: bashDeny
        )
        isSaving = false
        if result != nil {
            isPresented = false
        }
    }
}

// MARK: - TagInput

private struct TagInput: View {
    @Binding var tags: [String]
    @State private var input = ""

    var body: some View {
        FlowLayout(spacing: 4) {
            ForEach(tags, id: \.self) { tag in
                HStack(spacing: 3) {
                    Text(tag)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                    Button {
                        tags.removeAll { $0 == tag }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(Color.red.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .foregroundStyle(.red.opacity(0.7))
            }

            TextField("Add...", text: $input)
                .textFieldStyle(.plain)
                .font(.system(size: 11, design: .monospaced))
                .frame(minWidth: 60)
                .onSubmit {
                    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty, !tags.contains(trimmed) {
                        tags.append(trimmed)
                    }
                    input = ""
                }
        }
        .padding(6)
        .background(.quaternary.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}
