import SwiftUI

struct ServiceRow: View {
    let service: BarryService
    let isPending: Bool
    let onToggle: () -> Void
    let onRestart: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(health: service.health)

            VStack(alignment: .leading, spacing: 2) {
                Text(service.shortName)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                if let port = resolvePort(for: service) {
                    Text("port \(port)")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

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
                        .help("Restart")
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
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}
