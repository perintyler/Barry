import Foundation

/// One pending decision the user has been asked to make.
public struct Approval: Identifiable, Codable, Sendable, Equatable {
    public let id: String
    public let requester: String
    public let subject: String
    public let state: String
    public let createdAt: String
    public let expiresAt: String
    public let sessionId: String?

    enum CodingKeys: String, CodingKey {
        case id, requester, subject, state
        case createdAt = "created_at"
        case expiresAt = "expires_at"
        case sessionId = "session_id"
    }
}

/// Talks to the approvals bag's service.
///
/// Deliberately separate from the events client: an approval is a decision the
/// agent is *blocked on*, and conflating it with the notification feed would
/// make a blocking request as easy to scroll past as an FYI.
public actor ApprovalsClient {
    private let baseURL: URL
    private let secret: String?

    public init(baseURL: URL, secret: String?) {
        self.baseURL = baseURL
        self.secret = secret
    }

    /// Build a request against `path`, which may carry a query string.
    ///
    /// Deliberately NOT `appendingPathComponent`: that percent-escapes "?" into
    /// "%3F", so "approvals?state=pending" became a literal path segment, no
    /// route matched, and the app saw zero pending approvals forever while
    /// looking perfectly healthy.
    private func request(_ path: String, method: String, body: Data? = nil) -> URLRequest {
        let url = URL(string: path, relativeTo: baseURL) ?? baseURL
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let secret, !secret.isEmpty {
            req.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    public func pending() async throws -> [Approval] {
        let (data, _) = try await URLSession.shared.data(for: request("approvals?state=pending", method: "GET"))
        return try JSONDecoder().decode([Approval].self, from: data)
    }

    /// Record the user's decision.
    ///
    /// A 409 means someone (or the expiry sweeper) already settled it. That is
    /// not an error worth surfacing — the verdict that stands is the one the
    /// agent already acted on — but it is not success either, so the caller
    /// refreshes rather than assuming its own choice won.
    @discardableResult
    public func decide(id: String, approved: Bool, decidedBy: String = "app") async throws -> Bool {
        let payload = ["state": approved ? "approved" : "denied", "decided_by": decidedBy]
        let body = try JSONSerialization.data(withJSONObject: payload)
        let (_, response) = try await URLSession.shared.data(
            for: request("approvals/\(id)/decide", method: "POST", body: body)
        )
        return (response as? HTTPURLResponse)?.statusCode == 200
    }
}
