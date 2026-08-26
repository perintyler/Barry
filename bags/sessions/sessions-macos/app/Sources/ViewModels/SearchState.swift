import SwiftUI

/// Manages search query, results, and debouncing for the global message search.
@Observable
final class SearchState: @unchecked Sendable {
    var query: String = ""
    var results: [SearchResult] = []
    var isSearching = false
    var errorMessage: String?

    private let client = BarryClient()
    private var searchTask: Task<Void, Never>?

    /// Shortest query worth a round trip. A single character matches most of
    /// the corpus, so it costs a request to say nothing useful.
    static let minimumQueryLength = 2

    /// Whether the session list should give way to search results.
    ///
    /// Deliberately keyed to the same threshold `search()` enforces, so the
    /// screen never shows an empty result list for a query that was never sent.
    var isActive: Bool {
        query.trimmingCharacters(in: .whitespacesAndNewlines).count >= Self.minimumQueryLength
    }

    /// Debounced search — cancels previous request if the user is still typing.
    func search() {
        searchTask?.cancel()

        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= Self.minimumQueryLength else {
            results = []
            errorMessage = nil
            isSearching = false
            return
        }

        isSearching = true
        errorMessage = nil

        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let self else { return }

            do {
                let found = try await client.searchMessages(query: trimmed)
                guard !Task.isCancelled else { return }
                self.results = found
            } catch {
                guard !Task.isCancelled else { return }
                self.errorMessage = error.localizedDescription
            }
            self.isSearching = false
        }
    }

    func clear() {
        searchTask?.cancel()
        query = ""
        results = []
        isSearching = false
        errorMessage = nil
    }
}
