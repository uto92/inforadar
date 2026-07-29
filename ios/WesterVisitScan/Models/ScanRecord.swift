import Foundation
import SwiftData

/// 読取1件のレコード。オフラインで蓄積し、回線復帰後にサーバへ同期する。
@Model
final class ScanRecord {
    /// クライアント生成。サーバ同期の冪等キー（サーバ側は INSERT OR IGNORE）
    @Attribute(.unique) var uuid: UUID
    /// `transformID` 適用後の会員ID（検証段階は生の12桁）
    var westerId: String
    /// ISO8601・タイムゾーンオフセット付き（例: 2026-07-29T14:03:21+09:00）
    var scannedAt: String
    var sessionId: UUID
    var eventName: String
    var locationName: String
    var deviceId: UUID
    var synced: Bool
    var syncedAt: String?

    init(
        uuid: UUID = UUID(),
        westerId: String,
        scannedAt: String,
        sessionId: UUID,
        eventName: String,
        locationName: String,
        deviceId: UUID,
        synced: Bool = false,
        syncedAt: String? = nil
    ) {
        self.uuid = uuid
        self.westerId = westerId
        self.scannedAt = scannedAt
        self.sessionId = sessionId
        self.eventName = eventName
        self.locationName = locationName
        self.deviceId = deviceId
        self.synced = synced
        self.syncedAt = syncedAt
    }
}
