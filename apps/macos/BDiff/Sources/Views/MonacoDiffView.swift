import SwiftUI
import WebKit

/// Hosts Monaco Editor's DiffEditor in a WKWebView.
///
/// The view loads a self-contained HTML file bundled in Resources that contains
/// the full Monaco editor bundle with Catppuccin themes. Communication between
/// Swift and JS happens through `WKWebView.evaluateJavaScript` (Swift→JS) and
/// `WKScriptMessageHandler` (JS→Swift).
///
/// Review comments: Swift pushes the current file's threads via `setComments`;
/// the webview owns composer draft state and posts `submitComment` /
/// `replyComment` / `deleteComment` back over the bridge.
struct MonacoDiffView: NSViewRepresentable {
    let original: String
    let modified: String
    let language: String
    let filePath: String
    let isDark: Bool
    var comments: [ReviewComment] = []
    var commentingEnabled: Bool = false
    var revealToken: Int = 0
    var onSubmitComment: ((_ side: String, _ lineStart: Int?, _ line: Int, _ lineContent: String, _ body: String) -> Void)?
    var onReply: ((_ commentId: String, _ body: String) -> Void)?
    var onDelete: ((_ commentId: String) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let handler = context.coordinator
        config.userContentController.add(handler, name: "bridge")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = handler
        webView.setValue(false, forKey: "drawsBackground")

        handler.webView = webView
        handler.pendingUpdate = (original, modified, language, filePath, isDark)
        handler.callbacks = (onSubmitComment, onReply, onDelete)

        // Load the bundled Monaco HTML — try the app bundle first (production),
        // then the SPM resource bundle (development `swift run`)
        let htmlURL: URL? = Bundle.main.url(forResource: "monaco-diff", withExtension: "html")
            ?? Bundle.module.url(forResource: "monaco-diff", withExtension: "html")
        if let htmlURL {
            webView.loadFileURL(htmlURL, allowingReadAccessTo: htmlURL.deletingLastPathComponent())
        }

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        let coordinator = context.coordinator
        let update = (original, modified, language, filePath, isDark)
        coordinator.callbacks = (onSubmitComment, onReply, onDelete)

        // Theme changes
        if coordinator.currentIsDark != isDark {
            coordinator.currentIsDark = isDark
            let theme = isDark ? "catppuccin-mocha" : "catppuccin-latte"
            webView.evaluateJavaScript("setTheme('\(theme)')") { _, _ in }

            // Also update body background for the gap before Monaco paints
            let bg = isDark ? "#181825" : "#E6E9EF"
            webView.evaluateJavaScript("document.body.style.background = '\(bg)'") { _, _ in }
        }

        // Content changes
        if coordinator.currentOriginal != original
            || coordinator.currentModified != modified
            || coordinator.currentLanguage != language
            || coordinator.currentFilePath != filePath {

            if coordinator.isReady {
                coordinator.sendUpdate(original, modified, language, filePath)
            } else {
                coordinator.pendingUpdate = update
            }
        }

        // Comment state
        coordinator.pushCommentsIfChanged(comments)
        coordinator.pushCommentingEnabledIfChanged(commentingEnabled)

        // Reveal request (pill click)
        if coordinator.currentRevealToken != revealToken {
            coordinator.currentRevealToken = revealToken
            if coordinator.isReady {
                webView.evaluateJavaScript("revealFirstComment()") { _, _ in }
            }
        }
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        var isReady = false
        var pendingUpdate: (String, String, String, String, Bool)?
        var callbacks: (
            submit: ((String, Int?, Int, String, String) -> Void)?,
            reply: ((String, String) -> Void)?,
            delete: ((String) -> Void)?
        )?

        var currentOriginal: String?
        var currentModified: String?
        var currentLanguage: String?
        var currentFilePath: String?
        var currentIsDark: Bool?
        var currentCommentsJSON: String?
        var currentCommentingEnabled: Bool?
        var currentRevealToken = 0

        // MARK: WKScriptMessageHandler

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let dict = message.body as? [String: Any],
                  let type = dict["type"] as? String else { return }

            switch type {
            case "ready":
                isReady = true
                flushPending()

            case "submitComment":
                guard let side = dict["side"] as? String,
                      let line = dict["line"] as? Int,
                      let lineContent = dict["lineContent"] as? String,
                      let body = dict["body"] as? String else { return }
                let lineStart = dict["lineStart"] as? Int // NSNull → nil
                let submit = callbacks?.submit
                Task { @MainActor in submit?(side, lineStart, line, lineContent, body) }

            case "replyComment":
                guard let commentId = dict["commentId"] as? String,
                      let body = dict["body"] as? String else { return }
                let reply = callbacks?.reply
                Task { @MainActor in reply?(commentId, body) }

            case "deleteComment":
                guard let commentId = dict["commentId"] as? String else { return }
                let delete = callbacks?.delete
                Task { @MainActor in delete?(commentId) }

            case "jsError":
                let msg = dict["message"] as? String ?? "unknown"
                let line = dict["line"] as? Int ?? 0
                FileHandle.standardError.write(Data("[MonacoDiffView] page error: \(msg) (line \(line))\n".utf8))

            default:
                break
            }
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Monaco signals readiness via the bridge message handler,
            // but if the script fires before the handler is wired, catch it here
            webView.evaluateJavaScript("window.monacoReady === true") { [weak self] result, _ in
                if let ready = result as? Bool, ready, self?.isReady == false {
                    self?.isReady = true
                    self?.flushPending()
                }
            }
        }

        // MARK: - Helpers

        private func flushPending() {
            if let (original, modified, language, filePath, isDark) = pendingUpdate {
                let theme = isDark ? "catppuccin-mocha" : "catppuccin-latte"
                webView?.evaluateJavaScript("setTheme('\(theme)')") { _, _ in }
                let bg = isDark ? "#181825" : "#E6E9EF"
                webView?.evaluateJavaScript("document.body.style.background = '\(bg)'") { _, _ in }
                currentIsDark = isDark
                sendUpdate(original, modified, language, filePath)
                pendingUpdate = nil
            }
            // Re-push comment state now that the page can receive it
            if let json = currentCommentsJSON {
                webView?.evaluateJavaScript("setComments(\(json))") { _, _ in }
            }
            if let enabled = currentCommentingEnabled {
                webView?.evaluateJavaScript("setCommentingEnabled(\(enabled))") { _, _ in }
            }
        }

        func sendUpdate(_ original: String, _ modified: String, _ language: String, _ filePath: String) {
            currentOriginal = original
            currentModified = modified
            currentLanguage = language
            currentFilePath = filePath

            // JSON-encode the strings to safely pass them into JS
            let origJSON = jsonEscape(original)
            let modJSON = jsonEscape(modified)
            let langJSON = jsonEscape(language)
            let pathJSON = jsonEscape(filePath)

            let js = "updateDiff(\(origJSON), \(modJSON), \(langJSON), \(pathJSON))"
            webView?.evaluateJavaScript(js) { [weak self] _, error in
                if let error {
                    FileHandle.standardError.write(Data("[MonacoDiffView] updateDiff error: \(error)\n".utf8))
                }
                // updateDiff recreates models and closes the composer — re-push
                // threads so they render against the new models
                if let json = self?.currentCommentsJSON {
                    self?.webView?.evaluateJavaScript("setComments(\(json))") { _, _ in }
                }
            }
        }

        func pushCommentsIfChanged(_ comments: [ReviewComment]) {
            let payload = comments.map(MonacoComment.init)
            guard let data = try? JSONEncoder().encode(payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            guard json != currentCommentsJSON else { return }
            currentCommentsJSON = json
            if isReady {
                webView?.evaluateJavaScript("setComments(\(json))") { _, _ in }
            }
        }

        func pushCommentingEnabledIfChanged(_ enabled: Bool) {
            guard currentCommentingEnabled != enabled else { return }
            currentCommentingEnabled = enabled
            if isReady {
                webView?.evaluateJavaScript("setCommentingEnabled(\(enabled))") { _, _ in }
            }
        }

        private func jsonEscape(_ string: String) -> String {
            guard let data = try? JSONEncoder().encode(string),
                  let json = String(data: data, encoding: .utf8) else {
                return "\"\""
            }
            return json
        }
    }
}

/// Minimal comment payload for the webview — stable field order via Encodable.
private struct MonacoComment: Encodable {
    let id: String
    let side: String
    let line: Int
    let lineStart: Int?
    let body: String
    let status: String
    let resolutionNote: String?
    let replies: [MonacoReply]

    init(_ comment: ReviewComment) {
        id = comment.id
        side = comment.side
        line = comment.line
        lineStart = comment.lineStart
        body = comment.body
        status = comment.status
        resolutionNote = comment.resolutionNote
        replies = comment.replies.map { MonacoReply(author: $0.author, body: $0.body) }
    }
}

private struct MonacoReply: Encodable {
    let author: String
    let body: String
}
