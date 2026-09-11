import ApprovalsFeature
import BarrySessionsCore
import Components
import EventsFeature
import ServicesFeature
import SwiftUI

struct ContentView: View {
    @Bindable var appState: AppState
    let eventsState: EventsState
    let servicesState: ServicesState
    let approvalsState: ApprovalsState
    /// Opens the identities manager. Supplied by the app delegate, which owns
    /// the launch.
    var onOpenIdentities: () -> Void = {}
    /// Opens the action-run reader. Same arrangement as `onOpenIdentities`.
    var onOpenActions: () -> Void = {}
    /// Opens the plans editor. Same arrangement as `onOpenIdentities`.
    var onOpenPlans: () -> Void = {}
    @State private var searchState = SearchState()
    @State private var targetMessageSequence: Int?
    @State private var tab: RootTab = RootNavigation.home
    @State private var railIcons: [AppRailIcon] = []

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                // The switcher is hidden while a session is open: that screen
                // has its own back button and its own tab row, and stacking a
                // second row above the first read as two competing navigations.
                if RootNavigation.showsTabBar(selected: tab, isShowingDetail: isShowingSessionDetail) {
                    tabBar
                    Divider()
                }

                switch tab {
                case .sessions:
                    sessionsTab
                case .events:
                    EventsView(state: eventsState)
                case .approvals:
                    ApprovalsView(state: approvalsState)
                case .services:
                    ServicesView(appState: servicesState)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // A layout sibling rather than an overlay: the popover is a fixed
            // 580pt and a floating rail would permanently cover the right edge
            // of every session row. The rail is not gated on `showsTabBar` —
            // it is an exit, not navigation, and hiding it inside the screen
            // you are deepest in is backwards.
            AppRail(icons: railIcons, onOpen: open)
        }
        .background(Palette.windowBackground)
        .task { appState.start() }
        .task {
            // Resolved once per open rather than in `body`: the lookup touches
            // the filesystem, and hover alone re-evaluates the rail.
            railIcons = AppRailIconResolver.resolveAll()
        }
        .onChange(of: appState.homeResetToken) {
            // The popover closed: drop the query and the pending scroll target
            // so the next open starts clean. `selectedSessionId` is cleared by
            // `AppState.resetToHome()` itself.
            //
            // No modal can be open now that session creation is gone, but the
            // guard stays so re-adding one can't silently reintroduce the bug
            // of a sheet's backdrop resetting out from under it.
            guard PopoverNavigation.shouldResetToHome(
                isPresentingModal: false
            ) else { return }
            searchState.clear()
            targetMessageSequence = nil
            tab = RootNavigation.home
        }
        .onChange(of: appState.requestedTabToken) {
            // The delegate asked for a specific tab (currently only Shutdown,
            // which needs the services view on screen to confirm).
            if let requested = appState.requestedTab { tab = requested }
        }
        .onChange(of: tab) {
            // Switching tabs changes whether the feed is on screen, which is
            // what gates event notifications. The popover is necessarily open
            // if the user just tapped a tab.
            eventsState.isFeedVisible = RootNavigation.isVisible(
                .events, selected: tab, whilePopoverOpen: true
            )
        }
    }

    private var isShowingSessionDetail: Bool {
        tab == .sessions && appState.selectedSessionId != nil && appState.selectedSession != nil
    }

    private var tabBar: some View {
        HStack(spacing: 2) {
            ForEach(RootTab.allCases, id: \.self) { candidate in
                TabButton(
                    title: candidate.title,
                    badge: candidate == .events ? eventsState.unreadCount : 0,
                    isSelected: candidate == tab
                ) {
                    tab = candidate
                }
            }
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    /// Route a rail entry to whatever opens it.
    ///
    /// The app cases go through the delegate's closures, which close the
    /// popover before launching — it is `.transient` and would otherwise race
    /// the launch and fire `popoverDidClose` midway.
    private func open(_ entry: AppRailEntry) {
        switch entry.destination {
        case .web(let url):
            NSWorkspace.shared.open(url)
        case .app(let location):
            guard let launch = launcher(for: location) else {
                // A rail entry nobody wired up. Loud on purpose: falling
                // through quietly would leave a real-looking icon that does
                // nothing, which is the failure this rail exists to make
                // visible for missing apps.
                assertionFailure("No launcher wired for \(location.bundleName)")
                NSLog("Rail entry \(entry.id) has no launcher")
                return
            }
            launch()
        }
    }

    /// Nil for an app the rail lists but nothing here opens — see `open`,
    /// which refuses to fail quietly on it.
    private func launcher(for location: BarryAppLocation) -> (() -> Void)? {
        if location == .identities { return onOpenIdentities }
        if location == .actions { return onOpenActions }
        if location == .plans { return onOpenPlans }
        return nil
    }

    @ViewBuilder
    private var sessionsTab: some View {
        if appState.selectedSessionId != nil, let session = appState.selectedSession {
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
                searchState: searchState,
                onSelectResult: { sessionId, sequence in
                    // The query is left standing so backing out of the
                    // session returns to the results that led here.
                    targetMessageSequence = sequence
                    appState.selectedSessionId = sessionId
                }
            )
        }
    }
}

/// One root tab. Carries an unread count so Events can show its backlog
/// without the user having to open the tab to discover it.
private struct TabButton: View {
    let title: String
    let badge: Int
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(title)
                    .font(AppFont.sans(size: 12, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                if badge > 0 {
                    Text(badge > 99 ? "99+" : "\(badge)")
                        .font(AppFont.sans(size: 9, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Palette.blue, in: Capsule())
                }
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(
                isSelected ? Palette.hover : Color.clear,
                in: RoundedRectangle(cornerRadius: 6)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
