import SwiftUI

struct SearchView: View {
    @Bindable var searchState: SearchState
    let onSelectResult: (String, Int) -> Void
    let onDismiss: () -> Void

    @FocusState private var isSearchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack(spacing: 8) {
                Button(action: onDismiss) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(AppFont.sans(size: 11, weight: .medium))
                        Text("Sessions")
                            .font(AppFont.sans(size: 13))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.blue)

                Spacer()

                ConnectionBadge(isConnected: true)
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            // Search bar
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(AppFont.sans(size: 12))
                    .foregroundStyle(.tertiary)
                TextField("Search messages…", text: $searchState.query)
                    .textFieldStyle(.plain)
                    .font(AppFont.sans(size: 13))
                    .focused($isSearchFocused)
                    .onSubmit { searchState.search() }
                    .onChange(of: searchState.query) { searchState.search() }
                if !searchState.query.isEmpty {
                    Button { searchState.clear() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(AppFont.sans(size: 12))
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.quaternary)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .padding(.horizontal, 16)
            .padding(.bottom, 8)

            Divider()

            // Results
            if searchState.isSearching && searchState.results.isEmpty {
                Spacer()
                ProgressView()
                    .controlSize(.small)
                Spacer()
            } else if let error = searchState.errorMessage {
                Spacer()
                Text(error)
                    .font(AppFont.sans(size: 12))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
                Spacer()
            } else if searchState.results.isEmpty && searchState.query.trimmingCharacters(in: .whitespaces).count >= 2 {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(AppFont.sans(size: 24))
                        .foregroundStyle(.tertiary)
                    Text("No results")
                        .font(AppFont.sans(size: 13))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            } else if searchState.results.isEmpty {
                Spacer()
                VStack(spacing: 8) {
                    Image(systemName: "text.magnifyingglass")
                        .font(AppFont.sans(size: 24))
                        .foregroundStyle(.tertiary)
                    Text("Search across all sessions")
                        .font(AppFont.sans(size: 13))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(searchState.results) { result in
                            SearchResultRow(result: result)
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    onSelectResult(result.sessionId, result.sequence)
                                }
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
        }
        .onAppear { isSearchFocused = true }
    }
}

// MARK: - SearchResultRow

private struct SearchResultRow: View {
    let result: SearchResult

    private static let isoFormatterFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private func relativeTimestamp(_ iso: String) -> String {
        let date = Self.isoFormatterFractional.date(from: iso)
            ?? Self.isoFormatter.date(from: iso)
        guard let date else { return iso }
        let seconds = -date.timeIntervalSinceNow
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h ago" }
        if seconds < 604800 { return "\(Int(seconds / 86400))d ago" }
        let df = DateFormatter()
        df.dateFormat = "MMM d"
        return df.string(from: date)
    }

    private var roleColor: Color {
        result.role == "user" ? .blue : .orange
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Session name + role badge
            HStack(spacing: 6) {
                Text(result.displayName)
                    .font(AppFont.sans(size: 12, weight: .medium))
                    .lineLimit(1)

                Text(result.role)
                    .font(AppFont.sans(size: 9, weight: .semibold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(roleColor.opacity(0.12))
                    .foregroundStyle(roleColor)
                    .clipShape(RoundedRectangle(cornerRadius: 3))

                Spacer()
            }

            // Content snippet
            Text(result.contentSnippet)
                .font(AppFont.sans(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(3)

            // Path + timestamp
            HStack(spacing: 4) {
                if !result.displayPath.isEmpty {
                    Text(result.displayPath)
                    Text("·")
                }
                Text(relativeTimestamp(result.createdAt))
            }
            .font(AppFont.sans(size: 10))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}
