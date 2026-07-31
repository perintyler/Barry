import SwiftUI

struct ContentView: View {
    @Bindable var appState: AppState

    var body: some View {
        VStack(spacing: 0) {
            if appState.showingCreateProfile {
                CreateProfileView(
                    appState: appState,
                    onDismiss: {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            appState.showingCreateProfile = false
                        }
                    }
                )
                .transition(.move(edge: .trailing).combined(with: .opacity))
            } else if appState.selectedProfileId != nil,
               let profile = appState.selectedProfile {
                ProfileDetailView(
                    profile: profile,
                    onBack: {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            appState.selectedProfileId = nil
                        }
                    },
                    onProfileUpdated: { Task { await appState.refreshProfiles() } }
                )
                .transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                ProfileListView(appState: appState)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task { appState.start() }
    }
}
