import Components
import SwiftUI

/// Author a trait by composing namespaces that installed bags already provide.
///
/// Most traits are generated from a bag — `{name}` and `{name}-read` — but a
/// bag-less trait is a first-class thing and a good number already exist. This
/// only ever creates bag-less ones, which is what keeps them safe: a trait
/// claiming a bag gets reconciled by `ensureTraits` the next time that bag
/// syncs, silently reverting whatever was set here.
struct CreateTraitSheet: View {
    @Bindable var editor: IdentityEditor
    @Binding var isPresented: Bool

    @State private var name = ""
    @State private var description = ""
    @State private var access = "read"
    @State private var selectedNamespaces: Set<String> = []
    @State private var selectedScopes: Set<String> = []
    @State private var isSaving = false
    @State private var errorMessage: String?

    /// The form's rules live in `TraitDraft` so they can be tested without
    /// presenting a sheet.
    private var draft: TraitDraft {
        var d = TraitDraft()
        d.name = name
        d.description = description
        d.access = access
        d.namespaces = selectedNamespaces
        d.scopeNames = selectedScopes
        return d
    }

    private var nameIsValid: Bool { draft.nameIsValid }

    private var canCreate: Bool { draft.isComplete && !isSaving }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("New Trait")
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
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 4) {
                        label("Name")
                        TextField("e.g. deploy-safe", text: $name)
                            .textFieldStyle(.plain)
                            .font(AppFont.mono(size: 12))
                            .padding(6)
                            .background(Palette.hover, in: RoundedRectangle(cornerRadius: 5))
                        // Explain the constraint while it is being violated,
                        // rather than after a failed submit.
                        if !name.isEmpty && !nameIsValid {
                            Text("Lowercase letters, digits and hyphens only.")
                                .font(AppFont.sans(size: 10))
                                .foregroundStyle(Palette.amber)
                        }
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        label("Description")
                        TextField("What this trait is for…", text: $description)
                            .textFieldStyle(.plain)
                            .font(AppFont.sans(size: 12))
                            .padding(6)
                            .background(Palette.hover, in: RoundedRectangle(cornerRadius: 5))
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        label("Access")
                        Picker("", selection: $access) {
                            Text("Read only").tag("read")
                            Text("Read & write").tag("readwrite")
                        }
                        .labelsHidden()
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 220)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        label("Namespaces")
                        if editor.availableNamespaces.isEmpty {
                            Text("No namespaces available — no installed bag exposes any.")
                                .font(AppFont.sans(size: 11))
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(editor.availableNamespaces, id: \.self) { namespace in
                                checkRow(
                                    title: namespace,
                                    isOn: selectedNamespaces.contains(namespace)
                                ) {
                                    if selectedNamespaces.contains(namespace) {
                                        selectedNamespaces.remove(namespace)
                                    } else {
                                        selectedNamespaces.insert(namespace)
                                    }
                                }
                            }
                            if selectedNamespaces.isEmpty {
                                Text("Pick at least one — a trait with no namespaces grants no tools.")
                                    .font(AppFont.sans(size: 10))
                                    .foregroundStyle(Palette.amber)
                            }
                        }
                    }

                    if !editor.allScopes.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            label("Scopes")
                            Text("Restrictions every session with this trait inherits.")
                                .font(AppFont.sans(size: 10))
                                .foregroundStyle(.tertiary)
                            ForEach(editor.allScopes, id: \.id) { scope in
                                checkRow(
                                    title: scope.name,
                                    subtitle: scope.description,
                                    isOn: selectedScopes.contains(scope.name)
                                ) {
                                    if selectedScopes.contains(scope.name) {
                                        selectedScopes.remove(scope.name)
                                    } else {
                                        selectedScopes.insert(scope.name)
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(14)
            }
        }
        .frame(width: 440, height: 540)
    }

    private func label(_ text: String) -> some View {
        Text(text.uppercased())
            .font(AppFont.sans(size: 9, weight: .semibold))
            .tracking(0.5)
            .foregroundStyle(.tertiary)
    }

    private func checkRow(
        title: String,
        subtitle: String? = nil,
        isOn: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.system(size: 12))
                    .foregroundStyle(isOn ? Palette.blue : Color.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(AppFont.mono(size: 11))
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(AppFont.sans(size: 10))
                            .foregroundStyle(.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func create() async {
        isSaving = true
        errorMessage = nil
        let ok = await editor.createTrait(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description.isEmpty ? nil : description.trimmingCharacters(in: .whitespacesAndNewlines),
            namespaces: selectedNamespaces.sorted(),
            access: access,
            scopeNames: selectedScopes.sorted()
        )
        isSaving = false
        if ok {
            isPresented = false
        } else {
            errorMessage = editor.errorMessage ?? "Could not create the trait."
        }
    }
}
