import Foundation

/// Safe accessor for the SPM resource bundle. `Bundle.module` is generated with
/// `internal` access for executable targets, which causes compilation failures
/// when `swift test` builds the executable alongside test targets. This wrapper
/// catches that by returning nil when the resource bundle isn't available.
enum BDiffResources {
    static let bundle: Bundle? = {
        let bundleName = "BDiff_BDiff"
        let candidates = [
            Bundle.main.resourceURL,
            Bundle.main.bundleURL,
            Bundle.main.bundleURL.deletingLastPathComponent()
        ]
        for candidate in candidates {
            let bundlePath = candidate?.appendingPathComponent(bundleName + ".bundle")
            if let bundlePath, let bundle = Bundle(url: bundlePath) {
                return bundle
            }
        }
        return nil
    }()
}
