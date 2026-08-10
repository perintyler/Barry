import SwiftUI

struct ContentView: View {
    @Bindable var appState: AppState

    var body: some View {
        VStack(spacing: 0) {
            if appState.showingCreateIdentity {
                CreateIdentityView(
                    appState: appState,
                    onDismiss: {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            appState.showingCreateIdentity = false
                        }
                    }
                )
                .transition(.move(edge: .trailing).combined(with: .opacity))
            } else if appState.selectedIdentityId != nil,
               let identity = appState.selectedIdentity {
                IdentityDetailView(
                    identity: identity,
                    onBack: {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            appState.selectedIdentityId = nil
                        }
                    },
                    onBarryUpdated: { Task { await appState.refreshIdentities() } }
                )
                .transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                IdentityListView(appState: appState)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .task { appState.start() }
    }
}
