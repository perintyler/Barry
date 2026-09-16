import Foundation

/// Reads `action_runs.metadata` into the app's view of a run's input side.
///
/// Pure and free of the generated API types so it can be unit-tested with
/// plain dictionaries — the decisions here (what counts as "not recorded",
/// how a value is rendered) are the ones worth pinning, and they should not
/// require a live server or a decoded OpenAPI payload to exercise.
public enum MetadataReader {
    /// Keys that describe the run's plumbing rather than its request. Excluded
    /// from the displayed inputs so the pane shows what the CALLER supplied,
    /// not what Barry recorded about itself.
    private static let reservedKeys: Set<String> = [
        "prompt", "prompt_truncated", "prompt_chars",
        "inputs", "output_schema", "legacySkill", "executor", "provider",
    ]

    /// Derive the input side.
    ///
    /// The presence of `prompt` is the discriminator for "was this run
    /// captured at all", NOT the presence of `inputs` — wrap-up declares no
    /// inputs, so keying off `inputs` would report every wrap-up run as
    /// uncaptured and make the feature look broken exactly where it is most
    /// used.
    public static func inputSide(from metadata: [String: Any]) -> InputSide {
        guard let prompt = metadata["prompt"] as? String, !prompt.isEmpty else {
            return .notRecorded
        }

        guard let raw = metadata["inputs"] as? [String: Any], !raw.isEmpty else {
            return .noInputs(prompt: prompt)
        }

        var values: [String: String] = [:]
        for (key, value) in raw {
            values[key] = display(value)
        }
        return .inputs(values: values, prompt: prompt)
    }

    public static func promptTruncated(from metadata: [String: Any]) -> Bool {
        metadata["prompt_truncated"] as? Bool ?? false
    }

    /// Any other metadata worth showing, as sorted key/value pairs — the
    /// provider a detached run used, whether it came from the executor, and
    /// anything a future writer adds. Shown rather than dropped so a new key
    /// is visible the day it starts being written, instead of waiting for this
    /// app to learn about it.
    public static func extras(from metadata: [String: Any]) -> [RunDetail.Extra] {
        metadata
            .filter { !reservedKeys.contains($0.key) }
            .map { RunDetail.Extra(key: $0.key, value: display($0.value)) }
            .sorted { $0.key < $1.key }
    }

    /// Render a JSON value for display. Strings pass through unquoted;
    /// everything else is JSON-encoded so an object input is legible rather
    /// than printing as a Swift dictionary description.
    static func display(_ value: Any) -> String {
        if let string = value as? String { return string }
        if let bool = value as? Bool { return bool ? "true" : "false" }
        if value is NSNull { return "null" }
        if let number = value as? NSNumber { return number.stringValue }

        if JSONSerialization.isValidJSONObject(value),
           let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            return text
        }
        return String(describing: value)
    }
}
