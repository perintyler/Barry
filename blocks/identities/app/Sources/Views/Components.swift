import SwiftUI

// MARK: - CheckRow

struct CheckRow<Trailing: View>: View {
    let name: String
    let description: String?
    @ViewBuilder let trailing: () -> Trailing
    var isChecked: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                checkMark
                VStack(alignment: .leading, spacing: 1) {
                    Text(name)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.primary)
                    if let desc = description {
                        Text(desc)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer()
                trailing()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var checkMark: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4)
                .strokeBorder(isChecked ? Color.clear : Color.secondary.opacity(0.3), lineWidth: 1.5)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(isChecked ? Color.green : Color.clear)
                )
                .frame(width: 16, height: 16)

            if isChecked {
                Image(systemName: "checkmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: isChecked)
    }
}

// MARK: - RadioRow

struct RadioRow<Content: View>: View {
    let isSelected: Bool
    let action: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                ZStack {
                    Circle()
                        .strokeBorder(isSelected ? Color.blue : Color.secondary.opacity(0.3), lineWidth: 1.5)
                        .frame(width: 16, height: 16)
                    if isSelected {
                        Circle()
                            .fill(Color.blue)
                            .frame(width: 8, height: 8)
                    }
                }
                .animation(.easeInOut(duration: 0.15), value: isSelected)
                .padding(.top, 1)

                content()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - AccessBadge

struct AccessBadge: View {
    let access: String

    var body: some View {
        Text(access == "readwrite" ? "rw" : access)
            .font(.system(size: 10, weight: .semibold))
            .textCase(.uppercase)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(backgroundColor)
            .foregroundStyle(foregroundColor)
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private var foregroundColor: Color {
        switch access {
        case "readwrite": return .purple
        case "read": return .blue
        default: return .secondary
        }
    }

    private var backgroundColor: Color {
        foregroundColor.opacity(0.12)
    }
}

// MARK: - DenyPillView

struct DenyPillView: View {
    let pill: DenyPill

    var body: some View {
        Text(pill.label)
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(backgroundColor)
            .foregroundStyle(foregroundColor)
            .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private var foregroundColor: Color {
        switch pill.kind {
        case .tool, .access: return .red.opacity(0.7)
        case .filePattern, .bashPattern: return .orange.opacity(0.75)
        }
    }

    private var backgroundColor: Color {
        switch pill.kind {
        case .tool, .access: return .red.opacity(0.08)
        case .filePattern, .bashPattern: return .orange.opacity(0.08)
        }
    }
}

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

// MARK: - PendingChangesBar

struct PendingChangesBar: View {
    let changeCount: Int
    let onReset: () -> Void
    let onApply: () -> Void

    var body: some View {
        HStack {
            Text("\(changeCount) change\(changeCount == 1 ? "" : "s")")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)

            Spacer()

            Button("Reset", action: onReset)
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(.quaternary)
                .clipShape(RoundedRectangle(cornerRadius: 6))

            Button("Apply", action: onApply)
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(Color.green)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color.green.opacity(0.06))
        .overlay(alignment: .top) {
            Divider().background(Color.green.opacity(0.15))
        }
    }
}

// MARK: - ConnectionBadge

struct ConnectionBadge: View {
    let isConnected: Bool

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(isConnected ? Color.green : Color.red)
                .frame(width: 6, height: 6)
            Text(isConnected ? "Connected" : "Disconnected")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - FilterBar

struct FilterBar: View {
    @Binding var text: String

    var body: some View {
        HStack {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
            TextField("Filter...", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 4)
    }
}
