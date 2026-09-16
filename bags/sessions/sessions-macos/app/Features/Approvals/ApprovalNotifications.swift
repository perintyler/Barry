import Foundation
import UserNotifications

/// Notification identifiers for approval requests.
///
/// These strings are a contract between `setNotificationCategories` and the
/// `didReceive response:` handler in main.swift. A typo in one silently
/// produces a banner with no buttons, or a tap that does nothing — so they live
/// here rather than being written out at each site.
public enum ApprovalNotification {
    public static let category = "barry.approval"
    public static let approveAction = "barry.approval.approve"
    public static let denyAction = "barry.approval.deny"

    /// The category must be registered before any approval banner is posted,
    /// otherwise macOS shows it with no buttons and the user's only route is
    /// opening the app.
    public static func makeCategory() -> UNNotificationCategory {
        let approve = UNNotificationAction(
            identifier: approveAction,
            title: "Approve",
            options: []
        )
        // `.destructive` renders it distinctly, which matters because these two
        // buttons sit side by side and one of them cannot be taken back.
        let deny = UNNotificationAction(
            identifier: denyAction,
            title: "Deny",
            options: [.destructive]
        )
        return UNNotificationCategory(
            identifier: category,
            actions: [approve, deny],
            intentIdentifiers: [],
            options: []
        )
    }

    public static func content(for approval: Approval) -> UNMutableNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "Approval needed"
        content.subtitle = approval.requester
        content.body = approval.subject
        content.sound = .default
        content.categoryIdentifier = category
        content.userInfo = ["action": "approval", "approvalId": approval.id]
        return content
    }

    /// Post the banner, reporting whether the system actually accepted it.
    ///
    /// `add` succeeds silently when notifications are denied, so a caller that
    /// ignores this can believe it asked the user something nobody will ever
    /// see. An approval blocks an agent, so undelivered has to be visible --
    /// the whole point of the primitive is that a broken delivery path cannot
    /// masquerade as "no answer yet".
    public static func submit(_ approval: Approval, onFailure: ((String) -> Void)? = nil) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized
                    || settings.authorizationStatus == .provisional else {
                onFailure?("Notifications are not permitted for Barry, so approval banners will not appear. Approve or deny in this tab, or allow notifications in System Settings.")
                return
            }
            guard settings.alertSetting == .enabled else {
                onFailure?("Notification banners are turned off for Barry, so approvals will only appear here. Enable alerts in System Settings to get them as banners.")
                return
            }
            center.add(
                UNNotificationRequest(
                    identifier: "approval-\(approval.id)",
                    content: content(for: approval),
                    trigger: nil
                )
            )
        }
    }

    /// Ask for permission if it has never been decided.
    ///
    /// Approvals used to rely on whatever grant the events feed happened to
    /// obtain. If that never ran, or was denied, banners silently did nothing.
    public static func requestAuthorizationIfNeeded() {
        guard Bundle.main.bundleIdentifier != nil else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    /// Pull a banner once its request is settled, so a stale notification can't
    /// be actioned after the fact — the server would reject it anyway, but a
    /// button that silently does nothing reads as a broken app.
    public static func withdraw(id: String) {
        UNUserNotificationCenter.current()
            .removeDeliveredNotifications(withIdentifiers: ["approval-\(id)"])
    }
}
