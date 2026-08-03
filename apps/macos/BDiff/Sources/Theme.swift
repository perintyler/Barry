import SwiftUI
import AppKit
import BDiffCore

/// Catppuccin dual-palette theme — Mocha (dark) and Latte (light).
///
/// Every color auto-adapts to the system appearance via NSColor's
/// light/dark color resolution. No environment threading needed.
///
/// Diff backgrounds use solid pre-blended colors (Catppuccin Delta style)
/// instead of alpha tints — predictable rendering regardless of layer stack.
enum Theme {

    // MARK: - Backgrounds

    /// Deepest layer — diff content area, file view background.
    static let mantle = adaptive(light: 0xE6E9EF, dark: 0x181825)

    /// Primary surface — sidebars, hunk headers, panels.
    static let base = adaptive(light: 0xEFF1F5, dark: 0x1E1E2E)

    /// Elevated surface — cards, popovers, selected rows.
    static let surface0 = adaptive(light: 0xCCD0DA, dark: 0x313244)

    /// Hover / active states on surface elements.
    static let surface1 = adaptive(light: 0xBCC0CC, dark: 0x45475A)

    /// Borders, subtle dividers.
    static let surface2 = adaptive(light: 0xACB0BE, dark: 0x585B70)

    // MARK: - Text

    /// Primary text.
    static let text = adaptive(light: 0x4C4F69, dark: 0xCDD6F4)

    /// Secondary text — labels, metadata.
    static let subtext1 = adaptive(light: 0x5C5F77, dark: 0xBAC2DE)

    /// De-emphasized — tertiary labels, inactive tabs.
    static let subtext0 = adaptive(light: 0x6C6F85, dark: 0xA6ADC8)

    /// Dim — line numbers, timestamps, quaternary content.
    static let overlay1 = adaptive(light: 0x7C7F93, dark: 0x7F849C)

    /// Dimmest — subtle hints, paging controls.
    static let overlay0 = adaptive(light: 0x8C8FA1, dark: 0x6C7086)

    // MARK: - Status / Semantic

    /// File added, insertion counts, "live" dots. Teal avoids syntax-green collisions.
    static let added = adaptive(light: 0x179299, dark: 0x94E2D5)

    /// File deleted, deletion counts, error indicators.
    static let deleted = adaptive(light: 0xD20F39, dark: 0xF38BA8)

    /// File modified.
    static let modified = adaptive(light: 0x1E66F5, dark: 0x89B4FA)

    /// File renamed.
    static let renamed = adaptive(light: 0xDF8E1D, dark: 0xF9E2AF)

    /// Accent — peach.
    static let peach = adaptive(light: 0xFE640B, dark: 0xFAB387)

    /// Live indicator, positive state. Green (used sparingly, not for diff lines).
    static let green = adaptive(light: 0x40A02B, dark: 0xA6E3A1)

    /// Agent branch indicator.
    static let mauve = adaptive(light: 0x8839EF, dark: 0xCBA6F7)

    /// Worktree indicator.
    static let orange = adaptive(light: 0xFE640B, dark: 0xFAB387)

    /// Idle / inactive state.
    static let gray = adaptive(light: 0xACB0BE, dark: 0x585B70)

    /// Error icon.
    static let warning = adaptive(light: 0xFE640B, dark: 0xFAB387)

    /// Selection / active accent — blue.
    static let accent = adaptive(light: 0x1E66F5, dark: 0x89B4FA)

    // MARK: - Diff Backgrounds (solid, pre-blended)
    //
    // Mocha values from Catppuccin Delta. Latte values: status color blended
    // into latte mantle at 18% (line) / 40% (word) for teal, 15%/35% for red.

    /// Addition line background — muted teal-gray.
    static let addedLineBg = adaptive(light: 0xC1D9E0, dark: 0x394545)

    /// Deletion line background — muted plum / rose.
    static let deletedLineBg = adaptive(light: 0xE3C8D4, dark: 0x493447)

    /// Word-level addition highlight — emphasized teal.
    static let addedWordBg = adaptive(light: 0x93C6CD, dark: 0x4E6356)

    /// Word-level deletion highlight — emphasized plum.
    static let deletedWordBg = adaptive(light: 0xDF9DAF, dark: 0x694559)

    /// Hunk header background — solid surface.
    static let hunkHeaderBg = surface0

    /// Status badge background opacity.
    static let statusBadgeBgOpacity: Double = 0.12

    /// Selection highlight background.
    static let selectionBg = adaptive(
        light: NSColor(Color(hex: 0x1E66F5).opacity(0.12)),
        dark: NSColor(Color(hex: 0x89B4FA).opacity(0.12))
    )

    // MARK: - Status color lookup

    static func statusColor(_ status: FileStatus) -> Color {
        switch status {
        case .added: return added
        case .deleted: return deleted
        case .modified: return modified
        case .renamed: return renamed
        }
    }

    static func markerColor(_ type: LineType) -> Color {
        switch type {
        case .context: return subtext1
        case .addition: return added
        case .deletion: return deleted
        }
    }

    static func lineBackground(_ type: LineType) -> Color {
        switch type {
        case .context: return .clear
        case .addition: return addedLineBg
        case .deletion: return deletedLineBg
        }
    }

    static func wordHighlight(_ type: LineType) -> Color {
        type == .addition ? addedWordBg : deletedWordBg
    }

    // MARK: - Gutter Stripe

    /// Gutter stripe color for diff lines. Returns nil for context lines.
    static func gutterStripeColor(_ type: LineType) -> Color? {
        switch type {
        case .context: return nil
        case .addition: return added
        case .deletion: return deleted
        }
    }

    // MARK: - Line Number Tinting

    /// Line number foreground — tinted on changed lines for subtle reinforcement.
    static func lineNumberColor(_ type: LineType) -> Color {
        switch type {
        case .context: return surface2
        case .addition: return adaptive(light: 0x7DA389, dark: 0x6B8A83)
        case .deletion: return adaptive(light: 0xB07D8A, dark: 0x8A6B77)
        }
    }

    // MARK: - Adaptive Color Construction

    /// Create a color that resolves to different values in light and dark mode.
    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let hex = isDark ? dark : light
            let r = CGFloat((hex >> 16) & 0xFF) / 255
            let g = CGFloat((hex >> 8) & 0xFF) / 255
            let b = CGFloat(hex & 0xFF) / 255
            return NSColor(red: r, green: g, blue: b, alpha: 1)
        })
    }

    /// Create an adaptive color from pre-built NSColors (for computed colors like opacity).
    private static func adaptive(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return isDark ? dark : light
        })
    }
}

// MARK: - Hex Color Init

extension Color {
    init(hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}
