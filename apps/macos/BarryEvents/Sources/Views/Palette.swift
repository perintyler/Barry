import SwiftUI
import AppKit

extension Color {
    /// A color that resolves per-appearance at draw time, so hard-coded palettes
    /// follow light/dark mode the way semantic colors do.
    static func adaptive(light: Color, dark: Color) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(isDark ? dark : light)
        })
    }
}

/// Shared palette. Light values use the Tailwind 600 tier, dark the 400 tier —
/// the same convention as the other Barry macOS apps.
enum Palette {
    static let green = Color.adaptive(
        light: Color(red: 0.09, green: 0.64, blue: 0.29),   // #16a34a
        dark: Color(red: 0.29, green: 0.87, blue: 0.50)     // #4ade80
    )
    static let red = Color.adaptive(
        light: Color(red: 0.86, green: 0.15, blue: 0.15),   // #dc2626
        dark: Color(red: 0.97, green: 0.44, blue: 0.44)     // #f87171
    )
    static let blue = Color.adaptive(
        light: Color(red: 0.15, green: 0.39, blue: 0.92),   // #2563eb
        dark: Color(red: 0.38, green: 0.65, blue: 0.98)     // #60a5fa
    )
    static let amber = Color.adaptive(
        light: Color(red: 0.71, green: 0.33, blue: 0.04),   // #b45309
        dark: Color(red: 0.98, green: 0.75, blue: 0.14)     // #fbbf24
    )
    static let purple = Color.adaptive(
        light: Color(red: 0.58, green: 0.20, blue: 0.92),   // #9333ea
        dark: Color(red: 0.75, green: 0.52, blue: 0.99)     // #c084fc
    )

    static let windowBackground = Color.adaptive(
        light: Color(red: 0.976, green: 0.976, blue: 0.980), // #f9f9fa
        dark: Color(red: 0.133, green: 0.133, blue: 0.149)   // #222226
    )
    /// Wash behind an expanded row, so it reads as one block.
    static let expandedBackground = Color.adaptive(
        light: Color.black.opacity(0.03),
        dark: Color.white.opacity(0.04)
    )
    static let hover = Color.adaptive(
        light: Color.black.opacity(0.04),
        dark: Color.white.opacity(0.05)
    )
    static let separator = Color.adaptive(
        light: Color.black.opacity(0.07),
        dark: Color.white.opacity(0.07)
    )
}

extension Severity {
    var color: Color {
        switch self {
        case .success: return Palette.green
        case .error: return Palette.red
        case .warn: return Palette.amber
        case .info: return Palette.blue
        }
    }
}

extension EventType {
    /// Tint for the type badge — deliberately distinct from severity, which
    /// owns the dot, so the two signals don't collapse into one.
    var tint: Color {
        switch self {
        case .progress: return Palette.blue
        case .taskFinished: return Palette.green
        case .systemAlert: return Palette.amber
        case .notification, .other: return .secondary
        }
    }

    var symbol: String {
        switch self {
        case .progress: return "circle.dashed"
        case .notification: return "bell"
        case .taskFinished: return "checkmark.circle"
        case .systemAlert: return "exclamationmark.triangle"
        case .other: return "circle"
        }
    }
}

/// Colors for the agent phase carried on progress events.
func phaseColor(_ phase: String) -> Color {
    switch phase {
    case "complete": return Palette.green
    case "blocked": return Palette.red
    case "building", "reviewing", "planning": return Palette.blue
    default: return .secondary
    }
}
