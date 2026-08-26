import Components
import SwiftUI

public struct ServicesView: View {
    @Bindable var appState: ServicesState

    public init(appState: ServicesState) {
        self.appState = appState
    }

    /// The filter is reachable by keyboard but never steals focus on open:
    /// this is a popover people mostly open to glance at, and grabbing the
    /// keyboard every time would make a stray keystroke type into a text
    /// field instead of doing nothing.
    @FocusState private var searchFocused: Bool

    public var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Barry Services")
                    .font(.system(size: 13, weight: .semibold))

                // A red dot several rows down is easy to miss in a scrolling
                // list, so the count of faulty services is promoted to the
                // header, where it doubles as a filter to reach them.
                if appState.attentionCount > 0 {
                    Button {
                        appState.showOnlyAttention.toggle()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "exclamationmark.circle.fill")
                                .font(.system(size: 10))
                            Text("\(appState.attentionCount)")
                                .font(.system(size: 11, weight: .medium))
                        }
                        .foregroundStyle(appState.showOnlyAttention ? Color.white : Color.red)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            Capsule().fill(
                                appState.showOnlyAttention
                                    ? Color.red
                                    : Color.red.opacity(0.15)
                            )
                        )
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .help(appState.showOnlyAttention
                        ? "Show all services"
                        : "Show only the \(appState.attentionCount) needing attention")
                }

                Spacer()

                if appState.isShuttingDown {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Button {
                        appState.refresh()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Refresh")

                    Button {
                        appState.requestShutdown()
                    } label: {
                        Image(systemName: "power")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(appState.runningCount > 0 ? .red : .secondary)
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Shutdown all services")
                    .disabled(appState.runningCount == 0)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 8)

            searchField
                .padding(.horizontal, 16)
                .padding(.bottom, 10)

            Divider()

            if appState.isLoading {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if appState.services.isEmpty {
                emptyState
            } else if appState.hasNoMatches {
                noMatchesState
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(appState.grouped, id: \.0) { category, services in
                            ServiceSectionLabel(text: category.displayName)

                            ForEach(services) { service in
                                ServiceRow(
                                    service: service,
                                    isPending: appState.pendingActions.contains(service.id),
                                    onToggle: { appState.toggleService(service) },
                                    onRestart: { appState.requestRestart(service) }
                                )
                            }
                        }
                    }
                    .padding(.bottom, 6)
                }
                .scrollIndicators(.automatic)
                // With more services than fit any reasonable popover height,
                // the list will always be cut off somewhere. A hard edge
                // slicing a row in half reads as a rendering bug, so fade the
                // last few points to signal "there is more below" instead.
                .mask(
                    LinearGradient(
                        stops: [
                            .init(color: .black, location: 0),
                            .init(color: .black, location: 0.97),
                            .init(color: .black.opacity(0), location: 1)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            }

            Divider()

            // Footer
            HStack(spacing: 8) {
                if let t = appState.lastRefresh {
                    Text("Updated \(t.formatted(date: .omitted, time: .standard))")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                Text("\(appState.runningCount)/\(appState.services.count) running")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .alert(
            "Stop BarryServices?",
            isPresented: Binding(
                get: { appState.confirmingAction != nil },
                set: { if !$0 { appState.confirmingAction = nil } }
            )
        ) {
            Button("Confirm", role: .destructive) {
                appState.confirmAction()
            }
            Button("Cancel", role: .cancel) {
                appState.confirmingAction = nil
            }
        } message: {
            Text("This will quit the BarryServices app.")
        }
        .alert(
            "Shutdown Barry?",
            isPresented: $appState.showShutdownConfirm
        ) {
            Button("Shutdown", role: .destructive) {
                appState.confirmShutdown()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will stop all \(appState.runningCount) running services.")
        }
        .task { appState.start() }
        .background(
            // ⌘F focuses the filter. A zero-size button is the standard way to
            // register a shortcut in a popover, which has no menu bar of its
            // own to hang a real command on.
            Button("") { searchFocused = true }
                .keyboardShortcut("f", modifiers: .command)
                .opacity(0)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        )
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)

            TextField("Filter services  (⌘F)", text: $appState.searchQuery)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
                .focused($searchFocused)
                // Escape clears the query first, and only gives up focus once
                // it is already empty — so one press undoes the filter rather
                // than dismissing the whole popover mid-search.
                .onExitCommand {
                    if appState.searchQuery.isEmpty {
                        searchFocused = false
                    } else {
                        appState.searchQuery = ""
                    }
                }

            if appState.isSearching {
                Button {
                    appState.searchQuery = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("Clear filter")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
    }

    private var noMatchesState: some View {
        let allHealthy = appState.showOnlyAttention && !appState.isSearching
        return VStack(spacing: 8) {
            Image(systemName: allHealthy ? "checkmark.circle" : "magnifyingglass")
                .font(.system(size: 24))
                .foregroundStyle(allHealthy ? Color.green.opacity(0.7) : Color.secondary)
            Text(allHealthy ? "All clear" : "No matches")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            Text(appState.noMatchesMessage)
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "server.rack")
                .font(.system(size: 32))
                .foregroundStyle(.tertiary)
            Text("No services found")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            Text("No com.barry.* plists in LaunchAgents")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
