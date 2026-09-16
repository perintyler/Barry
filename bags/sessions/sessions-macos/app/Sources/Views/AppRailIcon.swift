import AppKit
import BarrySessionsCore
import SwiftUI

/// A rail entry with its art resolved.
///
/// A value rather than something computed in `body`: resolving touches the
/// filesystem, and SwiftUI re-evaluates a rail body on every hover.
struct AppRailIcon: Identifiable {
    let entry: AppRailEntry
    /// The drawn artwork. Nil only when the icon asset is missing from the
    /// bundle, which leaves the SF Symbol fallback to carry the slot.
    let art: NSImage?
    /// False only for an app whose bundle could not be found on disk.
    let isReachable: Bool

    var id: String { entry.id }

    /// Where the bundle was looked for, so a missing app can say how to fix it.
    let expectedPath: String?
}

@MainActor
enum AppRailIconResolver {
    static func resolveAll(_ entries: [AppRailEntry] = AppRailEntry.all) -> [AppRailIcon] {
        entries.map(resolve)
    }

    /// Resolve one entry.
    ///
    /// Order matters: reachability is decided from `BarryAppBundle.url(for:)`
    /// *before* any artwork is loaded, and the artwork is the same either way.
    /// The icons are drawn, not read off disk, so they cannot report whether an
    /// app exists — which is exactly why that question is answered separately
    /// rather than inferred from whether an image appeared.
    static func resolve(_ entry: AppRailEntry) -> AppRailIcon {
        let art = templateImage(named: entry.id)

        guard let location = entry.appLocation else {
            // A web destination: nothing on disk, so nothing to find missing.
            return AppRailIcon(
                entry: entry,
                art: art,
                isReachable: true,
                expectedPath: nil
            )
        }

        let url = BarryAppBundle.url(for: location)
        return AppRailIcon(
            entry: entry,
            art: art,
            isReachable: url != nil,
            expectedPath: url?.path ?? BarryAppBundle.expectedPath(for: location)
        )
    }

    /// Load a rail icon from the bundle as a template image.
    ///
    /// Template rendering is what lets one black asset serve light mode, dark
    /// mode, hover and the dimmed missing state: AppKit tints the alpha channel
    /// with the current foreground color instead of drawing the pixels as-is.
    ///
    /// The assets are generated from `Resources/RailIcons/*.svg` — see that
    /// directory's README for the regeneration step. Nil here means the asset
    /// did not ship, which the rail shows as the SF Symbol fallback rather than
    /// an empty button.
    private static func templateImage(named name: String) -> NSImage? {
        guard let url = Bundle.main.url(
            forResource: name,
            withExtension: "png",
            subdirectory: "RailIcons"
        ), let image = NSImage(contentsOf: url) else {
            NSLog("Rail icon asset missing from bundle: \(name).png")
            return nil
        }
        image.isTemplate = true
        return image
    }

    /// Say what is wrong, where it was looked for, and how to fix it.
    ///
    /// Follows the missing-self-update-script alert in `main.swift` rather than
    /// inventing a second way to report a missing file. The launcher only
    /// `NSLog`s, which from the user's side is a button that does nothing.
    static func reportMissing(_ icon: AppRailIcon) {
        let alert = NSAlert()
        alert.messageText = "\(icon.entry.title) isn't installed"
        alert.informativeText = """
            Barry Sessions looked for \(icon.expectedPath ?? "the app bundle") \
            and asked Launch Services for it.

            Run scripts/launchd/setup to install it.
            """
        alert.alertStyle = .warning
        alert.runModal()
    }
}
