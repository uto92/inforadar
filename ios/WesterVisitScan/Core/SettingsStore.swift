import Foundation

/// アプリ設定。トグル類・サーバURLは UserDefaults、APIキーのみ Keychain。
final class SettingsStore: ObservableObject {
    private enum Keys {
        static let serverURL = "wvs.server_url"
        static let allowDuplicates = "wvs.allow_duplicate_in_session"
        static let showFullID = "wvs.show_full_id"
    }
    static let apiKeyKeychainKey = "api_key"

    @Published var serverURLString: String {
        didSet { UserDefaults.standard.set(serverURLString, forKey: Keys.serverURL) }
    }
    /// 同一セッション内の同一ID再読取を許可（既定: 許可しない = スキップ）
    @Published var allowDuplicateInSession: Bool {
        didSet { UserDefaults.standard.set(allowDuplicateInSession, forKey: Keys.allowDuplicates) }
    }
    /// IDを全桁表示（既定: マスク表示）
    @Published var showFullID: Bool {
        didSet { UserDefaults.standard.set(showFullID, forKey: Keys.showFullID) }
    }
    @Published var apiKey: String {
        didSet {
            if apiKey.isEmpty {
                KeychainStore.delete(Self.apiKeyKeychainKey)
            } else {
                KeychainStore.set(apiKey, forKey: Self.apiKeyKeychainKey)
            }
        }
    }

    init() {
        let defaults = UserDefaults.standard
        serverURLString = defaults.string(forKey: Keys.serverURL) ?? ""
        allowDuplicateInSession = defaults.bool(forKey: Keys.allowDuplicates)
        showFullID = defaults.bool(forKey: Keys.showFullID)
        apiKey = KeychainStore.get(Self.apiKeyKeychainKey) ?? ""
    }

    var serverBaseURL: URL? {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            return nil
        }
        return url
    }

    var isServerConfigured: Bool {
        serverBaseURL != nil && !apiKey.isEmpty
    }
}
