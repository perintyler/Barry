import AppKit
import SwiftUI

public extension Color {
    /// A color that resolves per-appearance at draw time, so hard-coded palettes
    /// can follow the system light/dark mode like semantic colors do.
    static func adaptive(light: Color, dark: Color) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(isDark ? dark : light)
        })
    }
}
