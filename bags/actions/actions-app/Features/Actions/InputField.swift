import Foundation

/// One field of an action's input form, parsed from its declared JSON Schema.
///
/// Pure and free of the generated API types, like `MetadataReader` — the
/// decisions here (which control a property deserves, what counts as a
/// suggestion) are the ones worth pinning, and they should not need a live
/// server or a decoded OpenAPI payload to exercise.
///
/// The framing these follow is in docs/actions.md ("Soft inputs"): a field is a
/// pre-answered decision the caller may overrule, not an argument they must
/// supply. So a default is something to SHOW, never something to send back as
/// though the user had chosen it.
public struct InputField: Identifiable, Sendable, Equatable {
    public let name: String
    /// `title` when the schema gives one, else the raw property name — a form
    /// labelled `window_days` is worse than one labelled "Window days", but
    /// inventing prose from an unknown key is worse still, so this only
    /// de-snakes what it has.
    public let title: String
    /// `description`, shown as help text. Not `x-barry-infer`: that is written
    /// for the agent, and telling a human "read the tone, investigative →
    /// propublica" describes work they are not doing.
    public let help: String?
    public let kind: Kind
    /// The schema's `default`, rendered for display. Shown as a placeholder,
    /// never as a value — see `InputDraft`.
    public let defaultDisplay: String?
    public let isRequired: Bool

    public var id: String { name }

    /// Which control the field deserves, derived entirely from the schema.
    ///
    /// Deliberately derived rather than declared: a widget hint in the manifest
    /// would be a second source of truth, and the first time it disagreed with
    /// the type the form would render a picker over a number.
    public enum Kind: Sendable, Equatable {
        case text
        case multiline
        case number(isInteger: Bool)
        case toggle
        /// A closed set — `enum` with no freeform branch. The only control
        /// that refuses a value the user types.
        case choice([String])
        /// Suggestions that do NOT constrain: the `anyOf: [{enum}, {string}]`
        /// spelling. Renders as a text field with a menu beside it.
        case suggestion([String])
        /// A shape this form cannot model (nested object, array, `oneOf`).
        /// Rendered as raw JSON rather than dropped — a field that silently
        /// vanishes is worse than one that is awkward to fill.
        case json
    }

    public init(
        name: String,
        title: String,
        help: String?,
        kind: Kind,
        defaultDisplay: String?,
        isRequired: Bool
    ) {
        self.name = name
        self.title = title
        self.help = help
        self.kind = kind
        self.defaultDisplay = defaultDisplay
        self.isRequired = isRequired
    }

    /// Parse an action's `input_schema` into fields, in declaration order.
    ///
    /// Returns empty for a schema with no properties, which is the same answer
    /// as no schema at all: nothing to render.
    public static func parse(schema: [String: Any]?) -> [InputField] {
        guard let schema,
              let properties = schema["properties"] as? [String: Any],
              !properties.isEmpty
        else { return [] }

        let required = Set(schema["required"] as? [String] ?? [])

        // JSON objects are unordered and Foundation hands them back in hash
        // order, which would shuffle the form between launches. Sorted by name
        // so it is at least STABLE; a schema-declared order would need the raw
        // document, which the decoded payload no longer has.
        return properties.keys.sorted().map { name in
            let property = properties[name] as? [String: Any] ?? [:]
            return InputField(
                name: name,
                title: property["title"] as? String ?? humanize(name),
                help: property["description"] as? String,
                kind: kind(for: property),
                defaultDisplay: property["default"].map(display),
                isRequired: required.contains(name)
            )
        }
    }

    /// `window_days` → `Window days`. Only for a property with no `title`.
    static func humanize(_ name: String) -> String {
        let spaced = name.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
        guard let first = spaced.first else { return name }
        return String(first).uppercased() + spaced.dropFirst()
    }

    /// Suggestions offered by a property, from either spelling.
    ///
    /// A bare `enum` constrains; `anyOf: [{enum}, {string}]` only suggests.
    /// Both are read here, and the caller distinguishes them — see `kind`.
    static func options(in property: [String: Any]) -> [String] {
        if let direct = property["enum"] as? [Any] {
            return direct.map(display)
        }
        return []
    }

    /// Options carried by an `anyOf` branch, if the property uses the soft
    /// spelling. Returns nil when there is no such branch, which is what
    /// separates "suggestion" from "choice".
    static func softOptions(in property: [String: Any]) -> [String]? {
        guard let branches = property["anyOf"] as? [Any] else { return nil }
        for case let branch as [String: Any] in branches {
            if let branchEnum = branch["enum"] as? [Any] {
                return branchEnum.map(display)
            }
        }
        return nil
    }

    private static func kind(for property: [String: Any]) -> Kind {
        // Soft suggestions first: a property spelled `anyOf: [{enum}, {string}]`
        // has no top-level `type`, so checking type first would call it json.
        if let soft = softOptions(in: property) {
            return .suggestion(soft)
        }

        let hard = options(in: property)
        if !hard.isEmpty { return .choice(hard) }

        switch property["type"] as? String {
        case "string":
            // A property whose help runs long is usually prose to write, not a
            // word to type. Cheap heuristic, and wrong only cosmetically.
            let help = property["description"] as? String ?? ""
            return help.count > 120 ? .multiline : .text
        case "integer": return .number(isInteger: true)
        case "number": return .number(isInteger: false)
        case "boolean": return .toggle
        case "object", "array": return .json
        case nil: return .json
        default: return .text
        }
    }

    /// Render a JSON value for display. Matches `MetadataReader.display` — the
    /// two exist for the same reason and should not disagree about how a
    /// number or a bool looks.
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

/// What the user actually typed into a form, per action.
///
/// The point of a separate type: only TOUCHED fields are sent. A default is
/// shown as a placeholder and never transmitted, because sending it would tell
/// the agent the user decided — and an agent told the decision is made will not
/// infer one. See docs/actions.md, "Soft inputs".
public struct InputDraft: Sendable, Equatable {
    /// Text the user typed, by field name. Empty string means untouched.
    public var text: [String: String] = [:]
    /// Toggles and pickers have no empty state, so the fields the user
    /// actually operated are tracked explicitly.
    public var touched: Set<String> = []

    public init() {}

    /// The values to send: text fields that are non-empty, plus anything
    /// explicitly touched. Typed against the field list so a number goes over
    /// the wire as a number rather than a string.
    public func values(for fields: [InputField]) -> [String: Any] {
        var out: [String: Any] = [:]
        for field in fields {
            let raw = text[field.name] ?? ""
            let isTouched = touched.contains(field.name)
            guard !raw.isEmpty || isTouched else { continue }

            switch field.kind {
            case let .number(isInteger):
                // A half-typed number ("1.") is not a number yet. Skipping it
                // beats sending a string the server would reject as the wrong
                // type — the user is mid-keystroke, not mistaken.
                if isInteger, let n = Int(raw) { out[field.name] = n }
                else if !isInteger, let d = Double(raw) { out[field.name] = d }
            case .toggle:
                out[field.name] = raw == "true"
            case .json:
                if let data = raw.data(using: .utf8),
                   let parsed = try? JSONSerialization.jsonObject(with: data) {
                    out[field.name] = parsed
                }
            case .text, .multiline, .choice, .suggestion:
                out[field.name] = raw
            }
        }
        return out
    }
}
