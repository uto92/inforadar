import SwiftData
import SwiftUI

@main
struct WesterVisitScanApp: App {
    @StateObject private var settings = SettingsStore()
    @StateObject private var sync = SyncEngine()

    private let container: ModelContainer = {
        do {
            return try ModelContainer(for: ScanRecord.self, SessionPreset.self)
        } catch {
            fatalError("SwiftData ModelContainer の初期化に失敗: \(error)")
        }
    }()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environmentObject(settings)
                .environmentObject(sync)
                .task {
                    sync.configure(container: container, settings: settings)
                }
        }
        .modelContainer(container)
    }
}
