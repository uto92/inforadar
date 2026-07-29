import AVFoundation
import AudioToolbox
import SwiftData
import SwiftUI

/// 実行中セッションの情報。全レコードに付与される。
struct ScanSessionInfo: Identifiable, Equatable {
    let id: UUID
    let eventName: String
    let locationName: String
}

/// 連続スキャン画面。1件2〜3秒で回すことを最優先にした作り。
struct ScanScreenView: View {
    let session: ScanSessionInfo
    var onEnd: () -> Void

    @Environment(\.modelContext) private var modelContext
    @EnvironmentObject private var settings: SettingsStore
    @EnvironmentObject private var sync: SyncEngine

    @State private var cameraAuthorized: Bool?
    @State private var validCount = 0
    @State private var rejectCount = 0
    @State private var duplicateCount = 0
    /// セッション内で読取済みのID（transformID適用後）。再読取スキップ判定用
    @State private var seenIDs: Set<String> = []
    /// 同一raw値の3秒デバウンス（同一フレーム連写の抑止）
    @State private var recentReads: [String: Date] = [:]
    @State private var flashColor: Color?
    @State private var lastFeedback: Feedback?

    private let haptics = UINotificationFeedbackGenerator()

    struct Feedback: Equatable {
        enum Kind { case success, duplicate, reject }
        let kind: Kind
        let text: String
        let detail: String?
    }

    var body: some View {
        ZStack {
            cameraLayer
            if let flashColor {
                flashColor.opacity(0.5)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            }
            guideFrame
            VStack(spacing: 0) {
                header
                Spacer()
                footer
            }
        }
        .background(Color.black.ignoresSafeArea())
        .onAppear {
            // スキャン画面表示中はスリープさせない
            UIApplication.shared.isIdleTimerDisabled = true
            haptics.prepare()
            requestCameraIfNeeded()
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
        }
    }

    // MARK: - 読取処理

    private func handleDetection(raw: String, type: AVMetadataObject.ObjectType) {
        let now = Date()
        if let last = recentReads[raw], now.timeIntervalSince(last) < 3.0 {
            return
        }
        recentReads = recentReads.filter { now.timeIntervalSince($0.value) < 10 }
        recentReads[raw] = now

        switch classifyBarcode(rawText: raw, symbology: type) {
        case .valid(let coreID):
            // 保存・送信・CSVはすべてこの変換後の値を使う
            let storedID = transformID(coreID)
            let display = maskedWesterID(storedID, showFull: settings.showFullID)
            if !settings.allowDuplicateInSession, seenIDs.contains(storedID) {
                duplicateCount += 1
                show(
                    Feedback(kind: .duplicate, text: "読取済み", detail: display),
                    flash: .yellow, haptic: .warning, sound: nil
                )
                return
            }
            seenIDs.insert(storedID)
            let record = ScanRecord(
                westerId: storedID,
                scannedAt: Timestamp.now(),
                sessionId: session.id,
                eventName: session.eventName,
                locationName: session.locationName,
                deviceId: DeviceIdentity.id
            )
            modelContext.insert(record)
            try? modelContext.save()
            validCount += 1
            sync.recordAdded()
            show(
                Feedback(kind: .success, text: "読取OK", detail: display),
                flash: .green, haptic: .success, sound: 1057
            )
        case .reject:
            rejectCount += 1
            show(
                Feedback(kind: .reject, text: "WESTER会員証ではありません", detail: nil),
                flash: .red, haptic: .error, sound: 1053
            )
        }
    }

    private func show(
        _ feedback: Feedback,
        flash: Color,
        haptic: UINotificationFeedbackGenerator.FeedbackType,
        sound: SystemSoundID?
    ) {
        lastFeedback = feedback
        haptics.notificationOccurred(haptic)
        if let sound {
            AudioServicesPlaySystemSound(sound)
        }
        withAnimation(.easeIn(duration: 0.05)) {
            flashColor = flash
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            withAnimation(.easeOut(duration: 0.2)) {
                flashColor = nil
            }
        }
    }

    // MARK: - カメラ権限

    private func requestCameraIfNeeded() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            cameraAuthorized = true
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    cameraAuthorized = granted
                }
            }
        default:
            cameraAuthorized = false
        }
    }

    // MARK: - サブビュー

    @ViewBuilder
    private var cameraLayer: some View {
        switch cameraAuthorized {
        case true:
            CameraScannerView { raw, type in
                handleDetection(raw: raw, type: type)
            }
            .ignoresSafeArea()
        case false:
            VStack(spacing: 16) {
                Image(systemName: "video.slash")
                    .font(.system(size: 48))
                Text("カメラを利用できません")
                    .font(.headline)
                Text("設定アプリでこのアプリのカメラ利用を許可してください。")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                Button("設定を開く") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .buttonStyle(.borderedProminent)
            }
            .foregroundStyle(.white)
            .padding(32)
        default:
            Color.black.ignoresSafeArea()
        }
    }

    private var guideFrame: some View {
        RoundedRectangle(cornerRadius: 16)
            .stroke(.white.opacity(0.8), lineWidth: 3)
            .frame(width: 300, height: 170)
            .allowsHitTesting(false)
    }

    private var header: some View {
        VStack(spacing: 2) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.eventName)
                        .font(.headline)
                    Text(session.locationName)
                        .font(.caption)
                        .opacity(0.8)
                }
                Spacer()
                Button {
                    onEnd()
                } label: {
                    Text("セッション終了")
                        .font(.subheadline.bold())
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(.white.opacity(0.25), in: Capsule())
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(validCount)")
                    .font(.system(size: 64, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text("件")
                    .font(.title3)
                    .opacity(0.9)
            }
            HStack(spacing: 16) {
                Text("対象外 \(rejectCount)")
                Text("読取済スキップ \(duplicateCount)")
            }
            .font(.caption)
            .opacity(0.75)
        }
        .foregroundStyle(.white)
        .padding(.horizontal)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(
            LinearGradient(
                colors: [.black.opacity(0.7), .black.opacity(0.45), .clear],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
        )
    }

    private var footer: some View {
        VStack(spacing: 10) {
            if let feedback = lastFeedback {
                HStack(spacing: 12) {
                    Image(systemName: feedbackIcon(feedback.kind))
                        .font(.title2)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(feedback.text)
                            .font(.headline)
                        if let detail = feedback.detail {
                            Text(detail)
                                .font(.system(.title3, design: .monospaced))
                        }
                    }
                    Spacer()
                }
                .padding(14)
                .background(feedbackColor(feedback.kind).opacity(0.92), in: RoundedRectangle(cornerRadius: 14))
                .foregroundStyle(feedback.kind == .duplicate ? Color.black : Color.white)
            } else {
                Text("WESTER会員バーコードを枠内にかざしてください")
                    .font(.subheadline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(.black.opacity(0.55), in: Capsule())
            }
        }
        .padding(.horizontal)
        .padding(.bottom, 28)
    }

    private func feedbackIcon(_ kind: Feedback.Kind) -> String {
        switch kind {
        case .success: return "checkmark.circle.fill"
        case .duplicate: return "exclamationmark.triangle.fill"
        case .reject: return "xmark.octagon.fill"
        }
    }

    private func feedbackColor(_ kind: Feedback.Kind) -> Color {
        switch kind {
        case .success: return .green
        case .duplicate: return .yellow
        case .reject: return .red
        }
    }
}
