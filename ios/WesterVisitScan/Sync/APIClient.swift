import Foundation

/// `POST /v1/scans` の1レコード。キー名はサーバ仕様（snake_case）。
struct ScanUploadRecord: Codable {
    let uuid: String
    let westerId: String
    let scannedAt: String
    let event: String
    let location: String
    let sessionId: String
    let deviceId: String

    enum CodingKeys: String, CodingKey {
        case uuid
        case westerId = "wester_id"
        case scannedAt = "scanned_at"
        case event
        case location
        case sessionId = "session_id"
        case deviceId = "device_id"
    }

    init(record: ScanRecord) {
        uuid = record.uuid.uuidString.lowercased()
        westerId = record.westerId // 保存時点で transformID 適用済み
        scannedAt = record.scannedAt
        event = record.eventName
        location = record.locationName
        sessionId = record.sessionId.uuidString.lowercased()
        deviceId = record.deviceId.uuidString.lowercased()
    }
}

struct ScanUploadResponse: Decodable {
    let accepted: Int
    let rejected: Int
}

enum APIClientError: LocalizedError {
    case badStatus(Int)

    var errorDescription: String? {
        switch self {
        case .badStatus(let code):
            switch code {
            case 401: return "認証エラー（APIキーを確認してください）"
            default: return "サーバエラー (HTTP \(code))"
            }
        }
    }
}

struct APIClient {
    let baseURL: URL
    let apiKey: String

    func postScans(_ records: [ScanUploadRecord]) async throws -> ScanUploadResponse {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/scans"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(["records": records])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIClientError.badStatus(http.statusCode)
        }
        return try JSONDecoder().decode(ScanUploadResponse.self, from: data)
    }
}
