import XCTest
@testable import BarryKit

final class BarryKitTests: XCTestCase {
    private struct ModelsPayload: Decodable {
        let providers: [String: ProviderModels]
    }

    private struct TraitsPayload: Decodable {
        let traits: [TraitInfo]
    }

    private struct ProfilesPayload: Decodable {
        let profiles: [ProfileDefaults]
    }

    // MARK: - Model catalog decoding

    func testModelsResponseDecodesRealShape() throws {
        let json = """
        {"providers":{
          "claude":{"default":"claude-opus-4-6","small":"claude-haiku-4-5","models":[
            {"id":"claude-opus-4-6","label":"Opus 4.6"},
            {"id":"claude-haiku-4-5","label":"Haiku 4.5"}]},
          "codex":{"default":null,"small":null,"models":[
            {"id":"gpt-5.3-codex","label":"GPT-5.3 Codex"}]}
        }}
        """
        let response = try JSONDecoder().decode(ModelsPayload.self, from: Data(json.utf8))
        XCTAssertEqual(response.providers.count, 2)

        let claude = try XCTUnwrap(response.providers["claude"])
        XCTAssertEqual(claude.default, "claude-opus-4-6")
        XCTAssertEqual(claude.small, "claude-haiku-4-5")
        XCTAssertEqual(claude.models.map(\.id), ["claude-opus-4-6", "claude-haiku-4-5"])
        XCTAssertEqual(claude.models.first?.label, "Opus 4.6")

        let codex = try XCTUnwrap(response.providers["codex"])
        XCTAssertNil(codex.default)
        XCTAssertNil(codex.small)
    }

    func testModelInfoMemberwiseInitAndHashable() {
        let a = ModelInfo(id: "claude-opus-4-6", label: "Opus 4.6 — claude-opus-4-6")
        let b = ModelInfo(id: "claude-opus-4-6", label: "Opus 4.6 — claude-opus-4-6")
        XCTAssertEqual(a, b)
        XCTAssertEqual(Set([a, b]).count, 1)
    }

    // MARK: - Traits decoding

    func testTraitsResponseDecodes() throws {
        let json = """
        {"traits":[
          {"name":"git","description":"Git tools","access":"readwrite","namespaces":["git"]},
          {"name":"git-read","description":null,"access":"read","namespaces":["git"]}
        ]}
        """
        let response = try JSONDecoder().decode(TraitsPayload.self, from: Data(json.utf8))
        XCTAssertEqual(response.traits.count, 2)
        XCTAssertEqual(response.traits[0].id, "git")
        XCTAssertTrue(response.traits[0].isReadWrite)
        XCTAssertFalse(response.traits[1].isReadWrite)
        XCTAssertNil(response.traits[1].description)
    }

    // MARK: - Profile defaults decoding

    func testProfileDefaultsDecodes() throws {
        let json = """
        {"profiles":[
          {"id":1,"name":"barry","defaultModel":"claude-opus-4-6","defaultCodingAgent":null,"packs":["git"]},
          {"id":3,"name":"default","defaultModel":null,"defaultCodingAgent":"codex"}
        ]}
        """
        let response = try JSONDecoder().decode(ProfilesPayload.self, from: Data(json.utf8))
        XCTAssertEqual(response.profiles.count, 2)
        XCTAssertEqual(response.profiles[0].defaultModel, "claude-opus-4-6")
        XCTAssertNil(response.profiles[0].defaultCodingAgent)
        XCTAssertNil(response.profiles[1].defaultModel)
        XCTAssertEqual(response.profiles[1].defaultCodingAgent, "codex")
    }

    // MARK: - Errors

    func testErrorResponseDecoding() throws {
        let json = #"{"title":"Forbidden","detail":"Missing or invalid BARRY_SECRET"}"#
        let response = try JSONDecoder().decode(ProblemResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.detail, "Missing or invalid BARRY_SECRET")
    }

    func testClientErrorMessage() {
        let err = ClientError.serverError("boom")
        XCTAssertEqual(err.errorDescription, "boom")
        XCTAssertEqual(err.localizedDescription, "boom")
    }

    // MARK: - Core construction

    func testCoreBaseURLIsLocalhost() {
        let core = BarryCore()
        XCTAssertEqual(core.baseURL.host, "localhost")
        XCTAssertNotNil(core.baseURL.port)
    }

}
