import Foundation

/// A Barry trait (named tool grant) as served by `GET /traits`.
public struct TraitInfo: Codable, Identifiable {
    public let name: String
    public let description: String?
    public let access: String
    public let namespaces: [String]
    /// The bag this trait was derived from, or nil when hand-authored.
    ///
    /// Most traits are auto-generated one-per-bag, so without this the Traits
    /// tab is a flat list of names with no way to tell which bag put them
    /// there — even though Bags sits on the adjacent tab of the same pane.
    /// Optional because a hand-authored trait deliberately has no owning bag;
    /// that is what keeps it safe from `ensureTraits` reconciliation.
    public let bag: String?

    public var id: String { name }
    public var isReadWrite: Bool { access == "readwrite" }
    /// Hand-authored traits and cross-bag composites (`all`, `read`, `coding`).
    public var isHandAuthored: Bool { bag == nil }
}

public extension BarryCore {
    /// Traits a reachable bag still backs (`GET /traits`).
    ///
    /// Pass `identityId` to narrow to the bags that barry holds; omit it to get
    /// the registry-wide list, which is what a form wants before a barry is
    /// chosen.
    func fetchTraits(identityId: Int? = nil) async throws -> [TraitInfo] {
        let response = try await transport.listTraits(identityId: identityId)
        return try JSONDecoder().decode(
            [TraitInfo].self,
            from: JSONEncoder().encode(response.traits)
        )
    }
}
