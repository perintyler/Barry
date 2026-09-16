import SwiftUI
import AppKit

/// App typography — Inter for UI text, JetBrains Mono for code.
///
/// This lives in `Components`, not the executable target, so that the markdown
/// theme and the surrounding chrome resolve fonts through **one** definition.
/// It previously lived in the app target, which `Components` cannot import, so
/// the families were re-declared there as string literals — and drifted to
/// `"Inter"`, a name CoreText does not resolve. Every message silently fell back
/// to the system font, taking bold synthesis with it. Family names now come from
/// `MarkdownTokens.Family` and nowhere else.
///
/// Font objects are cached: `NSFont(name:size:)` plus descriptor work is not
/// free, and the transcript re-evaluates constantly while scrolling.
public enum AppFont {
    private struct CacheKey: Hashable {
        let size: CGFloat
        let weight: Font.Weight
        let isMono: Bool
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [CacheKey: Font] = [:]
    nonisolated(unsafe) private static var lineHeightCache: [CacheKey: CGFloat] = [:]

    public static func sans(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        font(size: size, weight: weight, isMono: false)
    }

    public static func mono(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        font(size: size, weight: weight, isMono: true)
    }

    /// Line height for `sans(size:weight:)`, including line spacing.
    ///
    /// A view that needs this used to measure it by laying out a hidden
    /// `Text(" ")` behind a `GeometryReader` and reading the height back
    /// through a preference. That measures the same constant once per view, and
    /// preference writes propagate bottom-up through the whole layout tree — so
    /// in a long eagerly-laid-out list the cost is paid per row, per pass, for
    /// an answer the font already knows. Ask the font instead, and cache it
    /// like the fonts themselves.
    public static func sansLineHeight(size: CGFloat, weight: Font.Weight = .regular) -> CGFloat {
        let key = CacheKey(size: size, weight: weight, isMono: false)
        lock.lock()
        if let cached = lineHeightCache[key] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let name = postScriptName(family: MarkdownTokens.Family.sans, weight: weight, isMono: false)
        let nsFont = NSFont(name: name, size: size)
            ?? NSFont(name: MarkdownTokens.Family.sans, size: size)
            ?? NSFont.systemFont(ofSize: size, weight: nsWeight(weight))
        // Matches what SwiftUI lays out for a single line of this font.
        let height = ceil(nsFont.ascender - nsFont.descender + nsFont.leading)

        lock.lock()
        lineHeightCache[key] = height
        lock.unlock()
        return height
    }

    private static func font(size: CGFloat, weight: Font.Weight, isMono: Bool) -> Font {
        let key = CacheKey(size: size, weight: weight, isMono: isMono)
        lock.lock()
        if let cached = cache[key] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let built = build(size: size, weight: weight, isMono: isMono)
        lock.lock()
        cache[key] = built
        lock.unlock()
        return built
    }

    private static func build(size: CGFloat, weight: Font.Weight, isMono: Bool) -> Font {
        let family = isMono ? MarkdownTokens.Family.mono : MarkdownTokens.Family.sans
        let fallback: Font = isMono
            ? .system(size: size, weight: weight, design: .monospaced)
            : .system(size: size, weight: weight)

        // Resolve the *named* instance for the weight first.
        //
        // These are variable fonts, and asking for a weight by descriptor trait
        // — `fontDescriptor.addingAttributes([.traits: [.weight: …]])` — is
        // silently ignored: every weight comes back with the same font name and
        // measurably identical glyph widths. The named PostScript instance
        // (`InterVariable-Bold`, `JetBrainsMono-Regular_Bold`) is what actually
        // moves the variation axis.
        if let named = NSFont(name: postScriptName(family: family, weight: weight, isMono: isMono), size: size) {
            return Font(named)
        }
        if let base = NSFont(name: family, size: size) {
            return Font(base)
        }
        return fallback
    }

    /// PostScript names of the bundled weight instances, as CoreText reports
    /// them. JetBrains Mono's faces are all prefixed `JetBrainsMono-Regular`
    /// with the weight appended after an underscore, which is unusual enough to
    /// be worth spelling out rather than deriving.
    private static func postScriptName(family: String, weight: Font.Weight, isMono: Bool) -> String {
        if isMono {
            switch weight {
            case .thin: return "JetBrainsMono-Regular_Thin"
            case .ultraLight, .light: return "JetBrainsMono-Regular_Light"
            case .medium: return "JetBrainsMono-Regular_Medium"
            case .semibold: return "JetBrainsMono-Regular_SemiBold"
            case .bold: return "JetBrainsMono-Regular_Bold"
            case .heavy, .black: return "JetBrainsMono-Regular_ExtraBold"
            default: return "JetBrainsMono-Regular"
            }
        }
        switch weight {
        case .ultraLight: return "InterVariable-ExtraLight"
        case .thin: return "InterVariable-Thin"
        case .light: return "InterVariable-Light"
        case .medium: return "InterVariable-Medium"
        case .semibold: return "InterVariable-SemiBold"
        case .bold: return "InterVariable-Bold"
        case .heavy: return "InterVariable-ExtraBold"
        case .black: return "InterVariable-Black"
        default: return "InterVariable"
        }
    }

    private static func nsWeight(_ weight: Font.Weight) -> NSFont.Weight {
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

/// Register the bundled Inter and JetBrains Mono faces.
///
/// Call once at startup, before any view renders. Looks beside the executable
/// first (the assembled `.app` bundle), then falls back to the source tree so
/// the snapshot harness and tests work without a bundle.
public func registerBundledFonts() {
    let execURL = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
    let candidates = [
        execURL.deletingLastPathComponent().appendingPathComponent("Resources/Fonts"),
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Components/
            .deletingLastPathComponent()   // app/
            .appendingPathComponent("Resources/Fonts")
    ]

    guard let dir = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
        return
    }

    for name in ["InterVariable.ttf", "JetBrainsMono.ttf"] {
        let url = dir.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { continue }
        // Re-registering an already-registered face is a harmless no-op error.
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
}
