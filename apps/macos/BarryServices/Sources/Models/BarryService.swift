import Foundation

// MARK: - Service Category

enum ServiceCategory: String, CaseIterable {
    case core
    case servers
    case mcp
    case infrastructure
    case apps
    case maintenance

    var displayName: String {
        rawValue.uppercased()
    }

    var sortOrder: Int {
        switch self {
        case .core: return 0
        case .servers: return 1
        case .mcp: return 2
        case .infrastructure: return 3
        case .apps: return 4
        case .maintenance: return 5
        }
    }
}

// MARK: - Service Health

enum ServiceHealth {
    case running     // green — process is alive AND (no health endpoint OR health passes)
    case unhealthy   // orange — process is alive BUT health check fails
    case stopped     // red — not loaded or not running
    case scheduled   // dim — loaded but idle (StartInterval/StartCalendarInterval)
}

// MARK: - Service Model

struct BarryService: Identifiable {
    let id: String          // launchd label, e.g. "com.barry.api"
    let shortName: String   // e.g. "api"
    let category: ServiceCategory
    let plistPath: String
    let port: Int?
    var health: ServiceHealth
    let isScheduled: Bool
    let keepAlive: Bool     // from plist — false for apps (fire-and-forget)
    let executablePath: String?  // ProgramArguments[0] — for process-level checks
    var pid: Int?

    var isSelf: Bool { id == "com.barry.services" }
    var isRunning: Bool { health == .running || health == .unhealthy }

    /// Whether this is a .app bundle (executable path ends in .app/Contents/MacOS/*)
    var isApp: Bool { executablePath?.contains(".app/Contents/MacOS/") == true }

    /// The .app bundle path (e.g. /Users/tyler/.barry/apps/BarrySessions.app)
    var appBundlePath: String? {
        guard let exe = executablePath,
              let range = exe.range(of: ".app/Contents/MacOS/") else { return nil }
        return String(exe[exe.startIndex..<range.upperBound])
            .replacingOccurrences(of: "/Contents/MacOS/", with: "")
    }
}
