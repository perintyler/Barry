import Foundation

struct BoundRecord: Codable, Identifiable {
    let id: Int
    let name: String
    let description: String?
    let bound: AgentBound

    struct AgentBound: Codable {
        let deniedTools: [String]?
        let deniedAccess: [String]?
        let files: DenyList?
        let bash: DenyList?
        /// Outbound network restrictions.
        ///
        /// The edit sheet re-encodes this struct and PATCHes the result, so a
        /// key that decodes to nothing is *erased* on the next save rather than
        /// merely hidden. Real bounds use this — `no-network` and
        /// `no-network-write` consist of nothing else — so it has to be
        /// modelled whether or not the form exposes it.
        let network: NetworkRules?

        struct DenyList: Codable {
            let deny: [String]?
        }

        /// The action tags a bound can deny, parent-first.
        ///
        /// A hierarchy, not free text: `all` expands to `write` and `read`,
        /// and those to the leaves (`git:push`, `http:read`, `dns`, ...). Only
        /// the parents are offered — denying a leaf is possible but rarely what
        /// someone means, and a mistyped tag silently denies nothing at all.
        static let networkActionChoices = ["all", "write", "read"]

        struct NetworkRules: Codable {
            let actions: [String]?
        }
    }

    /// All deny entries flattened for display as pills.
    var denyPills: [DenyPill] {
        var pills: [DenyPill] = []
        for tool in bound.deniedTools ?? [] {
            pills.append(DenyPill(label: "deny \(tool)", kind: .tool))
        }
        for access in bound.deniedAccess ?? [] {
            pills.append(DenyPill(label: "deny \(access) access", kind: .access))
        }
        for pattern in bound.files?.deny ?? [] {
            pills.append(DenyPill(label: pattern, kind: .filePattern))
        }
        for pattern in bound.bash?.deny ?? [] {
            pills.append(DenyPill(label: pattern, kind: .bashPattern))
        }
        for action in bound.network?.actions ?? [] {
            pills.append(DenyPill(label: "deny network \(action)", kind: .network))
        }
        return pills
    }
}

struct DenyPill: Identifiable {
    let label: String
    let kind: Kind
    var id: String { "\(kind)-\(label)" }

    enum Kind {
        case tool, access, filePattern, bashPattern, network
    }
}
