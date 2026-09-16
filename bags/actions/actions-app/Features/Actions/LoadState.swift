import Foundation

/// The state of a fetch.
///
/// `loaded([])` and `failed` are SEPARATE CASES, and that is the whole point.
/// The bug this app is built to avoid is a viewer whose broken state is
/// indistinguishable from its healthy one: BarryKit reads the API port and
/// secret from the `com.barry.api` launchd job, so a missing secret makes
/// every request 401. Rendered as "no runs yet", that reads as a quiet, honest
/// empty list — and the user would conclude their runs were not being
/// recorded. Making failure unrepresentable as emptiness is what keeps the
/// window's silence meaningful.
public enum LoadState<Value: Sendable>: Sendable {
    case idle
    case loading
    case loaded(Value)
    case failed(String)

    public var value: Value? {
        if case let .loaded(value) = self { return value }
        return nil
    }

    public var errorMessage: String? {
        if case let .failed(message) = self { return message }
        return nil
    }

    public var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }
}

/// Turn a thrown error into something a person can act on.
///
/// A raw `URLError` reads as noise, and the two failures that actually happen
/// here have specific fixes: the API is not running, or the secret this app
/// read from launchd is not the one the API wants. Naming them is the
/// difference between a banner someone can act on and one they learn to
/// ignore.
public func describeFetchFailure(_ error: Error) -> String {
    if let urlError = error as? URLError {
        switch urlError.code {
        case .cannotConnectToHost, .cannotFindHost, .networkConnectionLost:
            return "Cannot reach the Barry API. Is com.barry.api running? "
                + "Check with `barry service status`."
        case .timedOut:
            return "The Barry API did not respond in time."
        default:
            return "Request failed: \(urlError.localizedDescription)"
        }
    }

    // swift-openapi-runtime reports an unexpected status (401, 404, 500) as an
    // undocumented-response error whose description carries the code.
    let text = String(describing: error)
    if text.contains("401") || text.localizedCaseInsensitiveContains("unauthorized") {
        return "The API rejected this app's credentials (401). BarryKit reads "
            + "BARRY_SECRET from the com.barry.api launchd job — it may be stale or unset."
    }
    return "Request failed: \(error.localizedDescription)"
}
