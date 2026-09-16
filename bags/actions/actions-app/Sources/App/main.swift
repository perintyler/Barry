import ActionsFeature
import AppKit
import SwiftUI

/// Barry Actions: a windowed app for reading action runs and their
/// deliverables.
///
/// Deliberately not a menu bar app, for the reason BarryIdentities gives: a
/// popover closes on an outside click, and a wrap-up report is something you
/// read, scroll and copy out of. It carries no status item either — the menu
/// bar is down to one Barry icon and should stay there.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let state = ActionsState()
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `.regular` from the start: the window has a filter picker and
        // selectable text, and a window that cannot take key focus makes both
        // inert.
        NSApp.setActivationPolicy(.regular)
        NSApp.mainMenu = Self.makeMenu()

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_040, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Actions"
        window.contentViewController = NSHostingController(
            rootView: ActionsWindowView(state: state)
        )
        // Setting contentViewController re-sizes the window to the hosted
        // view's fitting size, discarding the contentRect above — which for a
        // NavigationSplitView collapsed it to 1x80pt. Restore the intended
        // size after the assignment, and set a floor so a saved frame from a
        // bad run cannot bring the collapsed window back.
        window.setContentSize(NSSize(width: 1_040, height: 680))
        window.contentMinSize = NSSize(width: 720, height: 420)
        // Without this the default `true` over-releases a window ARC owns and
        // the process dies on close. This app has no NSWindowController to
        // force it.
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("BarryActionsWindow")
        window.center()
        window.delegate = self
        self.window = window

        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    /// Quit when the window closes. Keeping a process resident for an
    /// occasional read is a cost with no return — the same call BarryIdentities
    /// makes.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// A minimal menu, but a real one: without it the app has no Quit item and
    /// no Copy, and the whole point of the window is copying reports out.
    private static func makeMenu() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "Quit Barry Actions",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(
            withTitle: "Select All",
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )
        editItem.submenu = editMenu
        main.addItem(editItem)

        return main
    }
}

// Strong global reference (NSApp.delegate is weak)
var appDelegateRef: AppDelegate!

MainActor.assumeIsolated {
    let app = NSApplication.shared
    appDelegateRef = AppDelegate()
    app.delegate = appDelegateRef
    app.run()
}
