import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum TraceAPIError: Error {
    case invalidConfiguration
    case invalidIdentifier
    case missingAuthentication
    case encodingFailed
    case invalidResponse
    case unexpectedSource(expected: APIMode, actual: APIMode)
    case http(status: Int, failure: ServerFailure, requestId: String)
    case cancelled
    case timedOut
    case network
}

public struct TraceAPIConfiguration {
    public let baseURL: URL
    public let mode: APIMode
    public let timeout: TimeInterval

    public init(baseURL: URL, mode: APIMode, timeout: TimeInterval = 10) throws {
        guard let parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let host = parts.host?.lowercased(), let scheme = parts.scheme?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path == "" || parts.path == "/", timeout.isFinite, timeout > 0, timeout <= 120 else {
            throw TraceAPIError.invalidConfiguration
        }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard scheme == "https" || (scheme == "http" && loopback), mode == .live || loopback else {
            throw TraceAPIError.invalidConfiguration
        }
        self.baseURL = baseURL
        self.mode = mode
        self.timeout = timeout
    }
}

private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

public final class TraceAPIClient {
    private let configuration: TraceAPIConfiguration
    private let session: URLSession
    private let token: () -> String?
    private let redirectPolicy = RejectRedirects()

    public init(configuration: TraceAPIConfiguration, session: URLSession? = nil, token: @escaping () -> String? = { nil }) {
        self.configuration = configuration
        if let session {
            self.session = session
        } else {
            let settings = URLSessionConfiguration.ephemeral
            settings.timeoutIntervalForRequest = configuration.timeout
            settings.timeoutIntervalForResource = configuration.timeout
            settings.httpShouldSetCookies = false
            settings.httpCookieStorage = nil
            settings.urlCredentialStorage = nil
            self.session = URLSession(configuration: settings)
        }
        self.token = token
    }

    public func sendAgentMessage(_ body: AgentMessageRequest, requestId: String? = nil) async throws -> Envelope<AgentReply> {
        try await request("POST", "/api/v1/agent/message", body: encode(body), requestId: requestId)
    }

    public func analyzeVision(_ body: VisionAnalyzeRequest, requestId: String? = nil) async throws -> Envelope<VisionAnalysis> {
        try await request("POST", "/api/v1/vision/analyze", body: encode(body), requestId: requestId)
    }

    public func getMemoryProfile(requestId: String? = nil) async throws -> Envelope<MemoryProfile> {
        try await request("GET", "/api/v1/memory/profile", requestId: requestId)
    }

    public func proposeMemory(_ body: MemoryProposalRequest, requestId: String? = nil) async throws -> Envelope<MemoryProposal> {
        try await request("POST", "/api/v1/memory/proposals", body: encode(body), requestId: requestId)
    }

    public func confirmMemory(_ body: MemoryConfirmRequest, requestId: String? = nil) async throws -> Envelope<MemoryRecord> {
        try await request("POST", "/api/v1/memory/confirm", body: encode(body), requestId: requestId)
    }

    public func deleteMemory(_ id: String, requestId: String? = nil) async throws -> Envelope<MemoryDeletion> {
        guard Self.validId(id) else { throw TraceAPIError.invalidIdentifier }
        return try await request("DELETE", "/api/v1/memory/\(id)", requestId: requestId)
    }

    public func listProducts(category: ProductCategory? = nil, ids: [String] = [], requestId: String? = nil) async throws -> Envelope<ProductCatalog> {
        var query = ids.map { URLQueryItem(name: "ids", value: $0) }
        if let category { query.insert(URLQueryItem(name: "category", value: category.rawValue), at: 0) }
        return try await request("GET", "/api/v1/products", query: query, requestId: requestId)
    }

    public func getHealth(requestId: String? = nil) async throws -> Envelope<Health> {
        try await request("GET", "/health", requestId: requestId, authenticated: false)
    }

    private static func validId(_ value: String) -> Bool {
        value.range(of: #"\A[A-Za-z0-9_-]{1,80}\z"#, options: .regularExpression) != nil
    }

    private func encode<Body: Encodable>(_ body: Body) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        do { return try encoder.encode(body) } catch { throw TraceAPIError.encodingFailed }
    }

    private func check(_ meta: ResponseMetadata) throws {
        guard meta.apiVersion == "v1", Self.validId(meta.requestId) else { throw TraceAPIError.invalidResponse }
        guard meta.source == configuration.mode else { throw TraceAPIError.unexpectedSource(expected: configuration.mode, actual: meta.source) }
    }

    private func request<Value: Decodable>(
        _ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil,
        requestId: String?, authenticated: Bool = true
    ) async throws -> Envelope<Value> {
        guard !Task.isCancelled else { throw TraceAPIError.cancelled }
        guard var parts = URLComponents(url: configuration.baseURL, resolvingAgainstBaseURL: false) else {
            throw TraceAPIError.invalidConfiguration
        }
        parts.path = path
        parts.queryItems = query.isEmpty ? nil : query
        guard let url = parts.url else { throw TraceAPIError.invalidConfiguration }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: configuration.timeout)
        request.httpShouldHandleCookies = false
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let requestId {
            guard Self.validId(requestId) else { throw TraceAPIError.invalidIdentifier }
            request.setValue(requestId, forHTTPHeaderField: "X-Request-Id")
        }
        if authenticated {
            guard let value = token(), value.range(of: #"\A[A-Za-z0-9._~+/-]+=*\z"#, options: .regularExpression) != nil else {
                throw TraceAPIError.missingAuthentication
            }
            request.setValue("Bearer \(value)", forHTTPHeaderField: "Authorization")
        }

        let bodyAndResponse: (Data, URLResponse)
        do {
            bodyAndResponse = try await session.data(for: request, delegate: redirectPolicy)
        } catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw TraceAPIError.cancelled }
            if (error as? URLError)?.code == .timedOut { throw TraceAPIError.timedOut }
            throw TraceAPIError.network
        }
        let (data, response) = bodyAndResponse
        guard let http = response as? HTTPURLResponse, http.mimeType?.lowercased() == "application/json" else {
            throw TraceAPIError.invalidResponse
        }
        let decoder = JSONDecoder()
        guard (200..<300).contains(http.statusCode) else {
            guard let decoded = try? decoder.decode(FailureEnvelope.self, from: data) else { throw TraceAPIError.invalidResponse }
            try check(decoded.meta)
            throw TraceAPIError.http(status: http.statusCode, failure: decoded.error, requestId: decoded.meta.requestId)
        }
        guard let decoded = try? decoder.decode(Envelope<Value>.self, from: data) else { throw TraceAPIError.invalidResponse }
        try check(decoded.meta)
        return decoded
    }
}
