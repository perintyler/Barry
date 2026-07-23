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
        popover.contentSize = NSSize(width: 420, height: 620)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(
            rootView: ContentView(appState: appState)
                .frame(width: 420, height: 620)
        )

        contextMenu = NSMenu()
        let quitItem = NSMenuItem(
            title: "Quit Barry Profiles",
            action: #selector(quitApp),
            keyEquivalent: "q"
        )
        quitItem.target = self
        contextMenu.addItem(quitItem)

        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: "person.crop.rectangle.stack",
                accessibilityDescription: "Barry Profiles"
            )
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.action = #selector(handleStatusItemClick)
            button.target = self
        }
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

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

appDelegateRef = AppDelegate()
appDelegateRef.setup()
app.delegate = appDelegateRef

app.run()
