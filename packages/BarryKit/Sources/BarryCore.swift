import Foundation

/// Shared HTTP core for Barry's macOS apps.
///
/// Reads the API port and secret from the `com.barry.api` launchd plist
/// (with a `launchctl print` fallback) and provides the generic request
/// primitives. Apps keep their own `IdentityClient` actor with app-specific
/// endpoint methods that delegate to a `BarryCore` instance.
public struct BarryCore: Sendable {
    public let baseURL: URL
    private let session: URLSession
    /// The API secret, exposed because the WebSocket upgrade at `/api/v1/ws`
    /// requires it even from localhost (unlike the HTTP routes, which are
    /// exempt) — a bus client has to set the header itself.
    public let authToken: String?
    public let transport: IdentityTransport

    public init() {
        let (port, secret) = Self.readLaunchdConfig()
        self.baseURL = URL(string: "http://localhost:\(port)")!
        self.authToken = secret
        self.transport = IdentityTransport(baseURL: self.baseURL, token: secret)

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        self.session = URLSession(configuration: config)
    }

    /// Port to assume when nothing on the machine says otherwise.
    ///
    /// `PORTS.api` in @barry-rocks/env is 3854 and prod adds an offset of 1000,
    /// so a shipped app talks to 4854. The old default here was the *dev* port,
    /// which only ever worked because the plist read below succeeds — the
    /// moment it didn't, the app would quietly connect to a dev server or to
    /// nothing at all.
    private static let defaultProdPort = 4854

    /// Environment overrides, then the prod launchd plist, then the dev one.
    ///
    /// The dev fallback and the environment overrides come from the events
    /// app's own config reader, which was the more complete of the two
    /// implementations this type absorbed when the apps merged.
    private static func readLaunchdConfig() -> (port: Int, secret: String?) {
        let environment = ProcessInfo.processInfo.environment
        if let raw = environment["BARRY_API_URL"],
           let url = URL(string: raw),
           let port = url.port {
            return (port, environment["BARRY_SECRET"])
        }

        for label in ["com.barry.api", "com.barry.api.dev"] {
            guard let vars = launchAgentEnvironment(label: label),
                  let port = vars["PORT"].flatMap(Int.init)
            else { continue }
            return (port, vars["BARRY_SECRET"] ?? environment["BARRY_SECRET"])
        }

        // Fallback: parse `launchctl print` output for env vars
        return readFromLaunchctl()
    }

    /// The `EnvironmentVariables` dictionary of an installed launch agent.
    private static func launchAgentEnvironment(label: String) -> [String: String]? {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
        guard let data = try? Data(contentsOf: path),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return plist["EnvironmentVariables"] as? [String: String]
    }

    /// Where the web UI lives, for links out of the app (an event's session).
    ///
    /// Resolved the same way as the API: env override, prod agent, dev agent,
    /// then the prod default. Without this the events feed's "Open session"
    /// has nowhere to point.
    public static func webBaseURL() -> URL {
        let environment = ProcessInfo.processInfo.environment
        if let raw = environment["BARRY_WEB_URL"], let url = URL(string: raw) { return url }

        for label in ["com.barry.web", "com.barry.web.dev"] {
            guard let vars = launchAgentEnvironment(label: label),
                  let port = vars["PORT"].flatMap(Int.init),
                  let url = URL(string: "http://localhost:\(port)")
            else { continue }
            return url
        }
        return URL(string: "http://localhost:9429")!
    }

    private static func readFromLaunchctl() -> (port: Int, secret: String?) {
        let uid = getuid()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["print", "gui/\(uid)/com.barry.api"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        guard (try? process.run()) != nil else { return (defaultProdPort, nil) }
        process.waitUntilExit()

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return (defaultProdPort, nil) }

        var port = defaultProdPort
        var secret: String?

        for line in output.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("PORT => ") {
                port = Int(trimmed.replacingOccurrences(of: "PORT => ", with: "")) ?? defaultProdPort
            } else if trimmed.hasPrefix("BARRY_SECRET => ") {
                secret = trimmed.replacingOccurrences(of: "BARRY_SECRET => ", with: "")
            }
        }

        return (port, secret)
    }

    // MARK: - Health

    public func checkHealth() async -> Bool {
        do {
            let url = baseURL.appendingPathComponent("health")
            let (_, response) = try await session.data(from: url)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    // MARK: - Request primitives

    public func get<T: Decodable>(_ path: String, query: [URLQueryItem]? = nil) async throws -> T {
        var url = apiURL(path)
        if let query, !query.isEmpty {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            components.queryItems = query
            url = components.url!
        }
        var request = URLRequest(url: url)
        addAuth(&request)
        let (data, response) = try await session.data(for: request)
        try validate(data: data, response: response, fallback: "Request failed")
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func patch(_ path: String, body: [String: Any]) async throws {
        try await send("PATCH", path, body: body, fallback: "Update failed")
    }

    public func post(_ path: String, body: [String: Any]) async throws {
        try await send("POST", path, body: body, fallback: "Request failed")
    }

    public func postReturning<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        let data = try await send("POST", path, body: body, fallback: "Request failed")
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - Private

    private func addAuth(_ request: inout URLRequest) {
        if let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    @discardableResult
    private func send(_ method: String, _ path: String, body: [String: Any], fallback: String) async throws -> Data {
        var request = URLRequest(url: apiURL(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        addAuth(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await session.data(for: request)
        try validate(data: data, response: response, fallback: fallback)
        return data
    }

    private func validate(data: Data, response: URLResponse, fallback: String) throws {
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let problem = try? JSONDecoder().decode(ProblemResponse.self, from: data)
            let msg = problem?.detail ?? problem?.title ?? fallback
            throw ClientError.serverError(msg)
        }
    }

    private func apiURL(_ path: String) -> URL {
        baseURL.appendingPathComponent("api/v1").appendingPathComponent(path)
    }
}

struct ProblemResponse: Decodable {
    let title: String
    let detail: String?
}

public enum ClientError: LocalizedError {
    case serverError(String)

    public var errorDescription: String? {
        switch self {
        case .serverError(let msg): return msg
        }
    }
}
