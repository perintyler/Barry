import SwiftUI

struct ServiceRow: View {
    let service: BarryService
    let isPending: Bool
    let onToggle: () -> Void
    let onRestart: () -> Void

    private var parsed: ServiceName { parseServiceName(service.id) }

    // Names are derived from the launchd label rather than read from a bag
    // manifest on purpose. Manifests do carry a human-written `description`
    // per service and app, but it never reaches bag-resources.json, and that
    // registry covers only 11 of the 23 agents installed here — every job and
    // every first-party service (api, web, mcp.barry) is absent. Sourcing
    // labels from it would mean subtitles on under half the list, which reads
    // as broken rather than sparse. Deriving from the label covers all 23.

    /// The dim second line: owning bag and port, whichever exist. Kept on one
    /// line so every row is the same height and the status dots stay aligned.
    private var subtitle: String? {
        var parts: [String] = []
        if let owner = parsed.owner { parts.append(owner) }
        if let port = resolvePort(for: service) { parts.append("port \(port)") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(health: service.health)

            VStack(alignment: .leading, spacing: 2) {
                Text(parsed.name)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    // The full launchd label is no longer spelled out on the
                    // row, so keep it reachable on hover for launchctl use.
                    .help(service.id)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            if isPending {
                ProgressView()
                    .controlSize(.small)
            } else if service.health != .scheduled {
                HStack(spacing: 4) {
                    if service.isRunning {
                        Button {
                            onRestart()
                        } label: {
                            Image(systemName: "arrow.triangle.2.circlepath")
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .frame(width: 22, height: 22)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("Restart \(parsed.name)")
                    }

                    Toggle(isOn: Binding(
                        get: { service.isRunning },
                        set: { _ in onToggle() }
                    )) {
                        EmptyView()
                    }
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .labelsHidden()
                    .help(service.isRunning ? "Stop \(parsed.name)" : "Start \(parsed.name)")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}
