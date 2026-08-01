import SwiftUI

struct ProfileListView: View {
    @Bindable var appState: AppState

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Barry Profiles")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        appState.showingCreateProfile = true
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

            if appState.profiles.isEmpty {
                emptyState
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(appState.profiles) { profile in
                            ProfileRow(profile: profile)
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        appState.selectedProfileId = profile.id
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
            Image(systemName: "person.crop.rectangle.stack")
                .font(.system(size: 32))
                .foregroundStyle(.tertiary)
            Text("No profiles")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            Text("Tap + to create one")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - ProfileRow

private struct ProfileRow: View {
    let profile: Profile

    private static let avatarColors: [(bg: Color, fg: Color)] = [
        (Color.green.opacity(0.15), .green),
        (Color.blue.opacity(0.12), .blue),
        (Color.purple.opacity(0.12), .purple),
        (Color.orange.opacity(0.12), .orange),
        (Color.pink.opacity(0.12), .pink),
        (Color.teal.opacity(0.12), .teal)
    ]

    private var avatarColor: (bg: Color, fg: Color) {
        if profile.isDefault {
            return (Color.green.opacity(0.15), .green)
        }
        let index = abs(profile.name.hashValue) % Self.avatarColors.count
        return Self.avatarColors[index]
    }

    var body: some View {
        HStack(spacing: 10) {
            // Avatar
            RoundedRectangle(cornerRadius: 8)
                .fill(avatarColor.bg)
                .frame(width: 32, height: 32)
                .overlay {
                    Text(String(profile.name.prefix(1)).uppercased())
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(avatarColor.fg)
                }

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(profile.name)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1)
                    if profile.isDefault {
                        Text("DEFAULT")
                            .font(.system(size: 9, weight: .semibold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.green.opacity(0.12))
                            .foregroundStyle(.green)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                    if let parentName = profile.parentName {
                        Text("← \(parentName)")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.blue.opacity(0.7))
                    }
                }
                Text(summaryLine)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text("\(profile.packs.count)")
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
        let parts = [
            "\(profile.packs.count) pack\(profile.packs.count == 1 ? "" : "s")",
            "\(profile.traits.count) trait\(profile.traits.count == 1 ? "" : "s")",
            profile.displayLastUsed
        ]
        return parts.joined(separator: " \u{00B7} ")
    }
}
