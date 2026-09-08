import SwiftUI
import AppKit
import BarryKit
import BarrySessionsCore
import Combine
import Components
import ApprovalsFeature
import EventsFeature
import ServicesFeature
import UserNotifications

/// Marked `@MainActor` because every member touches AppKit or a main-actor
/// view model. Without it the events state — which is main-actor isolated, as
/// anything driving SwiftUI must be — cannot be constructed or mutated here.
@MainActor
class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate, UNUserNotificationCenterDelegate {
    var statusItem: NSStatusItem!
    var popover: NSPopover!
    var contextMenu: NSMenu!
    /// One socket for the whole app.
    ///
    /// The server keys subscriptions per connection, so every topic the app
    /// cares about rides this single client. Each feature registers a handler
    /// through `subscribe` and the client fans out by topic name. Before the
    /// merge these were two apps and therefore two sockets; keeping that shape
    /// would have meant two connections in one process for no benefit.
    let bus: BusClient

    let appState: AppState
    let eventsState: EventsState
    let servicesState = ServicesState()
    let approvalsState = ApprovalsState()
    private var cancellables: Set<AnyCancellable> = []

    override init() {
        let bus = Self.makeBus()
        self.bus = bus
        self.appState = AppState(bus: bus)
        self.eventsState = EventsState(bus: bus)
        super.init()
    }

    /// Open the identities manager in its own window.
    ///
    /// Configuration work does not belong in a transient popover that closes on
    /// any outside click, which is what made the old app frustrating.
    func openIdentities() {
        IdentitiesAppLauncher.open { [weak self] in
            self?.popover.performClose(nil)
        }
    }

    private static func makeBus() -> BusClient {
        let core = BarryCore()
        return BusClient(
            baseURL: core.baseURL,
            secret: core.authToken,
            topics: ["sessions", "events"]
        )
    }

    func setup() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        popover = NSPopover()
        popover.contentSize = NSSize(width: 580, height: 680)
        popover.behavior = .transient
        popover.delegate = self
        popover.contentViewController = NSHostingController(
            rootView: ContentView(
                appState: appState,
                eventsState: eventsState,
                servicesState: servicesState,
                approvalsState: approvalsState,
                onOpenIdentities: { [weak self] in self?.openIdentities() }
            )
                .frame(width: 580, height: 680)
        )

        contextMenu = NSMenu()

        // Carried over from the standalone services app, which had it here.
        // It opens the popover on the services tab first, because the
        // confirmation renders inside that view — firing it blind would ask
        // for confirmation the user cannot see.
        let shutdownItem = NSMenuItem(
            title: "Shutdown Barry",
            action: #selector(shutdownBarry),
            keyEquivalent: ""
        )
        shutdownItem.target = self
        contextMenu.addItem(shutdownItem)

        // Rebuilds from source before coming back, so this is the item that
        // picks up local changes — see `restartApp`.
        let restartItem = NSMenuItem(
            title: "Restart Barry Sessions",
            action: #selector(restartApp),
            keyEquivalent: ""
        )
        restartItem.target = self
        contextMenu.addItem(restartItem)
        contextMenu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(
            title: "Quit Barry",
            action: #selector(quitApp),
            keyEquivalent: "q"
        )
        quitItem.target = self
        contextMenu.addItem(quitItem)

        if let button = statusItem.button {
            button.image = Self.statusIcon(hasUnread: false)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.action = #selector(handleStatusItemClick)
            button.target = self
        }

        // Unread events are the one thing worth surfacing without opening
        // anything, so the single icon carries a dot. Folding the apps together
        // otherwise costs the ambient signal the separate bell icon provided.
        eventsState.$unreadCount
            .removeDuplicates()
            .receive(on: RunLoop.main)
            .sink { [weak self] count in
                self?.statusItem.button?.image = Self.statusIcon(hasUnread: count > 0)
            }
            .store(in: &cancellables)

        // Must be set before any notification is delivered, or clicks fall on
        // the floor: without a delegate the system opens the app and drops the
        // response, so "authorize this bag" banners would do nothing at all.
        UNUserNotificationCenter.current().delegate = self

        // Register the Approve/Deny buttons before any approval banner can be
        // posted. Without the category the banner still shows, but with no
        // buttons — and the user's only route to a blocked agent is opening the
        // app, which defeats the point of notifying at all.
        UNUserNotificationCenter.current().setNotificationCategories([
            ApprovalNotification.makeCategory()
        ])

        eventsState.start()
        servicesState.start()
        approvalsState.start()

        // Register the sessions handler here rather than leaving it to
        // `AppState.start()`, which ContentView only calls from its `.task` —
        // i.e. after this method returns, and from inside another Task. The
        // socket below would therefore connect with no sessions subscriber
        // attached, and every frame arriving in that window would be dropped:
        // the app would look connected while quietly missing updates until the
        // 60s fallback poll covered for it.
        appState.attachBus()

        // One socket, started once, after every feature has subscribed.
        bus.start()

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

    /// The menu bar glyph, with an unread dot composited into the corner.
    ///
    /// Drawn into the image rather than added as a subview of the status
    /// button: the button re-lays out its content on appearance and screen
    /// changes and will discard stray subviews. `isTemplate` has to be set on
    /// the *composite* so macOS keeps tinting it for light, dark and the
    /// highlighted (menu-open) state — set it only on the base symbol and the
    /// dot renders as an opaque blob that ignores the menu bar's appearance.
    private static func statusIcon(hasUnread: Bool) -> NSImage? {
        guard let base = NSImage(
            systemSymbolName: "slider.horizontal.3",
            accessibilityDescription: hasUnread ? "Barry — unread events" : "Barry"
        ) else { return nil }
        guard hasUnread else { return base }

        let size = base.size
        let composite = NSImage(size: size)
        composite.lockFocus()
        base.draw(in: NSRect(origin: .zero, size: size))
        let diameter: CGFloat = 4
        let dot = NSBezierPath(ovalIn: NSRect(
            x: size.width - diameter,
            y: size.height - diameter,
            width: diameter,
            height: diameter
        ))
        NSColor.black.setFill()
        dot.fill()
        composite.unlockFocus()
        composite.isTemplate = true
        return composite
    }

    /// Expose the popover content to the accessibility tree and open it, for
    /// scripted UI QA. See the call site in `setup()`.
    private func enableUITestAccessibility() {
        // A `.transient` popover closes on any outside activation — including
        // the `NSApp.activate` below and the app's own launch activation. That
        // close routes through `popoverDidClose` → `resetToHome()`, which
        // clears `selectedSessionId` moments after the BARRY_UI_TEST_SESSION
        // hook sets it, so the popover stayed open on the session list and the
        // Messages tab never rendered. Under UI test the popover has to be the
        // one thing that does NOT vanish when something takes focus.
        popover.behavior = .applicationDefined
        popover.setAccessibilityEnabled(true)
        if let contentView = popover.contentViewController?.view {
            contentView.setAccessibilityEnabled(true)
            contentView.setAccessibilityRole(.group)
            contentView.setAccessibilityIdentifier("PopoverContent")
            NSApp.setAccessibilityChildren([contentView])
        }
        if let button = statusItem.button {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            setFeedVisible(popoverOpen: true)
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
            // A fresh open always lands on the home tab, so the feed is not on
            // screen yet. `ContentView` takes over from here on tab changes.
            setFeedVisible(popoverOpen: true)
        }
    }

    /// Open the popover without toggling, for callers that need it shown —
    /// tapping an approval banner's body should reveal the request, never
    /// dismiss an already-open window.
    func showPopover() {
        guard let button = statusItem.button, !popover.isShown else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)
        setFeedVisible(popoverOpen: true)
    }

    /// Reopening the menu bar item should always land on the session list, not
    /// resume whatever screen was open when it was dismissed.
    ///
    /// This lives on the delegate rather than the click handler because a
    /// `.transient` popover also closes on an outside click, which never routes
    /// through `handleStatusItemClick`. `popoverDidClose` covers every path —
    /// including the close that a window activation causes.
    func popoverDidClose(_ notification: Notification) {
        appState.resetToHome()
        setFeedVisible(popoverOpen: false)
    }

    /// Recompute whether the events feed counts as on screen.
    ///
    /// The tab half of the answer is owned by `ContentView`; this covers the
    /// popover half. Both have to agree or the app either swallows every
    /// banner or announces events the user is already reading.
    private func setFeedVisible(popoverOpen: Bool) {
        eventsState.isFeedVisible = RootNavigation.isVisible(
            .events,
            selected: popoverOpen ? RootNavigation.home : .sessions,
            whilePopoverOpen: popoverOpen
        )
    }

    /// Ask the services tab to confirm a full shutdown.
    ///
    /// The confirmation is rendered by `ServicesView`, so the popover has to be
    /// open and on that tab before the request goes in — otherwise the app
    /// waits on an answer to a question nobody was shown.
    @objc func shutdownBarry() {
        guard let button = statusItem.button else { return }
        if !popover.isShown {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
        }
        appState.requestTab(.services)
        servicesState.requestShutdown()
    }

    /// Rebuild this app from source and bring the new binary back up.
    ///
    /// The work happens in a detached helper rather than here because this
    /// process cannot survive its own update: installing replaces the bundle
    /// whose binary is currently mapped in, and copying over a live binary
    /// SIGKILLs the app ("Code Signature Invalid"). So this spawns the script,
    /// fully detached, and then terminates — the script waits for the exit
    /// before it touches anything, and relaunches whichever build it ends up
    /// with. A failed build is put back as the previous version, so the menu
    /// bar is never left empty.
    @objc func restartApp() {
        let script = SelfUpdateLocation.resolveScript(
            home: FileManager.default.homeDirectoryForCurrentUser,
            environment: ProcessInfo.processInfo.environment,
            exists: { FileManager.default.isExecutableFile(atPath: $0.path) }
        )

        guard let script else {
            // Nothing to run: quitting here would take the app down and never
            // bring it back, so stay up and say why.
            NSLog("Restart unavailable: no self-update script found")
            let alert = NSAlert()
            alert.messageText = "Can't restart"
            alert.informativeText = """
                Barry Sessions could not find its source checkout, so it has \
                nothing to rebuild from. It looked for \
                \(SelfUpdateLocation.scriptSubpath) under $BARRY_REPO and \
                ~/repos/barry.
                """
            alert.alertStyle = .warning
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            return
        }

        // The helper must outlive the terminate below — all of its work
        // happens after this process is gone. An orphaned child reparents to
        // launchd and keeps running, which is exactly what we want, so no
        // detaching dance is needed (and macOS has no `setsid` binary to defer
        // to anyway). Two things do matter: never `waitUntilExit`, and give it
        // the null device rather than pipes, because no one will be alive to
        // drain them and the script would eventually block on a full buffer.
        // Its output goes to its own log instead.
        let launcher = Process()
        launcher.executableURL = script
        launcher.standardOutput = FileHandle.nullDevice
        launcher.standardError = FileHandle.nullDevice
        launcher.standardInput = FileHandle.nullDevice

        do {
            try launcher.run()
        } catch {
            // Never terminate on a failed spawn — that would take the app down
            // with nothing scheduled to bring it back.
            NSLog("Restart failed to start updater: \(error.localizedDescription)")
            let alert = NSAlert()
            alert.messageText = "Can't restart"
            alert.informativeText = "Could not start the updater: \(error.localizedDescription)"
            alert.alertStyle = .warning
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            return
        }

        NSApp.terminate(nil)
    }

    @objc func quitApp() {
        NSApp.terminate(nil)
    }

    // MARK: - Notifications

    // Show banners even while this app is frontmost.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    // Clicking a notification runs whatever action the event asked for —
    // authorizing a bag, or opening its session in the web UI.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo

        // Approve/Deny tapped straight from the banner. The agent is blocked
        // waiting on this, so it is answered here rather than only in the app.
        // A dismissal is deliberately NOT a decision: swiping a banner away
        // must not read as approval, and the request stays pending until it is
        // answered or its deadline passes.
        // The rule itself lives in ApprovalResponseRouter, which is pure and
        // tested; this only carries out the verdict.
        switch ApprovalResponseRouter.route(userInfo: info, actionIdentifier: response.actionIdentifier) {
        case .decide(let approvalId, let approved):
            Task { @MainActor in
                await self.approvalsState.decide(id: approvalId, approved: approved)
                completionHandler()
            }
            return
        case .open:
            Task { @MainActor in
                self.showPopover()
                completionHandler()
            }
            return
        case .ignore:
            break
        }

        if info["action"] as? String == "bag_auth", let bags = info["bags"] as? [String] {
            // Kicks off the OAuth flow server-side; mcp-remote opens the browser
            // tab. The endpoint is single-flight per bag, so a double-click on
            // the banner can't produce two tabs.
            Task { @MainActor in
                await self.eventsState.authorizeBags(bags)
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

// Strong global reference (NSApp.delegate is weak)
var appDelegateRef: AppDelegate!

registerBundledFonts()

// Top-level code is nonisolated, but everything below is main-actor work and
// this *is* the main thread — `assumeIsolated` states that rather than hopping
// through a Task, which would let `app.run()` start before setup finished.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)

    appDelegateRef = AppDelegate()
    appDelegateRef.setup()
    app.delegate = appDelegateRef

    app.run()
}
