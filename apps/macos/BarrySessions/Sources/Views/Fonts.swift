import SwiftUI
import AppKit

/// Register bundled Inter and JetBrains Mono fonts from Resources/Fonts.
/// Call once at app startup before any views render.
func registerBundledFonts() {
    let fontNames = ["InterVariable.ttf", "JetBrainsMono.ttf"]

    let execURL = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
    let candidates = [
        execURL.deletingLastPathComponent().appendingPathComponent("Resources/Fonts"),
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Resources/Fonts")
    ]

    guard let fontsDir = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
        return
    }

    for name in fontNames {
        let url = fontsDir.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { continue }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
}

/// App typography — Inter for UI text, JetBrains Mono for code.
/// Font objects are cached to avoid repeated NSFont lookups on every render.
enum AppFont {
    // Cache keyed by (size, weight, isMono)
    private static var cache: [CacheKey: Font] = [:]

    private struct CacheKey: Hashable {
        let size: CGFloat
        let weight: Font.Weight
        let isMono: Bool
    }

    static func sans(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let key = CacheKey(size: size, weight: weight, isMono: false)
        if let cached = cache[key] { return cached }
        let font = buildFont(size: size, weight: weight, names: ["Inter", "InterVariable"], fallback: .system(size: size, weight: weight))
        cache[key] = font
        return font
    }

    static func mono(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let key = CacheKey(size: size, weight: weight, isMono: true)
        if let cached = cache[key] { return cached }
        let font = buildFont(size: size, weight: weight, names: ["JetBrains Mono", "JetBrainsMono"], fallback: .system(size: size, weight: weight, design: .monospaced))
        cache[key] = font
        return font
    }

    private static func buildFont(size: CGFloat, weight: Font.Weight, names: [String], fallback: Font) -> Font {
        let nsWeight = nsFontWeight(weight)
        for name in names {
            if let nsFont = NSFont(name: name, size: size) {
                let descriptor = nsFont.fontDescriptor.addingAttributes([
                    .traits: [NSFontDescriptor.TraitKey.weight: nsWeight]
                ])
                if let weighted = NSFont(descriptor: descriptor, size: size) {
                    return Font(weighted)
                }
                return Font(nsFont)
            }
        }
        return fallback
    }

    private static func nsFontWeight(_ weight: Font.Weight) -> NSFont.Weight {
        switch weight {
        case .ultraLight: return .ultraLight
        case .thin: return .thin
        case .light: return .light
        case .regular: return .regular
        case .medium: return .medium
        case .semibold: return .semibold
        case .bold: return .bold
        case .heavy: return .heavy
        case .black: return .black
        default: return .regular
        }
    }
}
