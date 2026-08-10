import Components
import SwiftUI

struct ContentView: View {
    @Bindable var appState: AppState
    @State private var searchState = SearchState()
    @State private var isSearching = false
    @State private var targetMessageSequence: Int?
    @State private var isCreatingSession = false

    var body: some View {
        VStack(spacing: 0) {
            if isSearching {
                SearchView(
                    searchState: searchState,
                    onSelectResult: { sessionId, sequence in
                        isSearching = false
                        targetMessageSequence = sequence
                        appState.selectedSessionId = sessionId
                    },
                    onDismiss: {
                        isSearching = false
                        searchState.clear()
                    }
                )
            } else if appState.selectedSessionId != nil,
               let session = appState.selectedSession {
                SessionDetailView(
                    session: session,
                    scrollToSequence: targetMessageSequence,
                    onBack: {
                        appState.selectedSessionId = nil
                        targetMessageSequence = nil
                    },
                    onSessionUpdated: { Task { await appState.refreshSessions() } }
                )
            } else {
                SessionListView(
                    appState: appState,
                    onSearch: { isSearching = true },
                    onNewSession: { isCreatingSession = true }
                )
            }
        }
        .background(Color.adaptive(
            light: Color(red: 0.976, green: 0.976, blue: 0.980),  // #f9f9fa
            dark: Color(red: 0.133, green: 0.133, blue: 0.149)    // #222226
        ))
        .task { appState.start() }
        .sheet(isPresented: $isCreatingSession) {
            NewSessionView(appState: appState, isPresented: $isCreatingSession)
                .frame(width: 520, height: 620)
        }
    }
}
