import Foundation
import Network
import SwiftData

/// 未同期レコードの自動同期（オフラインファースト）。
///
/// - `NWPathMonitor` で接続監視し、オンライン復帰時に未同期分を自動送信
/// - 100件ずつバッチ送信、サーバ側は uuid で冪等（再送しても重複しない）
/// - 失敗時は指数バックオフ（2, 4, 8, … 最大300秒）で自動リトライ
/// - 手動「今すぐ同期」は `syncNow()` を直接呼ぶ
@MainActor
final class SyncEngine: ObservableObject {
    static let batchSize = 100

    @Published private(set) var unsyncedCount = 0
    @Published private(set) var totalCount = 0
    @Published private(set) var isSyncing = false
    @Published private(set) var isOnline = false
    @Published private(set) var lastSyncMessage: String?

    private var container: ModelContainer?
    private var settings: SettingsStore?
    private let monitor = NWPathMonitor()
    private var consecutiveFailures = 0
    private var retryTask: Task<Void, Never>?

    nonisolated init() {}

    func configure(container: ModelContainer, settings: SettingsStore) {
        guard self.container == nil else { return }
        self.container = container
        self.settings = settings
        refreshCounts()
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor [weak self] in
                guard let self else { return }
                let wasOnline = self.isOnline
                self.isOnline = online
                // オンライン復帰時に未送信分を自動送信
                if online, !wasOnline, self.unsyncedCount > 0 {
                    self.syncNow(auto: true)
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "wvs.network-monitor"))
    }

    func refreshCounts() {
        guard let context = container?.mainContext else { return }
        let unsynced = FetchDescriptor<ScanRecord>(
            predicate: #Predicate<ScanRecord> { $0.synced == false }
        )
        unsyncedCount = (try? context.fetchCount(unsynced)) ?? 0
        totalCount = (try? context.fetchCount(FetchDescriptor<ScanRecord>())) ?? 0
    }

    /// スキャン画面でレコード追加後に呼ぶ。オンラインなら即時送信を試みる。
    func recordAdded() {
        refreshCounts()
        if isOnline {
            syncNow(auto: true)
        }
    }

    func syncNow(auto: Bool = false) {
        retryTask?.cancel()
        retryTask = nil
        guard !isSyncing else { return }
        guard let settings, settings.isServerConfigured else {
            if !auto {
                lastSyncMessage = "サーバURL・APIキーを設定してください"
            }
            return
        }
        Task { await performSync() }
    }

    private func performSync() async {
        guard let container,
              let settings,
              let baseURL = settings.serverBaseURL else {
            return
        }
        let client = APIClient(baseURL: baseURL, apiKey: settings.apiKey)
        let context = container.mainContext
        isSyncing = true
        defer {
            isSyncing = false
            refreshCounts()
        }
        var sentTotal = 0
        while true {
            var descriptor = FetchDescriptor<ScanRecord>(
                predicate: #Predicate<ScanRecord> { $0.synced == false },
                sortBy: [SortDescriptor(\ScanRecord.scannedAt)]
            )
            descriptor.fetchLimit = Self.batchSize
            guard let batch = try? context.fetch(descriptor), !batch.isEmpty else {
                break
            }
            do {
                _ = try await client.postScans(batch.map(ScanUploadRecord.init))
                let stamp = Timestamp.now()
                for record in batch {
                    record.synced = true
                    record.syncedAt = stamp
                }
                try context.save()
                sentTotal += batch.count
                consecutiveFailures = 0
                refreshCounts()
            } catch {
                consecutiveFailures += 1
                lastSyncMessage = "同期失敗: \(error.localizedDescription)"
                scheduleRetry()
                return
            }
        }
        if sentTotal > 0 {
            lastSyncMessage = "\(sentTotal)件を同期しました（\(Timestamp.now())）"
        }
    }

    private func scheduleRetry() {
        let delay = min(pow(2.0, Double(consecutiveFailures)), 300)
        retryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.syncNow(auto: true)
        }
    }
}
