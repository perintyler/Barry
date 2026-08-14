import SwiftUI
import AppKit

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let appState = AppState()

    func setup() {
        let contentView = ContentView(appState: appState)
        let hostingController = NSHostingController(rootView: contentView)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1020, height: 700),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "BDiff"
        window.minSize = NSSize(width: 720, height: 500)
        window.contentViewController = hostingController
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard url.scheme == "bdiff",
                  url.host == "session",
                  let sessionId = url.pathComponents.dropFirst().first else { continue }
            appState.openFromURL(sessionId: sessionId)
            break
        }
    }
}

// Strong global reference (NSApp.delegate is weak)
nonisolated(unsafe) var appDelegateRef: AppDelegate!

// Top-level code runs on the main thread, but main.swift executables don't get
// static MainActor isolation — assert it so we can touch MainActor types.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)

    appDelegateRef = AppDelegate()
    appDelegateRef.setup()
    app.delegate = appDelegateRef

    // Handle URL on launch (when app is opened via bdiff:// and wasn't running)
    if let url = ProcessInfo.processInfo.arguments.dropFirst().first.flatMap({ URL(string: $0) }),
       url.scheme == "bdiff" {
        appDelegateRef.application(app, open: [url])
    }

    app.run()
}
