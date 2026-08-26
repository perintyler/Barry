import Foundation
import UserNotifications

/// What a notification response should cause.
///
/// Split out from the delegate so the rule can be tested without AppKit, a
/// running app, or a real notification — none of which a test can produce.
public enum ApprovalResponseAction: Equatable {
    /// A button was tapped: record this verdict.
    case decide(id: String, approved: Bool)
    /// The body was tapped: show the request rather than deciding it blind.
    case open
    /// Not an approval notification, or missing its id — leave it alone.
    case ignore
}

public enum ApprovalResponseRouter {
    /// Decide what a response means.
    ///
    /// - Parameters:
    ///   - userInfo: the notification's payload
    ///   - actionIdentifier: which button, or a system identifier for a plain
    ///     tap or a dismissal
    ///
    /// Two rules carry real weight:
    ///
    /// **Dismissal is not a decision.** `UNNotificationDismissActionIdentifier`
    /// routes to `.ignore`, so swiping a banner away leaves the request pending
    /// until it is answered or expires. Treating it as a denial would make a
    /// cleared notification shade silently refuse work nobody looked at.
    ///
    /// **A body tap opens rather than decides.** The banner shows one line; a
    /// destructive merge deserves the full context before a verdict.
    public static func route(
        userInfo: [AnyHashable: Any],
        actionIdentifier: String
    ) -> ApprovalResponseAction {
        guard userInfo["action"] as? String == "approval",
              let id = userInfo["approvalId"] as? String,
              !id.isEmpty
        else { return .ignore }

        switch actionIdentifier {
        case ApprovalNotification.approveAction:
            return .decide(id: id, approved: true)
        case ApprovalNotification.denyAction:
            return .decide(id: id, approved: false)
        case UNNotificationDismissActionIdentifier:
            return .ignore
        default:
            return .open
        }
    }
}
