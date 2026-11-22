import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import TraceAPI

private enum Fixtures {
    static func value(_ name: String) throws -> Data {
        let root = (0..<5).reduce(URL(fileURLWithPath: #filePath)) { path, _ in path.deletingLastPathComponent() }
        let bytes = try Data(contentsOf: root.appendingPathComponent("contracts/examples/v1.json"))
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: [String: Any]])
        return try JSONSerialization.data(withJSONObject: XCTUnwrap(decoded[name]?["value"]))
    }
}

private final class FixtureProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "127.0.0.1" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        do {
            let url = try XCTUnwrap(request.url)
            let fixture: String
            let status: Int
            switch url.path {
            case "/health":
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                fixture = "HealthResponse"
                status = 200
            case "/api/v1/products":
                XCTAssertNotNil(request.value(forHTTPHeaderField: "Authorization"))
                let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
                XCTAssertEqual(query?.filter { $0.name == "ids" }.map(\.value), ["fictional-lip-sample"])
                fixture = "ProductCatalogResponse"
                status = 200
            default:
                fixture = "Error409"
                status = 409
            }
            let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]))
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try Fixtures.value(fixture))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
}

final class TraceAPITests: XCTestCase {
    func testCanonicalPayloadsDecode() throws {
        let decoder = JSONDecoder()
        let agent = try decoder.decode(Envelope<AgentReply>.self, from: Fixtures.value("AgentMessageResponse"))
        XCTAssertEqual(agent.meta.source, .mock)
        XCTAssertNotEqual(agent.data.content.speech, agent.data.content.display.text)
        let vision = try decoder.decode(Envelope<VisionAnalysis>.self, from: Fixtures.value("VisionAnalysisResponse"))
        XCTAssertEqual(vision.data.status, .inconclusive)
        XCTAssertNil(vision.data.confidence)
        XCTAssertTrue(vision.data.predictions.isEmpty)
        _ = try decoder.decode(Envelope<MemoryProfile>.self, from: Fixtures.value("MemoryProfileResponse"))
        _ = try decoder.decode(Envelope<MemoryProposal>.self, from: Fixtures.value("MemoryProposalResponse"))
        _ = try decoder.decode(Envelope<MemoryRecord>.self, from: Fixtures.value("MemoryConfirmationResponse"))
        _ = try decoder.decode(Envelope<MemoryDeletion>.self, from: Fixtures.value("MemoryDeletionResponse"))
    }

    func testCanonicalAgentAndMemoryRequestEncoding() throws {
        let agent = AgentMessageRequest(requestId: "turn-example", locale: .simplifiedChinese, text: "我想先用文字了解课程。")
        let edit = MemoryProposalRequest.correct(memoryId: "memory-example", expectedVersion: 1, preference: Preference(key: .finish, value: "synthetic dewy preference"))
        let encoder = JSONEncoder()
        for (encoded, name) in [
            (try encoder.encode(agent), "AgentMessageRequest"),
            (try encoder.encode(edit), "MemoryCorrectionRequest")
        ] {
            let result = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? NSDictionary)
            let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: Fixtures.value(name)) as? NSDictionary)
            XCTAssertEqual(result, expected)
        }
    }

    func testTransportModeAuthenticationAndHTTPFailure() async throws {
        let baseURL = try XCTUnwrap(URL(string: "http://127.0.0.1:8001"))
        let settings = URLSessionConfiguration.ephemeral
        settings.protocolClasses = [FixtureProtocol.self]
        let session = URLSession(configuration: settings)
        defer { session.invalidateAndCancel() }
        let mock = TraceAPIClient(configuration: try TraceAPIConfiguration(baseURL: baseURL, mode: .mock), session: session, token: { UUID().uuidString })
        let health = try await mock.getHealth()
        XCTAssertEqual(health.data.dependencies.agent, .unchecked)
        let products = try await mock.listProducts(category: .lips, ids: ["fictional-lip-sample"])
        XCTAssertEqual(products.data.items.first?.provenance.status, .synthetic)
        do {
            _ = try await mock.getMemoryProfile()
            XCTFail("Expected a typed conflict")
        } catch TraceAPIError.http(let status, let failure, _) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(failure.code, "CONFLICT")
        }
        let live = TraceAPIClient(configuration: try TraceAPIConfiguration(baseURL: baseURL, mode: .live), session: session)
        do {
            _ = try await live.getHealth()
            XCTFail("Expected mock data to be rejected in live mode")
        } catch TraceAPIError.unexpectedSource(let expected, let actual) {
            XCTAssertEqual(expected, .live)
            XCTAssertEqual(actual, .mock)
        }
    }
}
