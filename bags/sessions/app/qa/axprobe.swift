// Small AX probe: walks the BarrySessions accessibility tree via the AXUIElement
// C API (the AppleScript `entire contents` bridge doesn't recurse reliably into
// NSHostingView-backed SwiftUI trees). Used by scroll-qa.sh.
//
// Commands:
//   swift axprobe.swift frame <id>        → "<id> frame=x,y,w,h" (exit 0) | NOT_FOUND (1)
//   swift axprobe.swift rows              → the AXIdentifiers of visible message
//                                           rows (turn-N/tool-N), space-separated
//   swift axprobe.swift topmost          → the first visible row identifier
import AppKit
import ApplicationServices

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: axprobe.swift <frame|rows|topmost> [id]\n".data(using: .utf8)!)
    exit(2)
}
let command = CommandLine.arguments[1]
let wanted = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : ""

guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.barry.sessions").first
        ?? NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == "BarrySessions" }) else {
    print("APP_NOT_RUNNING"); exit(1)
}

let axApp = AXUIElementCreateApplication(app.processIdentifier)

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    guard let raw = attr(el, kAXChildrenAttribute as String) else { return [] }
    return (raw as? [AXUIElement]) ?? []
}

func identifier(_ el: AXUIElement) -> String? {
    attr(el, kAXIdentifierAttribute as String) as? String
}

func frame(_ el: AXUIElement) -> CGRect? {
    guard let posV = attr(el, kAXPositionAttribute as String),
          let sizeV = attr(el, kAXSizeAttribute as String) else { return nil }
    var pos = CGPoint.zero, size = CGSize.zero
    AXValueGetValue(posV as! AXValue, .cgPoint, &pos)
    AXValueGetValue(sizeV as! AXValue, .cgSize, &size)
    return CGRect(origin: pos, size: size)
}

func find(_ el: AXUIElement, id: String, depth: Int = 0) -> AXUIElement? {
    if depth > 40 { return nil }
    if identifier(el) == id { return el }
    for child in children(el) {
        if let hit = find(child, id: id, depth: depth + 1) { return hit }
    }
    return nil
}

/// Collect all elements whose identifier matches a `turn-`/`tool-` message row,
/// in document order (top → bottom).
func collectRows(_ el: AXUIElement, into acc: inout [(String, CGFloat)], depth: Int = 0) {
    if depth > 40 { return }
    if let id = identifier(el), id.hasPrefix("turn-") || id.hasPrefix("tool-") {
        let y = frame(el)?.origin.y ?? 0
        acc.append((id, y))
    }
    for child in children(el) { collectRows(child, into: &acc, depth: depth + 1) }
}

switch command {
case "frame":
    if let hit = find(axApp, id: wanted), let f = frame(hit) {
        print("\(wanted) frame=\(Int(f.origin.x)),\(Int(f.origin.y)),\(Int(f.width)),\(Int(f.height))")
        exit(0)
    }
    print("NOT_FOUND"); exit(1)

case "rows", "topmost":
    var rows: [(String, CGFloat)] = []
    collectRows(axApp, into: &rows)
    rows.sort { $0.1 < $1.1 } // top → bottom by y
    // AX exposes nested text sub-elements all carrying the row's identifier;
    // dedup to one entry per distinct row, preserving top→bottom order.
    var seen = Set<String>()
    let ordered = rows.map(\.0).filter { seen.insert($0).inserted }
    if ordered.isEmpty { print("NO_ROWS"); exit(1) }
    if command == "topmost" {
        print(ordered.first!)
    } else {
        print(ordered.joined(separator: " "))
    }
    exit(0)

case "scroll":
    // Scroll by setting the vertical scroll bar's AX value in [0,1] (0 = top,
    // 1 = bottom). This is a TARGETED AX write to this app's own element — NOT a
    // synthetic HID/scroll-wheel event, so it can't leak to whatever app happens
    // to be frontmost. `wanted` is the target position, e.g. "0" scrolls to top.
    guard let sv = find(axApp, id: "MessageScrollView") else { print("NO_SCROLLVIEW"); exit(1) }
    guard let barRef = attr(sv, "AXVerticalScrollBar") else { print("NO_SCROLLBAR"); exit(1) }
    let bar = barRef as! AXUIElement
    let target = Double(wanted) ?? 0.0
    let result = AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, target as CFNumber)
    if result == .success {
        print("SCROLLED to \(target)")
        exit(0)
    }
    print("SCROLL_FAILED \(result.rawValue)")
    exit(1)

default:
    FileHandle.standardError.write("unknown command: \(command)\n".data(using: .utf8)!)
    exit(2)
}
