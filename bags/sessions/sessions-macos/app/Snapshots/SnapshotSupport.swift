// Support layer for the snapshot harness: font registration, the render
// entry point, and the mock palette.
//
// Split out of main.swift, which had grown past the 1000-line hard limit in
// .swiftlint.yml. These three sections are the scaffolding every scenario
// leans on and none of them describe a scenario themselves, so they were the
// seam that leaves both halves coherent.

import SwiftUI
import AppKit
import Components

// MARK: - Font Registration

/// Register bundled Inter and JetBrains Mono for snapshot rendering.
func registerFonts() {
    let fontsDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // Snapshots/
        .appendingPathComponent("../Resources/Fonts")
        .standardized
    for name in ["InterVariable.ttf", "JetBrainsMono.ttf"] {
        let url = fontsDir.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { continue }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
}

// MARK: - Snapshot Harness

/// Renders SwiftUI views to PNG files for visual QA.
/// Run: swift run Snapshots [output-dir]
/// Opens the output directory in Finder when done.

/// Snapshots render dark by default (the reference design). Pass --light to
/// QA the adaptive light palette of the shared Components.
let renderLight = CommandLine.arguments.contains("--light")

@MainActor
func renderSnapshot<V: View>(
    _ name: String,
    width: CGFloat = 400,
    to directory: URL,
    @ViewBuilder content: () -> V
) {
    let panelBg = renderLight
        ? NSColor(red: 0.976, green: 0.976, blue: 0.980, alpha: 1)  // #f9f9fa
        : NSColor(red: 0.133, green: 0.133, blue: 0.149, alpha: 1)  // #222226
    let view = content()
        .frame(width: width)
        .padding(1) // avoid clipping
        .background(Color(nsColor: panelBg))
        .environment(\.colorScheme, renderLight ? .light : .dark)

    let renderer = ImageRenderer(content: view)
    renderer.scale = 2.0

    // Components colors are appearance-adaptive (NSColor dynamic providers), so
    // the drawing appearance must be pinned too — .colorScheme alone doesn't
    // affect NSColor resolution.
    var rendered: NSImage?
    NSAppearance(named: renderLight ? .aqua : .darkAqua)?.performAsCurrentDrawingAppearance {
        rendered = renderer.nsImage
    }
    guard let image = rendered else {
        print("  FAIL: \(name) — could not render")
        return
    }

    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        print("  FAIL: \(name) — could not encode PNG")
        return
    }

    let path = directory.appendingPathComponent("\(name).png")
    do {
        try png.write(to: path)
        print("  OK: \(name).png")
    } catch {
        print("  FAIL: \(name) — \(error)")
    }
}

// MARK: - Mock Colors (matching v13.html CSS vars)

enum MockColors {
    // Adaptive pairs mirroring the app palette (MessagesPanel.TurnColors /
    // ToolRenderers.DetailColors) so --light snapshots match the real app.
    static let panelBg = Color.adaptive(
        light: Color(red: 0.976, green: 0.976, blue: 0.980),           // #f9f9fa
        dark: Color(red: 0.133, green: 0.133, blue: 0.149)             // #222226
    )

    static let userBase = Color.adaptive(
        light: Color(red: 37/255, green: 99/255, blue: 235/255),       // #2563eb
        dark: Color(red: 96/255, green: 165/255, blue: 250/255)        // #60a5fa
    )
    static let userBg = userBase.opacity(0.055)
    static let userLine = userBase.opacity(0.16)
    static let userLabel = userBase.opacity(0.55)

    static let agentBase = Color.adaptive(
        light: Color(red: 217/255, green: 119/255, blue: 6/255),       // #d97706
        dark: Color(red: 251/255, green: 191/255, blue: 36/255)        // #fbbf24
    )
    static let agentBg = agentBase.opacity(0.04)
    static let agentLine = agentBase.opacity(0.1)
    static let agentLabel = agentBase.opacity(0.45)

    static let toolName = Color.adaptive(light: Color(white: 0.60), dark: Color(white: 0.33))
    static let toolSummary = Color.adaptive(
        light: Color(red: 0.72, green: 0.73, blue: 0.75),
        dark: Color(red: 0.22, green: 0.23, blue: 0.25)                // #383b40
    )
    static let toolLine = Color.primary.opacity(0.05)
    static let toolChevron = Color.adaptive(light: Color(white: 0.80), dark: Color(white: 0.2))

    static let detailLabel = toolName
    static let detailBg = Color.adaptive(light: Color.black.opacity(0.05), dark: Color.black.opacity(0.15))
    static let inputColor = Color.adaptive(
        light: Color(red: 0.40, green: 0.41, blue: 0.44),
        dark: Color(red: 0.60, green: 0.62, blue: 0.64)                // #9a9da3
    )
    static let resultColor = successGreen.opacity(0.7)

    static let lineNumber = Color.adaptive(
        light: Color(red: 0.78, green: 0.78, blue: 0.80),
        dark: Color(red: 0.23, green: 0.24, blue: 0.26)                // #3a3d42
    )
    static let codeText = Color.adaptive(
        light: Color(red: 0.26, green: 0.27, blue: 0.30),
        dark: Color(red: 0.69, green: 0.71, blue: 0.73)                // #b0b4ba
    )
    static let successGreen = Color.adaptive(
        light: Color(red: 0.09, green: 0.64, blue: 0.29),              // #16a34a
        dark: Color(red: 0.29, green: 0.87, blue: 0.50)                // #4ade80
    )
    static let errorRed = Color.adaptive(
        light: Color(red: 0.86, green: 0.15, blue: 0.15),              // #dc2626
        dark: Color(red: 0.97, green: 0.44, blue: 0.44)                // #f87171
    )
    static let blue = Color.adaptive(
        light: Color(red: 0.15, green: 0.39, blue: 0.92),              // #2563eb
        dark: Color(red: 0.38, green: 0.65, blue: 0.98)                // #60a5fa
    )
    static let purple = Color.adaptive(
        light: Color(red: 0.58, green: 0.20, blue: 0.92),              // #9333ea
        dark: Color(red: 0.75, green: 0.52, blue: 0.99)                // #c084fc
    )
    static let filePath = Color.adaptive(light: Color(white: 0.52), dark: Color(white: 0.40))
    static let dimText = Color.adaptive(light: Color(white: 0.72), dark: Color(white: 0.27))
}
