import SwiftUI
import AppKit
import Combine
import UserNotifications

// BarryEvents — a menu-bar app for the Barry event feed: agent progress,
// notifications, task completions, and system alerts.
//
// Deliberately self-contained: it reads the API port and secret straight from
// the com.barry.api launchd plist and decodes only the fields it needs, so it
// carries no dependency on BarryKit's generated OpenAPI client.

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var contextMenu: NSMenu!
    private var cancellables = Set<AnyCancellable>()
    private let state = AppState()

    func setup() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = menuBarIcon(hasUnread: false)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.action = #selector(handleClick)
            button.target = self
        }

        popover = NSPopover()
        popover.contentSize = NSSize(width: 380, height: 520)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(
            rootView: ContentView(state: state).frame(width: 380, height: 520)
        )

        contextMenu = NSMenu()
        let quit = NSMenuItem(title: "Quit Barry Events", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        contextMenu.addItem(quit)

        UNUserNotificationCenter.current().delegate = self

        // Reflect unread state in the menu bar icon.
        state.$unreadCount
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] count in
                guard let self, let button = self.statusItem.button else { return }
                button.image = self.menuBarIcon(hasUnread: count > 0)
            }
            .store(in: &cancellables)

        state.start()
    }

    private func menuBarIcon(hasUnread: Bool) -> NSImage? {
        NSImage(
            systemSymbolName: hasUnread ? "bell.badge.fill" : "bell",
            accessibilityDescription: hasUnread ? "Barry Events — unread" : "Barry Events"
        )
    }

    @objc private func handleClick() {
        guard let button = statusItem.button else { return }

        if let event = NSApp.currentEvent, event.type == .rightMouseUp {
            popover.performClose(nil)
            NSMenu.popUpContextMenu(contextMenu, with: event, for: button)
            return
        }

        if popover.isShown {
            closePopover()
        } else {
            state.isPopoverOpen = true
            state.refresh()
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func closePopover() {
        state.isPopoverOpen = false
        popover.performClose(nil)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // Show banners even while this app is frontmost.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // Clicking a notification runs whatever action the event asked for —
    // authorizing a pack, or opening its session in the web UI.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo

        if info["action"] as? String == "pack_auth", let packs = info["packs"] as? [String] {
            // Kicks off the OAuth flow server-side; mcp-remote opens the browser
            // tab. The endpoint is single-flight per pack, so a double-click on
            // the banner can't produce two tabs.
            Task { @MainActor in
                await self.state.authorizePacks(packs)
                completionHandler()
            }
            return
        }

        if let raw = info["sessionURL"] as? String, let url = URL(string: raw) {
            NSWorkspace.shared.open(url)
        }
        completionHandler()
    }
}

// Fonts must be registered before any view renders.
registerBundledFonts()

// Strong reference — NSApplication.delegate is weak.
var appDelegateRef: AppDelegate?

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate()
    delegate.setup()
    appDelegateRef = delegate
    app.delegate = delegate
    app.run()
}
