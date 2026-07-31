import SwiftUI

// MARK: - CheckRow

enum CheckState {
    case checked, partial, unchecked
}

struct CheckRow<Trailing: View>: View {
    let name: String
    let description: String?
    var isMonospace: Bool = false
    @ViewBuilder let trailing: () -> Trailing
    var isChecked: Bool = false
    var state: CheckState? = nil
    var isInert: Bool = false
    let action: () -> Void

    private var resolvedState: CheckState {
        state ?? (isChecked ? .checked : .unchecked)
    }

    var body: some View {
        Button(action: isInert ? {} : action) {
            HStack(spacing: 10) {
                checkMark
                VStack(alignment: .leading, spacing: 1) {
                    Text(name)
                        .font(isMonospace
                            ? AppFont.mono(size: 12)
                            : AppFont.sans(size: 13, weight: .medium))
                        .foregroundStyle(.primary)
                    if let desc = description {
                        Text(desc)
                            .font(AppFont.sans(size: 11))
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
        .opacity(isInert ? 0.7 : 1.0)
    }

    @ViewBuilder
    private var checkMark: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4)
                .strokeBorder(resolvedState == .unchecked ? Color.secondary.opacity(0.3) : Color.clear, lineWidth: 1.5)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(resolvedState == .unchecked ? Color.clear : Color.green)
                )
                .frame(width: 16, height: 16)

            switch resolvedState {
            case .checked:
                Image(systemName: "checkmark")
                    .font(AppFont.sans(size: 9, weight: .bold))
                    .foregroundStyle(.white)
            case .partial:
                RoundedRectangle(cornerRadius: 1)
                    .fill(.white)
                    .frame(width: 8, height: 2)
            case .unchecked:
                EmptyView()
            }
        }
    }
}

// MARK: - AccessBadge

struct AccessBadge: View {
    let access: String

    var body: some View {
        Text(access == "readwrite" ? "rw" : access)
            .font(AppFont.sans(size: 10, weight: .semibold))
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
        case "write": return .orange
        default: return .secondary
        }
    }

    private var backgroundColor: Color {
        foregroundColor.opacity(0.12)
    }
}

// MARK: - SectionLabel

struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(AppFont.sans(size: 10, weight: .semibold))
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
                .font(AppFont.sans(size: 12))
                .foregroundStyle(.secondary)

            Spacer()

            Button("Reset", action: onReset)
                .buttonStyle(.plain)
                .font(AppFont.sans(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .background(.quaternary)
                .clipShape(RoundedRectangle(cornerRadius: 6))

            Button("Apply", action: onApply)
                .buttonStyle(.plain)
                .font(AppFont.sans(size: 12, weight: .medium))
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
