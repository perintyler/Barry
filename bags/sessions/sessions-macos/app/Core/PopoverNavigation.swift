import Foundation

/// Pure rules for what the menu bar popover shows when it is reopened.
///
/// The popover's content view controller outlives any single open/close — the
/// hosting controller is built once at launch and reused — so every piece of
/// screen state survives dismissal by default. Left alone, clicking away while
/// reading a session and then clicking the status item again drops the user
/// back into that session, which reads as the app having ignored the dismissal.
/// The menu bar item is a glanceable entry point; reopening it should behave
/// like opening it fresh.
public enum PopoverNavigation {
    /// Whether a close should discard the current screen and return to the list.
    ///
    /// The one exception is a modal sheet with unsaved input. A sheet can take
    /// key focus away from a `.transient` popover, which closes it underneath —
    /// so a close event here does not always mean the user dismissed the app,
    /// and tearing the sheet down would discard a half-typed prompt on a close
    /// the user never asked for. The sheet owns its own dismissal instead.
    public static func shouldResetToHome(isPresentingModal: Bool) -> Bool {
        !isPresentingModal
    }
}
