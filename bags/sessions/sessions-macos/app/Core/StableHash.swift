import Foundation

/// A hash that is stable across launches.
///
/// `String.hashValue` is seeded per process, so anything derived from it —
/// an avatar color, a palette slot — is stable *within* a run and different on
/// the next one. The identity list picked its avatar colors that way, so the
/// same Barry changed color every time the app started, which reads as the
/// colors being meaningless rather than as a bug.
///
/// FNV-1a: tiny, dependency-free, and deterministic. Nothing here is
/// security-sensitive — the only requirement is a stable spread over N slots.
public enum StableHash {
    public static func value(_ string: String) -> UInt64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in string.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01B3
        }
        return hash
    }

    /// A deterministic index into `count` slots.
    public static func index(_ string: String, slots count: Int) -> Int {
        guard count > 0 else { return 0 }
        return Int(value(string) % UInt64(count))
    }
}
