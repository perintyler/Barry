import Foundation

/// A Barry trait (named tool grant) as served by `GET /traits`.
public struct TraitInfo: Codable, Identifiable {
    public let name: String
    public let description: String?
    public let access: String
    public let namespaces: [String]

    public var id: String { name }
    public var isReadWrite: Bool { access == "readwrite" }
}

public extension BarryCore {
    /// All configured traits (`GET /traits`).
    func fetchTraits() async throws -> [TraitInfo] {
        let response = try await transport.listTraits()
        return try JSONDecoder().decode(
            [TraitInfo].self,
            from: JSONEncoder().encode(response.traits)
        )
    }
}
