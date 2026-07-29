import SwiftUI

/// お客様向け告知画面。スタッフが来場者に提示する静的表示
/// （文言は後で正式版に差し替える前提のプレースホルダを含む）。
struct NoticeView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Text("WESTER会員バーコードの\n読み取りについて")
                    .font(.largeTitle.bold())
                    .fixedSize(horizontal: false, vertical: true)

                Text("WESTER会員バーコードを読み取り、来訪実績の把握のために利用します。取得するのは会員番号と読取日時のみです。")
                    .font(.title3)
                    .fixedSize(horizontal: false, vertical: true)

                noticeSection(
                    "利用目的",
                    "イベント・駅へのWESTER会員の皆さまのご来訪実績を集計するためにのみ利用します。"
                )
                noticeSection(
                    "取得する情報",
                    "WESTER会員番号、読取日時、イベント名・場所"
                )
                noticeSection(
                    "管理者",
                    "（プレースホルダ）西日本旅客鉄道株式会社 ○○本部 ○○部"
                )
                noticeSection(
                    "お問い合わせ",
                    "（プレースホルダ）wester-inquiry@example.com ／ 0570-00-0000"
                )

                Text("ご協力ありがとうございます。")
                    .foregroundStyle(.secondary)
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("お客様向けご案内")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func noticeSection(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)
                .foregroundStyle(.secondary)
            Text(body)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
