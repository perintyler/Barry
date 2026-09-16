import XCTest
@testable import BarrySessionsCore

/// The rail is a separate window, so where it lands is arithmetic rather than
/// layout — and arithmetic that puts it off-screen produces buttons nobody can
/// click, with nothing on screen to say so.
final class AppRailPanelFrameTests: XCTestCase {
    private let popover = CGRect(x: 400, y: 200, width: 580, height: 680)
    private let screen = CGRect(x: 0, y: 0, width: 1920, height: 1080)

    func testSitsJustOutsideTheRightEdge() {
        let frame = AppRailPlacement.frame(
            beside: popover, height: 210, screen: screen
        )
        XCTAssertEqual(frame.minX, popover.maxX + AppRailPlacement.gap)
    }

    func testIsVerticallyCenteredOnThePopover() {
        let frame = AppRailPlacement.frame(
            beside: popover, height: 210, screen: screen
        )
        XCTAssertEqual(frame.midY, popover.midY, accuracy: 0.001)
    }

    /// A status item near the right edge of the display would otherwise push
    /// the rail past the screen, leaving every button unreachable.
    func testTucksInsideWhenThereIsNoRoomOnTheRight() {
        let atEdge = CGRect(x: 1300, y: 200, width: 580, height: 680)
        let frame = AppRailPlacement.frame(
            beside: atEdge, height: 210, screen: screen
        )
        XCTAssertLessThanOrEqual(frame.maxX, screen.maxX)
        XCTAssertGreaterThan(frame.minX, atEdge.minX)
    }

    /// No screen to measure against is not a reason to move the rail.
    func testStillPositionsWithoutAScreen() {
        let frame = AppRailPlacement.frame(
            beside: popover, height: 210, screen: nil
        )
        XCTAssertEqual(frame.minX, popover.maxX + AppRailPlacement.gap)
    }
}
