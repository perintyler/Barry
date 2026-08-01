import Foundation

struct ScopeRecord: Codable, Identifiable {
    let id: Int
    let name: String
    let description: String?
    let scope: AgentScope

    struct AgentScope: Codable {
        let deniedTools: [String]?
        let deniedAccess: [String]?
        let files: DenyList?
        let bash: DenyList?

        struct DenyList: Codable {
            let deny: [String]?
        }
    }

    /// All deny entries flattened for display as pills.
    var denyPills: [DenyPill] {
        var pills: [DenyPill] = []
        for tool in scope.deniedTools ?? [] {
            pills.append(DenyPill(label: "deny \(tool)", kind: .tool))
        }
        for access in scope.deniedAccess ?? [] {
            pills.append(DenyPill(label: "deny \(access) access", kind: .access))
        }
        for pattern in scope.files?.deny ?? [] {
            pills.append(DenyPill(label: pattern, kind: .filePattern))
        }
        for pattern in scope.bash?.deny ?? [] {
            pills.append(DenyPill(label: pattern, kind: .bashPattern))
        }
        return pills
    }
}

struct DenyPill: Identifiable {
    let label: String
    let kind: Kind
    var id: String { "\(kind)-\(label)" }

    enum Kind {
        case tool, access, filePattern, bashPattern
    }
}
