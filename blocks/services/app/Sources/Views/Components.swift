import SwiftUI

// MARK: - SectionLabel

struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .textCase(.uppercase)
            .tracking(0.5)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 4)
    }
}

// MARK: - StatusDot

struct StatusDot: View {
    let health: ServiceHealth

    private var color: Color {
        switch health {
        case .running: return .green
        case .unhealthy: return .orange
        case .stopped: return .red
        case .scheduled: return .secondary
        }
    }

    var body: some View {
        if health == .scheduled {
            Image(systemName: "clock")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .frame(width: 14, alignment: .center)
        } else {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
                .frame(width: 14, alignment: .center)
        }
    }
}
