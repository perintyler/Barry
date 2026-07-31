import Foundation

/// Where the API and web UI live, and the secret to talk to them.
///
/// Everything is read from the installed launchd plists so the app works with no
/// configuration on a normal Barry machine, whether the prod or dev service is
/// the one installed.
enum BarryConfig {
    static func apiEndpoint() -> (baseURL: URL, secret: String?) {
        let env = ProcessInfo.processInfo.environment
        if let raw = env["BARRY_API_URL"], let url = URL(string: raw) {
            return (url, env["BARRY_SECRET"])
        }
        for label in ["com.barry.api", "com.barry.api.dev"] {
            guard let vars = launchAgentEnvironment(label: label),
                  let port = vars["PORT"].flatMap(Int.init),
                  let url = URL(string: "http://localhost:\(port)")
            else { continue }
            return (url, vars["BARRY_SECRET"] ?? env["BARRY_SECRET"])
        }
        return (URL(string: "http://localhost:4854")!, env["BARRY_SECRET"])
    }

    static func webBaseURL() -> URL {
        let env = ProcessInfo.processInfo.environment
        if let raw = env["BARRY_WEB_URL"], let url = URL(string: raw) { return url }

        for label in ["com.barry.web", "com.barry.web.dev"] {
            guard let vars = launchAgentEnvironment(label: label),
                  let port = vars["PORT"].flatMap(Int.init),
                  let url = URL(string: "http://localhost:\(port)")
            else { continue }
            return url
        }
        return URL(string: "http://localhost:9429")!
    }

    private static func launchAgentEnvironment(label: String) -> [String: String]? {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
        guard let data = try? Data(contentsOf: path),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return nil }
        return plist["EnvironmentVariables"] as? [String: String]
    }
}
