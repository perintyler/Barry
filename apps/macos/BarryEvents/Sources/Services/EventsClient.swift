import Foundation

/// Thin client over `/api/v1/events`.
///
/// Note there is deliberately no `ok` envelope check anywhere here: the API's
/// contract middleware strips that field before sending, so gating on it makes
/// every response look like a failure.
struct EventsClient {
    let baseURL: URL
    let secret: String?

    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    struct Page {
        let events: [BarryEvent]
        let nextCursor: String?
    }

    func fetchEvents(limit: Int = 40, cursor: String? = nil) async throws -> Page {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("api/v1/events"),
            resolvingAgainstBaseURL: false
        )!
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        components.queryItems = query

        let response: EventListResponse = try await get(components.url!)
        return Page(events: response.events, nextCursor: response.nextCursor)
    }

    /// Ask the API to begin OAuth for a pack. Best-effort: the browser tab is
    /// the real feedback, and the endpoint is idempotent while an attempt is
    /// already pending.
    func startPackAuth(_ pack: String) async {
        let url = baseURL.appendingPathComponent("api/v1/profiles/packs/\(pack)/auth")
        try? await post(url)
    }

    func markRead(_ eventId: String) async throws {
        try await post(baseURL.appendingPathComponent("api/v1/events/\(eventId)/read"))
    }

    func markAllRead() async throws {
        try await post(baseURL.appendingPathComponent("api/v1/events/read-all"))
    }

    // MARK: - Transport

    private func request(_ url: URL, method: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let secret { request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        let (data, response) = try await session.data(for: request(url, method: "GET"))
        try validate(response)
        return try JSONDecoder.barry.decode(T.self, from: data)
    }

    private func post(_ url: URL) async throws {
        var req = request(url, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await session.data(for: req)
        try validate(response)
    }

    private func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        // Barry answers unauthorized requests with 403, not 401.
        guard (200..<300).contains(http.statusCode) else {
            throw EventsError.http(status: http.statusCode)
        }
    }
}

enum EventsError: LocalizedError {
    case http(status: Int)

    var errorDescription: String? {
        switch self {
        case .http(403): return "Not authorized — check BARRY_SECRET"
        case .http(let status): return "Server returned \(status)"
        }
    }
}
