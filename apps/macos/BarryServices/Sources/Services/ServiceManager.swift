import Foundation

// MARK: - Service Discovery

let launchAgentsDir: URL = {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents")
}()

let userDomain: String = "gui/\(getuid())"

func discoverServices() -> [BarryService] {
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(at: launchAgentsDir, includingPropertiesForKeys: nil) else {
        return []
    }

    return files
        .filter { $0.lastPathComponent.hasPrefix("com.barry.") && $0.pathExtension == "plist" }
        .compactMap { url -> BarryService? in
            let label = url.deletingPathExtension().lastPathComponent
            guard let data = try? Data(contentsOf: url),
                  let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
            else { return nil }

            let envVars = plist["EnvironmentVariables"] as? [String: String]
            let port = envVars?["PORT"].flatMap(Int.init)
            let isScheduled = plist["StartInterval"] != nil || plist["StartCalendarInterval"] != nil
            // KeepAlive can be a Bool (true) or a Dict of conditions
            // (e.g. {"SuccessfulExit": false}). Either form means launchd manages liveness.
            let keepAlive: Bool = {
                if let b = plist["KeepAlive"] as? Bool { return b }
                if plist["KeepAlive"] is [String: Any] { return true }
                return false
            }()
            let programArgs = plist["ProgramArguments"] as? [String]
            let executablePath = programArgs?.first

            return BarryService(
                id: label,
                shortName: label.replacingOccurrences(of: "com.barry.", with: ""),
                category: classifyService(label),
                plistPath: url.path,
                port: port,
                health: .stopped,
                isScheduled: isScheduled,
                keepAlive: keepAlive,
                executablePath: executablePath,
                pid: nil
            )
        }
        .sorted { $0.category.sortOrder != $1.category.sortOrder
            ? $0.category.sortOrder < $1.category.sortOrder
            : $0.shortName < $1.shortName
        }
}

/// Known MCP server prod ports (base + 1000 offset).
/// MCP plists don't include a PORT env var — it's hardcoded in the server.
private let mcpProdPorts: [String: Int] = [
    "com.barry.mcp.barry": 4901
]

/// Resolve the health-check port for a service.
func resolvePort(for service: BarryService) -> Int? {
    if let port = service.port { return port }
    return mcpProdPorts[service.id]
}

private func classifyService(_ label: String) -> ServiceCategory {
    let name = label.replacingOccurrences(of: "com.barry.", with: "")

    if ["web", "api"].contains(name) { return .core }
    if ["whisperflow", "bdiff-review", "slack-app", "github-app"].contains(name) { return .servers }
    if name.hasPrefix("mcp.") { return .mcp }
    if ["caddy", "cloudflared"].contains(name) { return .infrastructure }
    if ["sessions", "profiles", "bdiff", "updates", "services"].contains(name) { return .apps }
    if name.hasPrefix("job.") { return .maintenance }
    if ["log-maintenance", "artifact-cleanup"].contains(name) { return .maintenance }

    return .servers
}

// MARK: - launchctl

struct LaunchctlStatus {
    let isLoaded: Bool
    let isRunning: Bool
    let pid: Int?
}

func checkServiceStatus(_ label: String) -> LaunchctlStatus {
    let (exit, output) = shell("/bin/launchctl", ["print", "\(userDomain)/\(label)"])
    guard exit == 0 else {
        return LaunchctlStatus(isLoaded: false, isRunning: false, pid: nil)
    }

    let running = output.contains("state = running")
    var pid: Int?
    if let range = output.range(of: "pid = ") {
        let rest = output[range.upperBound...]
        if let end = rest.firstIndex(where: { !$0.isNumber }), rest.startIndex < end {
            pid = Int(rest[rest.startIndex..<end])
        }
    }

    return LaunchctlStatus(isLoaded: true, isRunning: running, pid: pid)
}

/// Check if a process is running by its executable path.
/// Used for KeepAlive=false services (apps) where launchd reports "not running"
/// even though the process is alive.
func isProcessRunning(executablePath: String) -> Bool {
    let (exit, _) = shell("/usr/bin/pgrep", ["-f", executablePath])
    return exit == 0
}

/// Determine if a service's process is alive — combines launchctl state with
/// process-level checks for fire-and-forget services (KeepAlive=false).
func isServiceAlive(_ service: BarryService) -> (alive: Bool, pid: Int?) {
    let status = checkServiceStatus(service.id)

    // For KeepAlive services, launchctl is the authority
    if service.keepAlive {
        return (status.isRunning, status.pid)
    }

    // For fire-and-forget (apps), launchctl "state = running" still means running,
    // but "state = not running" doesn't mean stopped — check the actual process.
    if status.isRunning {
        return (true, status.pid)
    }

    if let exe = service.executablePath, isProcessRunning(executablePath: exe) {
        return (true, nil)
    }

    return (false, nil)
}

// MARK: - Start / Stop / Restart

@discardableResult
func stopService(_ service: BarryService) -> Bool {
    if service.isApp {
        // For .app bundles, use AppleScript to quit gracefully
        if let exe = service.executablePath {
            _ = shell("/usr/bin/pkill", ["-f", exe])
        }
        // Also bootout so launchd forgets
        _ = shell("/bin/launchctl", ["bootout", "\(userDomain)/\(service.id)"])
        return true
    }

    let (exit, _) = shell("/bin/launchctl", ["bootout", "\(userDomain)/\(service.id)"])
    return exit == 0
}

@discardableResult
func startService(_ service: BarryService) -> Bool {
    if service.isApp, let bundlePath = service.appBundlePath {
        // For .app bundles, use `open` which handles macOS app lifecycle properly
        let (exit, _) = shell("/usr/bin/open", [bundlePath])
        return exit == 0
    }

    _ = shell("/bin/launchctl", ["enable", "\(userDomain)/\(service.id)"])
    let (exit, _) = shell("/bin/launchctl", ["bootstrap", userDomain, service.plistPath])
    if exit == 0 { return true }

    let (kickExit, _) = shell("/bin/launchctl", ["kickstart", "\(userDomain)/\(service.id)"])
    return kickExit == 0
}

@discardableResult
func restartService(_ service: BarryService) -> Bool {
    if service.isApp {
        stopService(service)
        // Brief pause for process to exit
        Thread.sleep(forTimeInterval: 0.5)
        return startService(service)
    }

    _ = shell("/bin/launchctl", ["enable", "\(userDomain)/\(service.id)"])
    let (exit, _) = shell("/bin/launchctl", ["kickstart", "-k", "\(userDomain)/\(service.id)"])
    if exit == 0 { return true }

    stopService(service)
    return startService(service)
}

// MARK: - Shutdown All

/// Stop all running services. Stops non-self services first, then self last if included.
func stopAllServices(_ services: [BarryService], includeSelf: Bool) {
    let running = services.filter { $0.isRunning }

    // Stop everything except self first
    for svc in running where !svc.isSelf {
        stopService(svc)
    }

    // Stop self last (this will kill the app)
    if includeSelf, let selfSvc = running.first(where: { $0.isSelf }) {
        stopService(selfSvc)
    }
}

// MARK: - Health

private let healthSession: URLSession = {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 3
    return URLSession(configuration: config)
}()

func checkHealth(port: Int) async -> Bool {
    guard let url = URL(string: "http://localhost:\(port)/health") else { return false }
    do {
        let (_, response) = try await healthSession.data(for: URLRequest(url: url))
        guard let http = response as? HTTPURLResponse else { return false }
        return (200..<300).contains(http.statusCode)
    } catch {
        return false
    }
}

// MARK: - Shell Helper

func shell(_ executable: String, _ arguments: [String]) -> (Int32, String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        return (-1, "")
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}
