import Foundation

/// 端末識別子。初回起動時に生成し UserDefaults に永続化する
/// （レコード本体ではないため UserDefaults でよい）。
enum DeviceIdentity {
    private static let storageKey = "wvs.device_id"

    static let id: UUID = {
        let defaults = UserDefaults.standard
        if let raw = defaults.string(forKey: storageKey),
           let existing = UUID(uuidString: raw) {
            return existing
        }
        let created = UUID()
        defaults.set(created.uuidString, forKey: storageKey)
        return created
    }()
}
