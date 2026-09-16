import Foundation

/// Parse an ISO 8601 date string and return a relative time description.
func formatRelativeTime(_ iso: String) -> String? {
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = fmt.date(from: iso)
    if date == nil {
        fmt.formatOptions = [.withInternetDateTime]
        date = fmt.date(from: iso)
    }
    guard let d = date else { return nil }

    let rf = RelativeDateTimeFormatter()
    rf.unitsStyle = .abbreviated
    return rf.localizedString(for: d, relativeTo: Date())
}

/// Format an ISO date string for display (medium date, short time).
func formatAbsoluteTime(_ iso: String) -> String? {
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var date = fmt.date(from: iso)
    if date == nil {
        fmt.formatOptions = [.withInternetDateTime]
        date = fmt.date(from: iso)
    }
    guard let d = date else { return nil }
    let df = DateFormatter()
    df.dateStyle = .medium
    df.timeStyle = .short
    return df.string(from: d)
}
