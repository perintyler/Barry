import AppKit
import Components
import SwiftUI

/// Detail pane for one identity: header, tab strip, panel, message banners.
struct IdentityDetailPane: View {
    let identity: Identity
    @ObservedObject var state: IdentitiesState
    @State private var editor: IdentityEditor
    @State private var deleteError: String?
    @State private var isConfirmingDelete = false

    init(identity: Identity, state: IdentitiesState) {
        self.identity = identity
        self.state = state
        _editor = State(initialValue: IdentityEditor(identity: identity))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            tabStrip
            Divider()

            // Errors and warnings are rendered HERE, once, for every tab.
            //
            // The old app set `IdentityEditor.errorMessage` in four places and
            // read it in none: InfoPanel declared its own @State shadow that
            // nothing ever assigned. Every failure — a rejected scope, a failed
            // set-active, a bag save that didn't take — was silent. Warnings had
            // the mirror problem: shown only on Info, so a bag change that came
            // back "run barry pack first" looked like it had simply worked.
            messages

            ScrollView {
                panel.padding(14)
            }
        }
        .task { await editor.load() }
        .alert("Delete \(identity.label)?", isPresented: $isConfirmingDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                Task {
                    deleteError = await state.delete(id: identity.id)
                }
            }
        } message: {
            Text("This removes the identity and its configuration. Sessions already running are unaffected.")
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(identity.label)
                    .font(AppFont.sans(size: 16, weight: .semibold))
                HStack(spacing: 6) {
                    Text(identity.name)
                        .font(AppFont.mono(size: 11))
                        .foregroundStyle(.secondary)
                    if identity.isFileBased {
                        TagBadge(text: "FILE", color: Palette.blue)
                    }
                    if identity.isDefault {
                        TagBadge(text: "ACTIVE", color: Palette.green)
                    }
                }
            }
            Spacer()
            if !identity.isDefault {
                Button("Set as Active") {
                    Task {
                        await editor.setAsActive()
                        await state.refresh()
                    }
                }
                .font(AppFont.sans(size: 11))
            }
            // Deleting a file-based identity would mean removing a directory
            // the user owns, which the API declines — so the button isn't
            // offered rather than being offered and then failing.
            if !identity.isFileBased {
                Button(role: .destructive) {
                    isConfirmingDelete = true
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.red)
                .help("Delete this identity")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var tabStrip: some View {
        HStack(spacing: 2) {
            ForEach(IdentityEditor.Tab.allCases, id: \.self) { tab in
                Button {
                    editor.tab = tab
                } label: {
                    Text(tab.rawValue)
                        .font(AppFont.sans(size: 11, weight: editor.tab == tab ? .semibold : .regular))
                        .foregroundStyle(editor.tab == tab ? Color.primary : Color.secondary)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(
                            editor.tab == tab ? Palette.hover : Color.clear,
                            in: RoundedRectangle(cornerRadius: 6)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
    }

    @ViewBuilder
    private var messages: some View {
        if let error = deleteError ?? editor.errorMessage {
            MessageBanner(
                icon: "exclamationmark.octagon",
                tint: Palette.red,
                text: error
            )
        }
        // Warnings show on the tab that produced them, so a bag warning is
        // visible where the bag was changed.
        if !editor.warnings.isEmpty, editor.messageTab == nil || editor.messageTab == editor.tab {
            ForEach(editor.warnings, id: \.self) { warning in
                MessageBanner(icon: "exclamationmark.triangle", tint: Palette.amber, text: warning)
            }
        }
    }

    @ViewBuilder
    private var panel: some View {
        switch editor.tab {
        case .info:   IdentityInfoPanel(editor: editor)
        case .bags:   IdentityBagsPanel(editor: editor)
        case .traits: IdentityTraitsPanel(editor: editor)
        case .scopes: IdentityScopesPanel(editor: editor)
        }
    }
}

struct MessageBanner: View {
    let icon: String
    let tint: Color
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10))
                .foregroundStyle(tint)
            Text(text)
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(tint.opacity(0.08))
    }
}
