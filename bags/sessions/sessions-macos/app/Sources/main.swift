import SwiftUI
import AppKit

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var popover: NSPopover!
    var contextMenu: NSMenu!
    let appState = AppState()

    func setup() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        popover = NSPopover()
        popover.contentSize = NSSize(width: 580, height: 680)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(
            rootView: ContentView(appState: appState)
                .frame(width: 580, height: 680)
        )

        contextMenu = NSMenu()
        let quitItem = NSMenuItem(
            title: "Quit Barry Sessions",
            action: #selector(quitApp),
            keyEquivalent: "q"
        )
        quitItem.target = self
        contextMenu.addItem(quitItem)

        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: "slider.horizontal.3",
                accessibilityDescription: "Barry Sessions"
            )
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.action = #selector(handleStatusItemClick)
            button.target = self
        }

        // UI-automation hook: a transient NSPopover attached to a status item is
        // invisible to the accessibility tree, so scripted QA can't reach the
        // message list. When BARRY_UI_TEST is set, expose the popover content as
        // an accessibility child of the app and auto-open it, so an AX client
        // (AppleScript / XCTest) can drive the scroll view without a coordinate
        // click. Opt-in only — no effect on normal use.
        if ProcessInfo.processInfo.environment["BARRY_UI_TEST"] != nil {
            enableUITestAccessibility()
        }
    }

    /// Expose the popover content to the accessibility tree and open it, for
    /// scripted UI QA. See the call site in `setup()`.
    private func enableUITestAccessibility() {
        popover.setAccessibilityEnabled(true)
        if let contentView = popover.contentViewController?.view {
            contentView.setAccessibilityEnabled(true)
            contentView.setAccessibilityRole(.group)
            contentView.setAccessibilityIdentifier("PopoverContent")
            NSApp.setAccessibilityChildren([contentView])
        }
        if let button = statusItem.button {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func handleStatusItemClick() {
        guard let button = statusItem.button else { return }
        if let event = NSApp.currentEvent, event.type == .rightMouseUp {
            popover.performClose(nil)
            NSMenu.popUpContextMenu(contextMenu, with: event, for: button)
            return
        }

        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }
}

// Strong global reference (NSApp.delegate is weak)
var appDelegateRef: AppDelegate!

registerBundledFonts()

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

appDelegateRef = AppDelegate()
appDelegateRef.setup()
app.delegate = appDelegateRef

app.run()
