import Foundation

/// A single message from the session message stream.
/// Matches the shapes returned by `GET /sessions/:id/messages`.
public struct Message: Identifiable {
    public let type: String          // text, tool_start, error, result, summary, init
    public let sessionId: String?
    public let sequence: Int
    public let createdAt: String?

    // text messages
    public let role: String?         // user, assistant, system
    public let content: String?

    // tool_start messages
    public let name: String?
    public var input: String?        // JSON-stringified from any input shape
    public var result: String?       // JSON-stringified from any result shape
    public var hasDetail: Bool?      // true when summary mode omitted full input/result

    // error messages
    public let error: String?

    // result messages
    public let status: String?

    /// Set when this message came from a subagent rather than the main thread,
    /// carrying the id of the Task tool call that spawned it. Lets nested work
    /// be indented instead of reading as the agent's own output.
    public let parentToolUseId: String?

    /// Unique ID — sequence alone can have duplicates when the change-tracker
    /// hook and WS persistence both fire for the same tool call.
    let instanceId = UUID()
    public var id: UUID { instanceId }

    public var isUser: Bool { type == "text" && role == "user" }
    public var isAssistant: Bool { type == "text" && role == "assistant" }
    public var isToolCall: Bool { type == "tool_start" }
    public var isError: Bool { type == "error" }
    public var isSystemRow: Bool { type == "result" || type == "summary" || type == "init" }
    public var needsDetailLoad: Bool { hasDetail == true && result == nil }

    /// Cached summary of tool input for the collapsed row.
    /// Computed once at decode time to avoid JSON parsing on every scroll frame.
    public var toolInputSummary: String = ""

    private static func computeToolInputSummary(_ input: String?) -> String {
        guard let input else { return "" }
        if let data = input.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let cmd = obj["command"] as? String {
                return truncate(cmd, max: 50)
            }
            if let path = obj["file_path"] as? String {
                return truncate((path as NSString).lastPathComponent, max: 45)
            }
            if let pattern = obj["pattern"] as? String {
                return truncate(pattern, max: 45)
            }
        }
        return truncate(input, max: 50)
    }

    private static func truncate(_ s: String, max: Int) -> String {
        s.count > max ? String(s.prefix(max)) + "..." : s
    }

    /// Pretty-print a JSON string. Used for tool input display.
    public static func formatJson(_ input: String) -> String {
        guard let data = input.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: obj, options: .prettyPrinted),
              let str = String(data: pretty, encoding: .utf8) else {
            return input
        }
        return str
    }
}

// Custom decoding: `input` and `result` can be objects, strings, or null.
// We normalize everything to an optional String.
extension Message: Decodable {
    enum CodingKeys: String, CodingKey {
        case type, sessionId, sequence, createdAt
        case role, content, name, input, result, error, status, hasDetail
        case parentToolUseId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        sequence = try c.decode(Int.self, forKey: .sequence)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        role = try c.decodeIfPresent(String.self, forKey: .role)
        content = try c.decodeIfPresent(String.self, forKey: .content)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        hasDetail = try c.decodeIfPresent(Bool.self, forKey: .hasDetail)
        parentToolUseId = try c.decodeIfPresent(String.self, forKey: .parentToolUseId)

        // input/result: could be string, object, array, or null
        input = Self.decodeFlexibleString(from: c, key: .input)
        result = Self.decodeFlexibleString(from: c, key: .result)

        // Cache the summary once instead of parsing JSON on every render
        toolInputSummary = Self.computeToolInputSummary(input)
    }

    /// Decode a JSON value (string, object, array, number, null) into an optional String.
    /// Generic over CodingKey so MessageDetailResponse can reuse it.
    public static func decodeFlexibleString<K: CodingKey>(
        from container: KeyedDecodingContainer<K>,
        key: K
    ) -> String? {
        guard let raw = try? container.decodeIfPresent(AnyCodable.self, forKey: key) else {
            return nil
        }
        if raw.value is NSNull {
            return nil
        }
        if let s = raw.value as? String {
            return s
        }
        if let data = try? JSONSerialization.data(withJSONObject: raw.value, options: [.prettyPrinted, .sortedKeys]),
           let str = String(data: data, encoding: .utf8) {
            return str
        }
        return String(describing: raw.value)
    }
}

/// Wrapper to decode arbitrary JSON values.
private struct AnyCodable: Decodable {
    public let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues(\.value)
        } else if let arr = try? container.decode([AnyCodable].self) {
            value = arr.map(\.value)
        } else if let str = try? container.decode(String.self) {
            value = str
        } else if let num = try? container.decode(Double.self) {
            value = num
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if container.decodeNil() {
            value = NSNull()
        } else {
            value = ""
        }
    }
}

public struct MessagesResponse: Decodable {
    public let messages: [Message]
    public let nextSequence: Int?
    public let hasMore: Bool
}

/// Response from `GET /sessions/:id/messages/:sequence/detail`
public struct MessageDetailResponse: Decodable {
    public let input: String?
    public let result: String?

    enum CodingKeys: String, CodingKey {
        case input, result
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        input = Message.decodeFlexibleString(from: c, key: .input)
        result = Message.decodeFlexibleString(from: c, key: .result)
    }
}
