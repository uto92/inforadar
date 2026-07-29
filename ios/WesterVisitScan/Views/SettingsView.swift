import SwiftData
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var sync: SyncEngine
    @Environment(\.modelContext) private var modelContext
    @State private var deleteConfirmStep1 = false
    @State private var deleteConfirmStep2 = false

    var body: some View {
        Form {
            Section {
                TextField("https://xxx.workers.dev", text: $settings.serverURLString)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("APIキー", text: $settings.apiKey)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                LabeledContent("状態", value: settings.isServerConfigured ? "設定済み" : "未設定")
            } header: {
                Text("サーバ接続")
            } footer: {
                Text("APIキーは端末のKeychainに保存されます。未設定でもスキャン・蓄積・CSV書き出しは利用できます。")
            }

            Section("スキャン動作") {
                Toggle("同一セッション内の同一ID再読取を許可", isOn: $settings.allowDuplicateInSession)
                Toggle("IDを全桁表示（既定はマスク表示）", isOn: $settings.showFullID)
            }

            Section("端末情報") {
                LabeledContent("デバイスID") {
                    Text(DeviceIdentity.id.uuidString.lowercased())
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent("蓄積件数", value: "\(sync.totalCount)件")
                LabeledContent("未同期", value: "\(sync.unsyncedCount)件")
                LabeledContent("バージョン", value: appVersion)
            }

            Section("データ管理") {
                Button("全データを削除", role: .destructive) {
                    deleteConfirmStep1 = true
                }
            }
        }
        .navigationTitle("設定")
        .alert("全データを削除しますか？", isPresented: $deleteConfirmStep1) {
            Button("次へ", role: .destructive) {
                // アラートの二段掛け。前段の閉じアニメーション完了後に出す
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    deleteConfirmStep2 = true
                }
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("読取記録 \(sync.totalCount) 件（未同期 \(sync.unsyncedCount) 件を含む）とセッション入力履歴を削除します。")
        }
        .alert("本当に削除しますか？", isPresented: $deleteConfirmStep2) {
            Button("削除する", role: .destructive) {
                deleteAll()
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("この操作は取り消せません。未同期のデータはサーバへ送信されないまま失われます。")
        }
        .onAppear {
            sync.refreshCounts()
        }
    }

    private func deleteAll() {
        try? modelContext.delete(model: ScanRecord.self)
        try? modelContext.delete(model: SessionPreset.self)
        try? modelContext.save()
        sync.refreshCounts()
    }

    private var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "-"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "-"
        return "\(version) (\(build))"
    }
}
