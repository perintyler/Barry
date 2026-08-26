import AppKit
import BarrySessionsCore
import Components
import SwiftUI

/// The identities manager: a sidebar of identities and a detail pane.
///
/// This is a real resizable window rather than a menu bar popover. The old
/// app crammed creation, scope editing, bag and trait selection and env into
/// a 420pt transient popover that closed on any outside click — the wrong
/// container for configuration work, and most of what made it feel broken.
public struct IdentitiesWindowView: View {
    @ObservedObject var state: IdentitiesState

    public init(state: IdentitiesState) {
        self.state = state
    }

    public var body: some View {
        HSplitView {
            sidebar
                .frame(minWidth: 200, idealWidth: 240, maxWidth: 320)
            detail
                .frame(minWidth: 420, maxWidth: .infinity)
        }
        .frame(minWidth: 720, minHeight: 460)
        .background(Palette.windowBackground)
        .task { state.start() }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                TextField("Search", text: $state.searchText)
                    .textFieldStyle(.plain)
                    .font(AppFont.sans(size: 12))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)

            Divider()

            if let error = state.loadError {
                // The old app defined a ConnectionBadge and never placed it, so
                // an unreachable API rendered as an empty list — indisting-
                // uishable from having no identities.
                VStack(alignment: .leading, spacing: 6) {
                    Label("Can't reach Barry", systemImage: "exclamationmark.triangle")
                        .font(AppFont.sans(size: 11, weight: .medium))
                        .foregroundStyle(Palette.amber)
                    Text(error)
                        .font(AppFont.mono(size: 10))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                .padding(10)
            }

            ScrollView {
                LazyVStack(spacing: 1) {
                    ForEach(state.visibleIdentities) { identity in
                        IdentityRow(
                            identity: identity,
                            isSelected: identity.id == state.selectedId
                        )
                        .contentShape(Rectangle())
                        .onTapGesture { state.selectedId = identity.id }
                    }
                }
                .padding(.vertical, 4)
            }

            Divider()

            HStack {
                Text("\(state.identities.count) identities")
                    .font(AppFont.sans(size: 10))
                    .foregroundStyle(.tertiary)
                Spacer()
                ConnectionDot(isConnected: state.isConnected)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
    }

    // MARK: - Detail

    @ViewBuilder
    private var detail: some View {
        if let identity = state.selected {
            IdentityDetailPane(identity: identity, state: state)
                // Rebuild the editor when the selection changes; it holds the
                // per-identity draft state.
                .id(identity.id)
        } else {
            VStack(spacing: 6) {
                Text("No identity selected")
                    .font(AppFont.sans(size: 13))
                    .foregroundStyle(.secondary)
                Text("Create one with:  barry heir to the <name> empire")
                    .font(AppFont.mono(size: 11))
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct IdentityRow: View {
    let identity: Identity
    let isSelected: Bool

    private static let avatarColors: [Color] = [
        Palette.blue, Palette.green, Palette.purple, Palette.amber, Palette.red
    ]

    /// Stable across launches. This used to key off `String.hashValue`, which
    /// is seeded per process, so an identity's color changed on every start.
    private var avatarColor: Color {
        if identity.isDefault { return Palette.green }
        return Self.avatarColors[StableHash.index(identity.name, slots: Self.avatarColors.count)]
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(String(identity.label.prefix(1)).uppercased())
                .font(AppFont.sans(size: 11, weight: .semibold))
                .foregroundStyle(avatarColor)
                .frame(width: 20, height: 20)
                .background(avatarColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 5))

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(identity.label)
                        .font(AppFont.sans(size: 12, weight: isSelected ? .semibold : .regular))
                        .lineLimit(1)
                    if identity.isFileBased {
                        Image(systemName: "folder")
                            .font(.system(size: 8))
                            .foregroundStyle(.tertiary)
                    }
                }
                Text("\(identity.bags.count) bags · \(identity.traits.count) traits")
                    .font(AppFont.sans(size: 10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            if identity.isDefault {
                TagBadge(text: "ACTIVE", color: Palette.green)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            isSelected ? Palette.hover : Color.clear,
            in: RoundedRectangle(cornerRadius: 6)
        )
        .padding(.horizontal, 4)
    }
}

/// Connection indicator. The old app had one of these and never used it.
private struct ConnectionDot: View {
    let isConnected: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(isConnected ? Palette.green : Palette.red)
                .frame(width: 6, height: 6)
            Text(isConnected ? "Connected" : "Disconnected")
                .font(AppFont.sans(size: 10))
                .foregroundStyle(.tertiary)
        }
    }
}
