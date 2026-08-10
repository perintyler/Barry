import SwiftUI

struct IdentityListView: View {
    @Bindable var appState: AppState

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("My Identities")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        appState.showingCreateIdentity = true
                    }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.blue)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            Divider()

            if appState.identities.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(appState.identities) { identity in
                            IdentityRow(identity: identity)
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        appState.selectedIdentityId = identity.id
                                    }
                                }
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: appState.loadError == nil ? "person.crop.rectangle.stack" : "exclamationmark.triangle")
                .font(.system(size: 32))
                .foregroundStyle(.tertiary)
            if let error = appState.loadError {
                Text("Couldn't load identities")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                Text(error)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .lineLimit(6)
                    .textSelection(.enabled)
                    .padding(.horizontal, 20)
            } else {
                Text("No identities")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                Text("Create one with: barry heir to the <name> empire")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - IdentityRow

private struct IdentityRow: View {
    let identity: Identity

    private static let avatarColors: [(bg: Color, fg: Color)] = [
        (Color.green.opacity(0.15), .green),
        (Color.blue.opacity(0.12), .blue),
        (Color.purple.opacity(0.12), .purple),
        (Color.orange.opacity(0.12), .orange),
        (Color.pink.opacity(0.12), .pink),
        (Color.teal.opacity(0.12), .teal)
    ]

    private var avatarColor: (bg: Color, fg: Color) {
        if identity.isDefault {
            return (Color.green.opacity(0.15), .green)
        }
        let index = abs(identity.name.hashValue) % Self.avatarColors.count
        return Self.avatarColors[index]
    }

    var body: some View {
        HStack(spacing: 10) {
            // Avatar
            RoundedRectangle(cornerRadius: 8)
                .fill(avatarColor.bg)
                .frame(width: 32, height: 32)
                .overlay {
                    Text(String(identity.label.prefix(1)).uppercased())
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(avatarColor.fg)
                }

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(identity.label)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1)
                    if identity.isFileBased {
                        Image(systemName: "folder")
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                            .help("Configured by identity.yaml")
                    }
                    if identity.isDefault {
                        Text("ACTIVE")
                            .font(.system(size: 9, weight: .semibold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.green.opacity(0.12))
                            .foregroundStyle(.green)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                }
                Text(summaryLine)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text("\(identity.blocks.count)")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(.quaternary)
                .clipShape(Capsule())

            Image(systemName: "chevron.right")
                .font(.system(size: 11))
                .foregroundStyle(.quaternary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private var summaryLine: String {
        var parts: [String] = []
        // The row shows the display name, but commands and repo config address
        // the Identity by `name` — so surface it whenever the two differ.
        if identity.label != identity.name { parts.append(identity.name) }
        parts.append("\(identity.blocks.count) block\(identity.blocks.count == 1 ? "" : "s")")
        parts.append("\(identity.traits.count) trait\(identity.traits.count == 1 ? "" : "s")")
        parts.append(identity.displayLastUsed)
        return parts.joined(separator: " \u{00B7} ")
    }
}
