import Foundation

// MARK: - Service Discovery

let launchAgentsDir: URL = {
    FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/LaunchAgents")
}()

let userDomain: String = "gui/\(getuid())"

/// Parse one `com.barry.*.plist` into a `BarryService`. Pure — no caching,
/// no filesystem listing, just "given this URL's bytes, what service is
/// this" — so it can be tested directly against a fixture plist without
/// touching `~/Library/LaunchAgents`.
///
/// `health`/`pid` are always seeded `.stopped`/`nil`: this function only
/// knows what launchd's static config says, not whether the process is
/// actually alive right now — `fetchServiceState()` fills those in from a
/// concurrent liveness/health-check pass over every discovered service.
func parsePlist(at url: URL) -> BarryService? {
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
    // A run-once script — RunAtLoad with nothing to restart it and no
    // timer — exits when its work is done, and that exit is success.
    // `bag.coffee.reconcile` is exactly this shape and rests at
    // "not running" with last exit code 0.
    //
    // Apps are also KeepAlive=false, but a quit app IS worth flagging,
    // so they stay in bound: their liveness is decided by process
    // lookup in `isServiceAlive`, not by launchd's view.
    let isAppBundle = executablePath?.contains(".app/Contents/MacOS/") == true
    let expectedToStayUp = keepAlive || isScheduled || isAppBundle

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
        pid: nil,
        expectedToStayUp: expectedToStayUp
    )
}

/// Caches `parsePlist` results by (path, mtime) so an unchanged plist is
/// never re-parsed — F13: `discoverServices()` used to run a full directory
/// listing + `PropertyListSerialization` parse of every `com.barry.*.plist`
/// on EVERY poll (every 5s, forever, before F13's visibility gating), even
/// though a service's plist changes approximately never after install.
///
/// Keyed by path rather than by label: a stale entry for a plist that was
/// deleted (service uninstalled) is simply never looked up again once
/// `discoverServices()` stops listing that path — no separate eviction pass
/// needed, since the cache can only grow by the number of distinct plist
/// paths ever seen on this machine, which is bounded by how many services
/// exist, not by poll count.
final class PlistCache: @unchecked Sendable {
    private struct Entry {
        let mtime: Date
        let service: BarryService?
    }
    private var entries: [String: Entry] = [:]
    private let lock = NSLock()

    /// Parse (or return the cached parse of) the plist at `url`, using
    /// `mtime` as the cache-validity key. A caller that already listed the
    /// directory (and so already paid for a `stat` via
    /// `contentsOfDirectory(...includingPropertiesForKeys: [.contentModificationDateKey])`)
    /// passes that mtime in rather than this function re-`stat`-ing the file
    /// itself — keeping "list + stat" and "parse" as separate, individually
    /// cacheable steps.
    func service(at url: URL, mtime: Date) -> BarryService? {
        lock.lock()
        defer { lock.unlock() }
        if let cached = entries[url.path], cached.mtime == mtime {
            return cached.service
        }
        let parsed = parsePlist(at: url)
        entries[url.path] = Entry(mtime: mtime, service: parsed)
        return parsed
    }
}

let plistCache = PlistCache()

func discoverServices() -> [BarryService] {
    let fm = FileManager.default
    guard let files = try? fm.contentsOfDirectory(
        at: launchAgentsDir,
        includingPropertiesForKeys: [.contentModificationDateKey]
    ) else {
        return []
    }

    return files
        .filter { $0.lastPathComponent.hasPrefix("com.barry.") && $0.pathExtension == "plist" }
        .compactMap { url -> BarryService? in
            let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            return plistCache.service(at: url, mtime: mtime)
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
    if ["bdiff-review", "slack-app", "github-app"].contains(name) { return .servers }
    if name.hasPrefix("mcp.") { return .mcp }
    if ["caddy", "cloudflared"].contains(name) { return .infrastructure }
    if ["sessions", "profiles", "bdiff", "updates", "services"].contains(name) { return .apps }
    if name.hasPrefix("job.") { return .maintenance }
    // Bag-contributed agents are `bag.<bag>.<item>` for services and
    // `bag.job.<bag>.<job>` for jobs. Check the job form first: both share the
    // `bag.` prefix, so testing services first would swallow every bag job and
    // file recurring work under SERVERS.
    if name.hasPrefix("bag.job.") { return .maintenance }
    if name.hasPrefix("bag.") { return .servers }
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

/// Default deadline for `shell()`. F13: `launchctl`/`pgrep` calls here had NO
/// timeout at all — `waitUntilExit()` blocks the calling thread indefinitely,
/// so a hung `launchctl` (observed in the wild as a real macOS failure mode,
/// not just theoretical) would hang the entire poll cycle that called it,
/// since `fetchServiceState()` awaits these synchronously per service inside
/// its `withTaskGroup` fan-out.
let shellDeadline: TimeInterval = 5

/// Run `executable` with `arguments`, killing it if it hasn't exited within
/// `deadline` seconds. A killed process returns exit code -1 (same sentinel
/// `shell()` already used for "failed to launch at all" — callers already
/// treat any non-zero/non-expected exit as failure, so a new distinct code
/// is not needed for this to be observably different from success).
func shell(_ executable: String, _ arguments: [String], deadline: TimeInterval = shellDeadline) -> (Int32, String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice

    do {
        try process.run()
    } catch {
        return (-1, "")
    }

    // Fires on a background queue and races `waitUntilExit()` below: if the
    // process is still running once `deadline` elapses, terminate it so
    // `waitUntilExit()` (which would otherwise block forever) returns.
    // Cancelled once the process exits on its own, so a fast, normal call
    // never pays for a timer that fires.
    let deadlineTimer = DispatchSource.makeTimerSource(queue: .global())
    deadlineTimer.schedule(deadline: .now() + deadline)
    deadlineTimer.setEventHandler { [weak process] in
        guard let process, process.isRunning else { return }
        process.terminate()
    }
    deadlineTimer.resume()
    defer { deadlineTimer.cancel() }

    process.waitUntilExit()
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}
