import Foundation

struct BlockInfo: Codable, Identifiable {
    let name: String
    let type: String
    let description: String?

    var id: String { name }
}
