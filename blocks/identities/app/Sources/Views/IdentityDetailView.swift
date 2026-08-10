import SwiftUI

struct IdentityDetailView: View {
    let identity: Identity
    let onBack: () -> Void
    let onBarryUpdated: () -> Void

    @State private var editor: IdentityEditor

    init(identity: Identity, onBack: @escaping () -> Void, onBarryUpdated: @escaping () -> Void = {}) {
        self.identity = identity
        self.onBack = onBack
        self.onBarryUpdated = onBarryUpdated
        self._editor = State(initialValue: IdentityEditor(identity: identity))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Nav header
            HStack(spacing: 8) {
                Button(action: onBack) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 11))
                        Text("Identities")
                            .font(.system(size: 13))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.blue)

                Text(identity.label)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider()

            // Segmented control
            Picker("", selection: $editor.tab) {
                ForEach(IdentityEditor.Tab.allCases, id: \.self) { tab in
                    Text(tab.rawValue).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 6)

            // Tab content
            Group {
                switch editor.tab {
                case .info:
                    InfoPanel(identity: identity, editor: editor, onBarryUpdated: onBarryUpdated)
                case .blocks:
                    BlocksPanel(editor: editor)
                case .traits:
                    TraitsPanel(editor: editor)
                case .scopes:
                    ScopesPanel(editor: editor)
                }
            }
            .animation(.easeInOut(duration: 0.15), value: editor.tab)
        }
        .task {
            await editor.load()
        }
    }
}
