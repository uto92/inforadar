import SwiftData
import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var sync: SyncEngine
    @State private var showScanFlow = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    statsCard
                }
                Section {
                    Button {
                        showScanFlow = true
                    } label: {
                        Label("スキャン開始", systemImage: "barcode.viewfinder")
                            .font(.title3.bold())
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
                Section("データ") {
                    NavigationLink {
                        RecordListView()
                    } label: {
                        Label("記録一覧・CSV書き出し", systemImage: "list.bullet.rectangle")
                    }
                    .badge(sync.unsyncedCount > 0 ? "未同期 \(sync.unsyncedCount)" : nil)
                    Button {
                        sync.syncNow()
                    } label: {
                        HStack {
                            Label("今すぐ同期", systemImage: "arrow.triangle.2.circlepath")
                            Spacer()
                            if sync.isSyncing {
                                ProgressView()
                            }
                        }
                    }
                    .disabled(sync.isSyncing || !settings.isServerConfigured)
                    if let message = sync.lastSyncMessage {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Section("その他") {
                    NavigationLink {
                        NoticeView()
                    } label: {
                        Label("お客様向けご案内", systemImage: "person.wave.2")
                    }
                    NavigationLink {
                        SettingsView()
                    } label: {
                        Label("設定", systemImage: "gearshape")
                    }
                }
            }
            .navigationTitle("WESTER来訪スキャナ")
            .fullScreenCover(isPresented: $showScanFlow, onDismiss: {
                sync.refreshCounts()
            }) {
                ScanFlowView()
            }
            .onAppear {
                sync.refreshCounts()
            }
        }
    }

    private var statsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("累計読取")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(sync.totalCount)")
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text("件")
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                if sync.unsyncedCount > 0 {
                    statusChip("未同期 \(sync.unsyncedCount) 件", color: .red)
                } else {
                    statusChip("すべて同期済み", color: .green)
                }
                statusChip(sync.isOnline ? "オンライン" : "オフライン",
                           color: sync.isOnline ? .blue : .gray)
                if !settings.isServerConfigured {
                    statusChip("サーバ未設定", color: .orange)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func statusChip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption.bold())
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}
