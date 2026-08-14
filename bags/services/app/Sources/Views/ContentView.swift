import SwiftUI

struct ContentView: View {
    @Bindable var appState: AppState

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Barry Services")
                    .font(.system(size: 13, weight: .semibold))
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
            .padding(.bottom, 10)

            Divider()

            if appState.isLoading {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if appState.services.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(appState.grouped, id: \.0) { category, services in
                            SectionLabel(text: category.displayName)

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
