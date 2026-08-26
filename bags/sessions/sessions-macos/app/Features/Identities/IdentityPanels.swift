import AppKit
import Components
import SwiftUI

// MARK: - Info

struct IdentityInfoPanel: View {
    @Bindable var editor: IdentityEditor

    private var identity: Identity { editor.identity }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            section("Identity") {
                row("Name", value: identity.name, mono: true)
                row("Display name", value: identity.displayName ?? "—")
                row("Source", value: identity.isFileBased ? "Directory on disk" : "Database")
                if !identity.isFileBased {
                    // A file-based Barry's token is a synthetic placeholder
                    // derived from its name — it authenticates nothing, so
                    // offering it to copy would be misleading.
                    row("Token", value: identity.token, mono: true, copyable: true)
                }
                row("Created", value: identity.createdAt ?? "—")
                row("Last used", value: identity.displayLastUsed)
            }

            section("Defaults") {
                LabeledField("Agent") {
                    Picker("", selection: Binding(
                        get: { editor.selectedAgent ?? "" },
                        set: { newValue in
                            Task { await editor.saveAgent(newValue.isEmpty ? nil : newValue) }
                        }
                    )) {
                        Text("Provider default").tag("")
                        ForEach(editor.modelCatalog.keys.sorted(), id: \.self) { provider in
                            Text(provider).tag(provider)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 220)
                }
                LabeledField("Native tools") {
                    Toggle("", isOn: Binding(
                        get: { identity.allowNativeTools ?? false },
                        set: { allow in Task { await editor.saveAllowNativeTools(allow) } }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
                }
            }

            section("Notifier") {
                if let notify = identity.statusNotify {
                    row("Tool", value: notify.tool, mono: true)
                    row("Target", value: notify.target ?? "—", mono: true)
                    Button("Clear notifier") {
                        Task { await editor.saveNotifier(tool: nil, target: nil) }
                    }
                    .font(AppFont.sans(size: 11))
                } else {
                    Text("No notifier — status updates are recorded but not announced.")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.secondary)
                }
            }

            section("Environment") {
                if identity.envKeys.isEmpty {
                    Text("No environment variables.")
                        .font(AppFont.sans(size: 11))
                        .foregroundStyle(.secondary)
                } else {
                    // Keys and provenance only — never values. A file-based
                    // Barry keeps literal secrets in its .env, so the API
                    // reports only where each one resolves from and setting a
                    // value stays with the CLI, which can write the keychain.
                    ForEach(identity.envKeys.sorted(), id: \.self) { key in
                        HStack(spacing: 6) {
                            Text(key)
                                .font(AppFont.mono(size: 11))
                            // One colour. An earlier version flagged inline
                            // values amber, which read as a warning about
                            // secrets — but inline is the right home for
                            // config like SENTRY_ORG or TEMPORAL_HOST, and the
                            // matching tokens are already in the keychain. The
                            // provenance is worth showing; the alarm was not.
                            TagBadge(
                                text: identity.envSource(for: key).uppercased(),
                                color: Palette.blue
                            )
                            Spacer()
                        }
                    }
                    Text("Set a value with:  barry vault set-env KEY VALUE --source keychain")
                        .font(AppFont.mono(size: 10))
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                        .padding(.top, 2)
                }
            }
        }
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(AppFont.sans(size: 9, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(.tertiary)
            content()
        }
    }

    @ViewBuilder
    private func row(_ label: String, value: String, mono: Bool = false, copyable: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: 96, alignment: .leading)
            Text(value)
                .font(mono ? AppFont.mono(size: 11) : AppFont.sans(size: 11))
                .textSelection(.enabled)
            if copyable {
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(value, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc").font(.system(size: 9))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }
    }
}

private struct LabeledField<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content

    init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: 96, alignment: .leading)
            content
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Bags

struct IdentityBagsPanel: View {
    @Bindable var editor: IdentityEditor

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            FilterField(
                text: Binding(
                    get: { editor.filterText(for: .bags) },
                    set: { editor.setFilterText($0, for: .bags) }
                ),
                placeholder: "Filter bags"
            )

            if !editor.enabledBags.isEmpty {
                groupLabel("Enabled")
                ForEach(editor.enabledBags, id: \.name) { bag in
                    ToggleRow(
                        title: bag.name,
                        subtitle: bag.description,
                        isOn: true
                    ) { editor.toggleBag(bag.name) }
                }
            }

            groupLabel("Available")
            ForEach(editor.availableBags, id: \.name) { bag in
                ToggleRow(
                    title: bag.name,
                    subtitle: bag.description,
                    isOn: false
                ) { editor.toggleBag(bag.name) }
            }

            if editor.hasPendingChanges {
                PendingBar(count: editor.pendingChangeCount) {
                    Task { await editor.applyPending() }
                } onReset: {
                    editor.resetPending()
                }
            }
        }
    }

    private func groupLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(AppFont.sans(size: 9, weight: .semibold))
            .tracking(0.5)
            .foregroundStyle(.tertiary)
    }
}

// MARK: - Traits

struct IdentityTraitsPanel: View {
    @Bindable var editor: IdentityEditor
    @State private var isCreatingTrait = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            FilterField(
                text: Binding(
                    get: { editor.filterText(for: .traits) },
                    set: { editor.setFilterText($0, for: .traits) }
                ),
                placeholder: "Filter traits"
            )

            // Most traits are generated one-per-bag, so without the owning bag
            // this is a flat list of names with no way to tell where any of them
            // came from — even though Bags is the adjacent tab of this same pane.
            // A trait with no bag is hand-authored (or a cross-bag composite like
            // `all`/`read`/`coding`) and deliberately shows no badge.
            ForEach(editor.filteredTraits, id: \.name) { trait in
                ToggleRow(
                    title: trait.name,
                    subtitle: trait.description,
                    isOn: editor.selectedTraits.contains(trait.name),
                    badge: trait.bag
                ) { editor.toggleTrait(trait.name) }
            }

            Divider()

            Button {
                isCreatingTrait = true
            } label: {
                Label("New Trait", systemImage: "plus")
                    .font(AppFont.sans(size: 11))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.blue)

            if editor.hasPendingChanges {
                PendingBar(count: editor.pendingChangeCount) {
                    Task { await editor.applyPending() }
                } onReset: {
                    editor.resetPending()
                }
            }
        }
        .sheet(isPresented: $isCreatingTrait) {
            CreateTraitSheet(editor: editor, isPresented: $isCreatingTrait)
        }
    }
}

// MARK: - Scopes

struct IdentityScopesPanel: View {
    @Bindable var editor: IdentityEditor
    @State private var isCreatingScope = false
    @State private var editingScope: ScopeRecord?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Assigning a named scope is what a file-based identity can't do:
            // it has no row to hold a scope_id, so it copies deny rules inline
            // instead. Authoring scopes is a different question — a scope is a
            // global record, created and edited independently of whichever
            // identity happens to be selected — so the create and edit
            // affordances stay available either way. Nesting them under this
            // branch hid them entirely on a machine whose identities are all
            // file-based, which is every machine by default.
            if editor.isFileBased {
                Text("This identity keeps its deny rules inline in identity.yaml, so it can't be assigned a named scope.")
                    .font(AppFont.sans(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Named scopes are a database concept; a directory copies the rules instead so it stays self-contained. You can still author them here — traits reference scopes by name.")
                    .font(AppFont.sans(size: 10))
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)

                Divider()

                scopeList(selectable: false)
            } else {
                scopeList(selectable: true)
                ToggleRow(title: "None", subtitle: "No named scope", isOn: editor.selectedScopeId == nil) {
                    editor.selectScope(nil)
                }
            }

            Divider()

            Button {
                isCreatingScope = true
            } label: {
                Label("New Scope", systemImage: "plus")
                    .font(AppFont.sans(size: 11))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.blue)
        }
        .sheet(isPresented: $isCreatingScope) {
            CreateScopeSheet(editor: editor, isPresented: $isCreatingScope)
        }
        .sheet(item: $editingScope) { scope in
            EditScopeSheet(editor: editor, scope: scope, editingScope: $editingScope)
        }
    }

    /// The scope list, with or without the assignment control.
    ///
    /// `selectable: false` for a file-based identity: the rows are still worth
    /// showing and still editable, but tapping one cannot assign it.
    @ViewBuilder
    private func scopeList(selectable: Bool) -> some View {
        if editor.allScopes.isEmpty {
            Text("No named scopes yet.")
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.secondary)
        } else {
            ForEach(editor.allScopes, id: \.id) { scope in
                HStack(spacing: 6) {
                    if selectable {
                        ToggleRow(
                            title: scope.name,
                            subtitle: scope.description,
                            isOn: editor.selectedScopeId == scope.id
                        ) { editor.selectScope(scope.id) }
                    } else {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(scope.name).font(AppFont.sans(size: 12))
                            if let description = scope.description, !description.isEmpty {
                                Text(description)
                                    .font(AppFont.sans(size: 10))
                                    .foregroundStyle(.tertiary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    Button {
                        editingScope = scope
                    } label: {
                        Image(systemName: "pencil").font(.system(size: 10))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tertiary)
                    .help("Edit this scope's rules")
                }
            }
        }
    }
}

// MARK: - Shared bits

private struct FilterField: View {
    @Binding var text: String
    let placeholder: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "line.3.horizontal.decrease")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
            TextField(placeholder, text: $text)
                .textFieldStyle(.plain)
                .font(AppFont.sans(size: 11))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Palette.hover, in: RoundedRectangle(cornerRadius: 6))
    }
}

private struct ToggleRow: View {
    let title: String
    let subtitle: String?
    let isOn: Bool
    /// Trailing provenance, e.g. the bag a trait came from. Nil renders nothing.
    var badge: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.system(size: 12))
                    .foregroundStyle(isOn ? Palette.blue : Color.secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(AppFont.sans(size: 12))
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(AppFont.sans(size: 10))
                            .foregroundStyle(.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
                if let badge, !badge.isEmpty {
                    TagBadge(text: badge)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct PendingBar: View {
    let count: Int
    let onApply: () -> Void
    let onReset: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text("\(count) pending change\(count == 1 ? "" : "s")")
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.secondary)
            Spacer()
            Button("Revert", action: onReset).font(AppFont.sans(size: 11))
            Button("Apply", action: onApply)
                .font(AppFont.sans(size: 11, weight: .semibold))
                .keyboardShortcut(.return, modifiers: .command)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Palette.hover, in: RoundedRectangle(cornerRadius: 6))
    }
}
