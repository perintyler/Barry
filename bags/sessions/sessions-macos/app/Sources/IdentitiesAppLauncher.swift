import AppKit
import BarrySessionsCore

/// Launches the standalone Barry Identities app.
///
/// Identity management used to open a window inside this process. It is its
/// own app now — `com.barry.identities`, a regular windowed app with a Dock
/// icon while it runs — so this only has to find and start it.
///
/// Keeping it out of process is what lets the menu bar stay at one icon while
/// identities still gets a real window: this app is `.accessory` and cannot
/// host a properly focusable window without flipping its own activation
/// policy, which would put a Dock icon on the *sessions* app every time
/// someone edited an identity.
@MainActor
enum IdentitiesAppLauncher {
    static let bundleIdentifier = IdentitiesAppLocation.bundleIdentifier

    /// Where the installed bundle lives, matching `scripts/launchd/setup`.
    private static var installedBundle: URL {
        IdentitiesAppLocation.installedBundle(
            home: FileManager.default.homeDirectoryForCurrentUser
        )
    }

    /// Bring the app up, or forward to it if it is already running.
    ///
    /// - Parameter closePopover: run first. The popover is `.transient` and
    ///   closes as soon as another app activates; doing it deliberately keeps
    ///   that from racing the launch and firing `popoverDidClose` midway.
    static func open(closePopover: () -> Void) {
        closePopover()

        // Already running: activating the existing instance beats launching a
        // second copy, which macOS would refuse anyway but only after a delay.
        if let running = NSRunningApplication
            .runningApplications(withBundleIdentifier: bundleIdentifier)
            .first {
            running.activate(options: [.activateAllWindows])
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true

        // Prefer the installed bundle. Falling back to a bundle-id lookup
        // covers a machine where it was installed somewhere else, and failing
        // that there is nothing useful to do but log — a silent no-op would
        // read as the button being broken.
        let url = IdentitiesAppLocation.resolve(
            installed: FileManager.default.fileExists(atPath: installedBundle.path) ? installedBundle : nil,
            registered: NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier)
        )

        guard let url else {
            NSLog("Barry Identities is not installed (looked for \(installedBundle.path))")
            return
        }

        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            if let error {
                NSLog("Could not open Barry Identities: \(error.localizedDescription)")
            }
        }
    }
}
