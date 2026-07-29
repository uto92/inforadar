import SwiftData
import SwiftUI
import UIKit

/// 記録一覧。セッション単位にグループ表示し、全件/セッション単位でCSV共有できる。
struct RecordListView: View {
    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var sync: SyncEngine
    @Query(sort: \ScanRecord.scannedAt, order: .reverse) private var records: [ScanRecord]

    private struct SessionGroup: Identifiable {
        let id: UUID
        let eventName: String
        let locationName: String
        let records: [ScanRecord]
    }

    private var groups: [SessionGroup] {
        Dictionary(grouping: records, by: { $0.sessionId })
            .map { key, value in
                SessionGroup(
                    id: key,
                    eventName: value.first?.eventName ?? "",
                    locationName: value.first?.locationName ?? "",
                    records: value
                )
            }
            .sorted { ($0.records.first?.scannedAt ?? "") > ($1.records.first?.scannedAt ?? "") }
    }

    var body: some View {
        List {
            if records.isEmpty {
                ContentUnavailableView(
                    "記録がありません",
                    systemImage: "barcode",
                    description: Text("スキャンを開始するとここに表示されます。")
                )
            } else {
                ForEach(groups) { group in
                    Section {
                        ForEach(group.records) { record in
                            row(record)
                        }
                    } header: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(group.eventName)（\(group.locationName)）")
                                Text("\(group.records.count)件")
                                    .font(.caption2)
                            }
                            Spacer()
                            CSVShareButton(
                                records: Array(group.records.reversed()),
                                label: group.eventName
                            )
                        }
                    }
                }
            }
        }
        .navigationTitle("記録一覧")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                CSVShareButton(records: Array(records.reversed()), label: "all")
            }
        }
        .safeAreaInset(edge: .bottom) {
            if sync.unsyncedCount > 0 {
                Text("未同期 \(sync.unsyncedCount) 件")
                    .font(.footnote.bold())
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(.red.opacity(0.9), in: Capsule())
                    .foregroundStyle(.white)
                    .padding(.bottom, 6)
            }
        }
        .onAppear {
            sync.refreshCounts()
        }
    }

    private func row(_ record: ScanRecord) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(maskedWesterID(record.westerId, showFull: settings.showFullID))
                    .font(.system(.body, design: .monospaced))
                Text(record.scannedAt)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: record.synced ? "checkmark.icloud" : "icloud.slash")
                .foregroundStyle(record.synced ? Color.green : Color.orange)
                .accessibilityLabel(record.synced ? "同期済み" : "未同期")
        }
    }
}

/// CSVを一時ファイルに書き出して共有シートを開くボタン。
struct CSVShareButton: View {
    let records: [ScanRecord]
    let label: String
    @State private var shareFile: ShareFile?

    var body: some View {
        Button {
            if let url = try? CSVExporter.writeTempFile(records: records, label: label) {
                shareFile = ShareFile(url: url)
            }
        } label: {
            Image(systemName: "square.and.arrow.up")
        }
        .disabled(records.isEmpty)
        .sheet(item: $shareFile) { file in
            ActivitySheet(items: [file.url])
        }
    }
}

struct ShareFile: Identifiable {
    let id = UUID()
    let url: URL
}

struct ActivitySheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
