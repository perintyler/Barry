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

    /// Debounced search — cancels previous request if the user is still typing.
    func search() {
        searchTask?.cancel()

        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
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
