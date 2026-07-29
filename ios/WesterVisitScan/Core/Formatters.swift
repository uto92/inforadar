import Foundation

enum Timestamp {
    /// ISO8601・端末タイムゾーンのオフセット付き（日本の端末なら +09:00）
    static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = .current
        return formatter
    }()

    static func now() -> String {
        iso8601.string(from: Date())
    }
}

/// 画面表示用マスク。周囲の来場者から画面が見えるため既定はマスク表示
/// （例: 328913579881 → ＊＊＊＊＊＊＊＊9881）。
func maskedWesterID(_ id: String, showFull: Bool) -> String {
    guard !showFull, id.count > 4 else { return id }
    return String(repeating: "＊", count: id.count - 4) + String(id.suffix(4))
}
