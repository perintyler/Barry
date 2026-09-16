import AppKit
import BarrySessionsCore

/// Launches a sibling Barry app.
///
/// Identity management used to open a window inside this process. It is its
/// own app now — and Actions is a second one — so this only has to find and
/// start them.
///
/// Keeping them out of process is what lets the menu bar stay at one icon
/// while each still gets a real window: this app is `.accessory` and cannot
/// host a properly focusable window without flipping its own activation
/// policy, which would put a Dock icon on the *sessions* app every time
/// someone edited an identity or read a run.
@MainActor
enum BarryAppLauncher {
    /// Bring `app` up, or forward to it if it is already running.
    ///
    /// - Parameter closePopover: run first. The popover is `.transient` and
    ///   closes as soon as another app activates; doing it deliberately keeps
    ///   that from racing the launch and firing `popoverDidClose` midway.
    static func open(_ app: BarryAppLocation, closePopover: () -> Void) {
        closePopover()

        // Already running: activating the existing instance beats launching a
        // second copy, which macOS would refuse anyway but only after a delay.
        if let running = NSRunningApplication
            .runningApplications(withBundleIdentifier: app.bundleIdentifier)
            .first {
            running.activate(options: [.activateAllWindows])
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true

        // Shared with the app rail, which draws this same bundle's icon: see
        // BarryAppBundle for why the resolution lives in one place.
        guard let url = BarryAppBundle.url(for: app) else {
            NSLog("\(app.bundleName) is not installed (looked for \(BarryAppBundle.expectedPath(for: app)))")
            return
        }

        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            if let error {
                NSLog("Could not open \(app.bundleName): \(error.localizedDescription)")
            }
        }
    }
}
