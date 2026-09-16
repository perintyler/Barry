import Foundation

/// The top-level surfaces of the menu bar popover.
///
/// Each tab was its own menu bar app with its own status item and login item
/// before they were folded together. They are tabs now, so exactly one is on
/// screen at a time — which is what makes `isVisible(_:whilePopoverOpen:)`
/// the deciding input for whether the events feed counts as "seen".
public enum RootTab: String, CaseIterable, Sendable {
    case sessions
    case events
    case approvals
    case services

    public var title: String {
        switch self {
        case .sessions: return "Sessions"
        case .events: return "Events"
        case .approvals: return "Approvals"
        case .services: return "Services"
        }
    }
}

/// Rules for the popover's root navigation.
///
/// Pure and separate from the views so the parts that are easy to get subtly
/// wrong — and invisible when wrong — can be tested without a running app.
public enum RootNavigation {
    /// Whether `tab`'s content is actually on screen.
    ///
    /// The events feed suppresses notifications while the user can see it: a
    /// banner for something already on screen is noise. As separate apps that
    /// was simply "is the popover open", because the feed was the only thing
    /// in it. With tabs it is a conjunction, and both halves matter. Treating
    /// an open popover as sufficient silently drops every banner while the
    /// user sits on the sessions tab; ignoring the popover entirely announces
    /// events the user is already looking at.
    public static func isVisible(_ tab: RootTab, selected: RootTab, whilePopoverOpen popoverOpen: Bool) -> Bool {
        popoverOpen && tab == selected
    }

    /// Whether the root tab switcher should be on screen.
    ///
    /// Hidden while a session is open: that screen has its own back button and
    /// its own tab row, and stacking a second row above the first read as two
    /// competing navigations. Only the sessions tab has a detail screen, so
    /// every other tab always shows the switcher.
    ///
    /// This governs the tab row alone. The app rail is a column on the far
    /// edge, so it never stacks on the detail header and stays on screen —
    /// the reasoning above is about rows, and does not carry to it.
    public static func showsTabBar(selected: RootTab, isShowingDetail: Bool) -> Bool {
        !(selected == .sessions && isShowingDetail)
    }

    /// Which tab a fresh open should land on.
    ///
    /// Reopening the menu bar item behaves like opening the app for the first
    /// time — see `PopoverNavigation.shouldResetToHome`. Resuming the last tab
    /// would make a glanceable control feel like it had ignored the dismissal.
    public static var home: RootTab { .sessions }
}
