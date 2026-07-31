import Foundation

/// Shared HTTP core for Barry's macOS apps.
///
/// Reads the API port and secret from the `com.barry.api` launchd plist
/// (with a `launchctl print` fallback) and provides the generic request
/// primitives. Apps keep their own `BarryClient` actor with app-specific
/// endpoint methods that delegate to a `BarryCore` instance.
public struct BarryCore: Sendable {
    public let baseURL: URL
    private let session: URLSession
    /// The API secret, exposed because the WebSocket upgrade at `/api/v1/ws`
    /// requires it even from localhost (unlike the HTTP routes, which are
    /// exempt) — a bus client has to set the header itself.
    public let authToken: String?
    public let transport: BarryTransport

    public init() {
        let (port, secret) = Self.readLaunchdConfig()
        self.baseURL = URL(string: "http://localhost:\(port)")!
        self.authToken = secret
        self.transport = BarryTransport(baseURL: self.baseURL, token: secret)

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        self.session = URLSession(configuration: config)
    }

    private static func readLaunchdConfig() -> (port: Int, secret: String?) {
        let plistPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.barry.api.plist")

        if let data = try? Data(contentsOf: plistPath),
           let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
           let env = plist["EnvironmentVariables"] as? [String: String] {
            let port = env["PORT"].flatMap(Int.init) ?? 3854
            let secret = env["BARRY_SECRET"]
            return (port, secret)
        }

        // Fallback: parse `launchctl print` output for env vars
        return readFromLaunchctl()
    }

    private static func readFromLaunchctl() -> (port: Int, secret: String?) {
        let uid = getuid()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["print", "gui/\(uid)/com.barry.api"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        guard (try? process.run()) != nil else { return (3854, nil) }
        process.waitUntilExit()

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return (3854, nil) }

        var port = 3854
        var secret: String?

        for line in output.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("PORT => ") {
                port = Int(trimmed.replacingOccurrences(of: "PORT => ", with: "")) ?? 3854
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
