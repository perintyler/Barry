import SwiftUI

struct ProfileDetailView: View {
    let profile: Profile
    let onBack: () -> Void
    let onProfileUpdated: () -> Void

    @State private var editor: ProfileEditor

    init(profile: Profile, onBack: @escaping () -> Void, onProfileUpdated: @escaping () -> Void = {}) {
        self.profile = profile
        self.onBack = onBack
        self.onProfileUpdated = onProfileUpdated
        self._editor = State(initialValue: ProfileEditor(profile: profile))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Nav header
            HStack(spacing: 8) {
                Button(action: onBack) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 11))
                        Text("Profiles")
                            .font(.system(size: 13))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.blue)

                Text(profile.name)
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
                ForEach(ProfileEditor.Tab.allCases, id: \.self) { tab in
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
                    InfoPanel(profile: profile, editor: editor, onProfileUpdated: onProfileUpdated)
                case .packs:
                    PacksPanel(editor: editor)
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
