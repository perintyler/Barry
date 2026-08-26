import SwiftUI
import Components

/// Message search results, shown in place of the session list while a query is
/// active. The query field itself lives in `SessionListView`'s header, so this
/// view owns only the outcome of a search, never its input.
struct SearchResultsList: View {
    @Bindable var searchState: SearchState
    let onSelectResult: (String, Int) -> Void

    var body: some View {
        // Results only render for a query long enough to have been sent, so
        // "no results" here always means the search genuinely came back empty.
        if searchState.isSearching && searchState.results.isEmpty {
            centered { ProgressView().controlSize(.small) }
        } else if let error = searchState.errorMessage {
            centered {
                Text(error)
                    .font(AppFont.sans(size: 12))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
            }
        } else if searchState.results.isEmpty {
            centered {
                VStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(AppFont.sans(size: 24))
                        .foregroundStyle(.tertiary)
                    Text("No results")
                        .font(AppFont.sans(size: 13))
                        .foregroundStyle(.secondary)
                }
            }
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

    private func centered<Content: View>(
        @ViewBuilder _ content: () -> Content
    ) -> some View {
        content()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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
