import UserNotifications
import XCTest
@testable import ApprovalsFeature

final class ApprovalResponseTests: XCTestCase {
    private let payload: [AnyHashable: Any] = ["action": "approval", "approvalId": "apv_123"]

    func testApproveButtonDecidesApproved() {
        let action = ApprovalResponseRouter.route(
            userInfo: payload, actionIdentifier: ApprovalNotification.approveAction)
        XCTAssertEqual(action, .decide(id: "apv_123", approved: true))
    }

    func testDenyButtonDecidesDenied() {
        let action = ApprovalResponseRouter.route(
            userInfo: payload, actionIdentifier: ApprovalNotification.denyAction)
        XCTAssertEqual(action, .decide(id: "apv_123", approved: false))
    }

    /// Swiping a banner away must never read as a verdict. The request stays
    /// pending until it is answered or expires.
    func testDismissIsNotADecision() {
        let action = ApprovalResponseRouter.route(
            userInfo: payload, actionIdentifier: UNNotificationDismissActionIdentifier)
        XCTAssertEqual(action, .ignore)
    }

    /// A banner shows one line; a destructive merge deserves the full context
    /// before a verdict.
    func testBodyTapOpensRatherThanDeciding() {
        let action = ApprovalResponseRouter.route(
            userInfo: payload, actionIdentifier: UNNotificationDefaultActionIdentifier)
        XCTAssertEqual(action, .open)
    }

    func testOtherNotificationsAreIgnored() {
        let action = ApprovalResponseRouter.route(
            userInfo: ["action": "bag_auth", "bags": ["linear"]],
            actionIdentifier: ApprovalNotification.approveAction)
        XCTAssertEqual(action, .ignore)
    }

    /// A payload naming the right action but carrying no id cannot be acted on.
    /// Deciding "some approval" would settle an arbitrary request.
    func testMissingIdIsIgnored() {
        XCTAssertEqual(
            ApprovalResponseRouter.route(
                userInfo: ["action": "approval"],
                actionIdentifier: ApprovalNotification.approveAction),
            .ignore)
        XCTAssertEqual(
            ApprovalResponseRouter.route(
                userInfo: ["action": "approval", "approvalId": ""],
                actionIdentifier: ApprovalNotification.approveAction),
            .ignore)
    }
}
