import CoreGraphics

/// Where the floating rail sits relative to the popover.
///
/// Pure and separate from the panel because this is the part that can be wrong
/// without looking wrong: a rail positioned past the edge of the display is a
/// column of buttons nobody can reach, and nothing on screen says so.
public enum AppRailPlacement {
    /// Gap between the popover's edge and the rail.
    public static let gap: CGFloat = 8
    public static let width: CGFloat = 56
    /// One icon button, and the gap below it. Mirrors `AppRail`'s layout.
    public static let buttonPitch: CGFloat = 50
    public static let verticalPadding: CGFloat = 8

    /// What the rail measures when SwiftUI has not laid it out yet.
    ///
    /// Only a fallback: a panel sized from a zero measurement is on screen,
    /// present, and invisible, which looks identical to the rail being broken.
    public static func height(forEntries count: Int) -> CGFloat {
        CGFloat(max(count, 1)) * buttonPitch - (buttonPitch - 44) + verticalPadding * 2
    }

    /// Vertically centered on the popover, just outside its right edge.
    ///
    /// When there is no room on the right — a status item near the edge of the
    /// display — the rail tucks inside the popover's edge instead of hanging
    /// off the screen. A `nil` screen means there is nothing to clamp against,
    /// which is not a reason to move it.
    public static func frame(
        beside anchor: CGRect,
        width: CGFloat = width,
        height: CGFloat,
        screen: CGRect?
    ) -> CGRect {
        var x = anchor.maxX + gap
        let y = anchor.midY - height / 2

        if let screen, x + width > screen.maxX {
            x = anchor.maxX - width - gap
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }
}
