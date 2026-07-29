import SwiftData
import SwiftUI

/// フルスクリーンのスキャンフロー: セッション情報入力 → 連続スキャン → 終了で閉じる。
struct ScanFlowView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var activeSession: ScanSessionInfo?

    var body: some View {
        if let session = activeSession {
            ScanScreenView(session: session) {
                dismiss()
            }
        } else {
            NavigationStack {
                SessionSetupView { info in
                    activeSession = info
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("キャンセル") {
                            dismiss()
                        }
                    }
                }
            }
        }
    }
}

/// セッション開始前の「イベント名」「場所」入力。過去履歴からワンタップ再選択可。
struct SessionSetupView: View {
    var onStart: (ScanSessionInfo) -> Void

    @Environment(\.modelContext) private var modelContext
    @Query(sort: \SessionPreset.lastUsedAt, order: .reverse) private var presets: [SessionPreset]
    @State private var eventName = ""
    @State private var locationName = ""

    private var trimmedEvent: String {
        eventName.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var trimmedLocation: String {
        locationName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        Form {
            Section("このセッションのイベント情報") {
                TextField("イベント名（例: ○○駅マルシェ）", text: $eventName)
                TextField("場所（例: ○○駅 改札前）", text: $locationName)
            }
            if !presets.isEmpty {
                Section("履歴から選択") {
                    ForEach(presets.prefix(8)) { preset in
                        Button {
                            eventName = preset.eventName
                            locationName = preset.locationName
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(preset.eventName)
                                    .foregroundStyle(.primary)
                                Text(preset.locationName)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            Section {
                Button {
                    start()
                } label: {
                    Text("スキャン開始")
                        .font(.headline)
                        .frame(maxWidth: .infinity, minHeight: 36)
                }
                .disabled(trimmedEvent.isEmpty || trimmedLocation.isEmpty)
            } footer: {
                Text("入力した内容はこのセッションの全読取レコードに付与されます。")
            }
        }
        .navigationTitle("セッション開始")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func start() {
        let event = trimmedEvent
        let location = trimmedLocation
        if let existing = presets.first(where: {
            $0.eventName == event && $0.locationName == location
        }) {
            existing.lastUsedAt = Date()
        } else {
            modelContext.insert(SessionPreset(eventName: event, locationName: location))
        }
        try? modelContext.save()
        onStart(ScanSessionInfo(id: UUID(), eventName: event, locationName: location))
    }
}
