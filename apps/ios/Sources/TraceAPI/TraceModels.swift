import Foundation

public enum APIMode: String, Codable {
    case mock, live
}

public struct ResponseMetadata: Decodable {
    public let apiVersion: String
    public let source: APIMode
    public let requestId: String
}

public struct Envelope<Value: Decodable>: Decodable {
    public let meta: ResponseMetadata
    public let data: Value
}

public struct ServerFailure: Decodable {
    public let code: String
    public let message: String
    public let retryable: Bool
}

struct FailureEnvelope: Decodable {
    let meta: ResponseMetadata
    let error: ServerFailure
}

public enum TraceLocale: String, Codable {
    case simplifiedChinese = "zh-CN"
    case english = "en"
}

public struct AgentMessageRequest: Encodable {
    struct Message: Encodable {
        let kind = "text"
        let text: String
    }

    let requestId: String
    let sessionId: String?
    let locale: TraceLocale
    let message: Message

    public init(requestId: String, sessionId: String? = nil, locale: TraceLocale, text: String) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.locale = locale
        self.message = Message(text: text)
    }
}

public struct AgentReply: Decodable {
    public struct Session: Decodable {
        public struct Workflow: Decodable {
            public enum Stage: String, Decodable { case conversation, guidance, paused, completed }
            public let stage: Stage
            public let revision: Int?
            public let stepId: String?
        }
        public let id: String
        public let locale: TraceLocale
        public let workflow: Workflow
    }

    public struct Content: Decodable {
        public struct Display: Decodable { public let text: String }
        public let speech: String?
        public let display: Display
    }

    public let session: Session
    public let content: Content
}

public enum VisionTask: String, Codable {
    case cheekColorBalance = "cheek_color_balance"
    case lipColor = "lip_color"
}

public enum CoordinateSpace: String, Codable { case image, user, unknown }
public enum VisionQuality: String, Codable { case usable, poor, unknown }

public struct VisionAnalyzeRequest: Encodable {
    struct Authorization: Encodable {
        let scope = "local_observation"
        let granted: Bool
    }

    public struct Observation: Encodable {
        let captureId: String
        let capturedAt: Date
        let methodVersion: String
        let coordinateSpace: CoordinateSpace
        let quality: VisionQuality

        public init(captureId: String, capturedAt: Date, methodVersion: String, coordinateSpace: CoordinateSpace, quality: VisionQuality) {
            self.captureId = captureId
            self.capturedAt = capturedAt
            self.methodVersion = methodVersion
            self.coordinateSpace = coordinateSpace
            self.quality = quality
        }
    }

    let sessionId: String?
    let task: VisionTask
    let authorization: Authorization
    let observation: Observation

    public init(sessionId: String? = nil, task: VisionTask, granted: Bool, observation: Observation) {
        self.sessionId = sessionId
        self.task = task
        self.authorization = Authorization(granted: granted)
        self.observation = observation
    }
}

public struct VisionAnalysis: Decodable {
    public enum Status: String, Decodable { case observed, inconclusive }
    public struct Prediction: Decodable { public let label: String }
    public struct Confidence: Decodable {
        public let score: Double
        public let calibrated: Bool
    }
    public struct Quality: Decodable {
        public let level: VisionQuality
        public let reasons: [String]
    }
    public let task: VisionTask
    public let status: Status
    public let predictions: [Prediction]
    public let confidence: Confidence?
    public let quality: Quality
    public let coordinateSpace: CoordinateSpace
    public let methodVersion: String
}

public struct Preference: Codable {
    public enum Key: String, Codable { case finish, fragrance, tools }
    public let key: Key
    public let value: String
    public init(key: Key, value: String) {
        self.key = key
        self.value = value
    }
}

public struct MemoryRecord: Decodable {
    public let id: String
    public let version: Int
    public let preference: Preference
}

public struct MemoryProfile: Decodable { public let records: [MemoryRecord] }

public enum MemoryProposalRequest: Encodable {
    case create(Preference)
    case correct(memoryId: String, expectedVersion: Int, preference: Preference)

    private enum CodingKeys: String, CodingKey { case operation, memoryId, expectedVersion, preference }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .create(let preference):
            try values.encode("create", forKey: .operation)
            try values.encode(preference, forKey: .preference)
        case .correct(let memoryId, let expectedVersion, let preference):
            try values.encode("correct", forKey: .operation)
            try values.encode(memoryId, forKey: .memoryId)
            try values.encode(expectedVersion, forKey: .expectedVersion)
            try values.encode(preference, forKey: .preference)
        }
    }
}

public struct MemoryProposal: Decodable {
    public enum Operation: String, Decodable { case create, correct }
    public let id: String
    public let version: Int
    public let operation: Operation
    public let memoryId: String?
    public let preference: Preference
    public let expiresAt: String
}

public struct MemoryConfirmRequest: Encodable {
    let proposalId: String
    let expectedVersion: Int
    let confirmed: Bool

    public init(proposalId: String, expectedVersion: Int, confirmed: Bool) {
        self.proposalId = proposalId
        self.expectedVersion = expectedVersion
        self.confirmed = confirmed
    }
}

public struct MemoryDeletion: Decodable {
    public enum Status: String, Decodable { case deleted }
    public let id: String
    public let status: Status
}

public enum ProductCategory: String, Codable { case face, lips, tools }

public struct ProductCatalog: Decodable {
    public struct Product: Decodable {
        public struct Attributes: Decodable {
            public let shade: String?
            public let finish: String?
        }
        public struct Provenance: Decodable {
            public enum Status: String, Decodable { case verified, synthetic }
            public let status: Status
            public let title: String
            public let url: URL?
        }
        public let id: String
        public let name: String
        public let category: ProductCategory
        public let attributes: Attributes
        public let provenance: Provenance
    }
    public let items: [Product]
}

public struct Health: Decodable {
    public enum ServiceState: String, Decodable { case unchecked, healthy, unhealthy }
    public enum Status: String, Decodable { case alive }
    public struct Dependencies: Decodable {
        public let agent: ServiceState
        public let vision: ServiceState
        public let memory: ServiceState
        public let products: ServiceState
    }
    public let status: Status
    public let dependencies: Dependencies
}
