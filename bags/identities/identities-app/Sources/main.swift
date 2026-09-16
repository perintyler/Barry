import AppKit
import IdentitiesFeature
import SwiftUI

/// Barry Identities: a windowed app for managing identities.
///
/// Deliberately not a menu bar app. Identity configuration is editing work —
/// it wants a resizable window you can leave open, not a popover that closes
/// on an outside click, which is what made the original version frustrating.
/// It carries no status item either: the menu bar is down to one Barry icon
/// and should stay there. Barry Sessions launches this by bundle id from the
/// profile button in its popover.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let state = IdentitiesState()
    private var window: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `.regular` from the start, unlike the menu bar apps: a window that
        // cannot take key focus has text fields that ignore typing, and this
        // app is almost entirely text fields.
        NSApp.setActivationPolicy(.regular)
        NSApp.mainMenu = Self.makeMenu()

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 560),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Identities"
        window.contentViewController = NSHostingController(
            rootView: IdentitiesWindowView(state: state)
        )
        // NSWindowController would force this anyway, but this app has no
        // controller — without it the default `true` over-releases a window
        // ARC owns and the process dies on close.
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("BarryIdentitiesWindow")
        window.center()
        window.delegate = self
        self.window = window

        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    /// Re-open on a Dock click after the window was closed.
    ///
    /// Without this the app stays running with nothing on screen and clicking
    /// its Dock icon does nothing, which reads as a hang.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window?.makeKeyAndOrderFront(nil) }
        return true
    }

    /// One window, so closing it means quitting.
    ///
    /// The app is launched on demand from Barry Sessions; leaving a windowless
    /// process resident afterwards would accumulate one per open.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// A minimal menu, mostly so the standard editing commands resolve through
    /// the responder chain. A `.regular` app with no main menu has no Edit
    /// menu, so ⌘C/⌘V/⌘A/⌘Z are dead in every text field.
    private static func makeMenu() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "Quit Identities",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        // nil targets on purpose: these dispatch down the responder chain to
        // whichever field is first responder.
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
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
