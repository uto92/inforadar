import Foundation
import SwiftData

/// セッション開始画面の「過去入力履歴からワンタップ再選択」用の履歴。
@Model
final class SessionPreset {
    var eventName: String
    var locationName: String
    var lastUsedAt: Date

    init(eventName: String, locationName: String, lastUsedAt: Date = Date()) {
        self.eventName = eventName
        self.locationName = locationName
        self.lastUsedAt = lastUsedAt
    }
}
