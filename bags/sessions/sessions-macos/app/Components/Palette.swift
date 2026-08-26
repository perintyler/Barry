import SwiftUI

/// Shared palette. Light values use the Tailwind 600 tier, dark the 400 tier.
///
/// This started life in the events app and was duplicated by value — the same
/// hex constants appear in the sessions snapshot harness — so it lives here
/// now, in the one target every feature can import. Semantic meaning (which
/// severity is red, which phase is blue) deliberately stays with the feature
/// that owns the concept; this type only names colors.
public enum Palette {
    public static let green = Color.adaptive(
        light: Color(red: 0.09, green: 0.64, blue: 0.29),   // #16a34a
        dark: Color(red: 0.29, green: 0.87, blue: 0.50)     // #4ade80
    )
    public static let red = Color.adaptive(
        light: Color(red: 0.86, green: 0.15, blue: 0.15),   // #dc2626
        dark: Color(red: 0.97, green: 0.44, blue: 0.44)     // #f87171
    )
    public static let blue = Color.adaptive(
        light: Color(red: 0.15, green: 0.39, blue: 0.92),   // #2563eb
        dark: Color(red: 0.38, green: 0.65, blue: 0.98)     // #60a5fa
    )
    public static let amber = Color.adaptive(
        light: Color(red: 0.71, green: 0.33, blue: 0.04),   // #b45309
        dark: Color(red: 0.98, green: 0.75, blue: 0.14)     // #fbbf24
    )
    public static let purple = Color.adaptive(
        light: Color(red: 0.58, green: 0.20, blue: 0.92),   // #9333ea
        dark: Color(red: 0.75, green: 0.52, blue: 0.99)     // #c084fc
    )

    public static let windowBackground = Color.adaptive(
        light: Color(red: 0.976, green: 0.976, blue: 0.980), // #f9f9fa
        dark: Color(red: 0.133, green: 0.133, blue: 0.149)   // #222226
    )
    /// Wash behind an expanded row, so it reads as one bag.
    public static let expandedBackground = Color.adaptive(
        light: Color.black.opacity(0.03),
        dark: Color.white.opacity(0.04)
    )
    public static let hover = Color.adaptive(
        light: Color.black.opacity(0.04),
        dark: Color.white.opacity(0.05)
    )
    public static let separator = Color.adaptive(
        light: Color.black.opacity(0.07),
        dark: Color.white.opacity(0.07)
    )
}
