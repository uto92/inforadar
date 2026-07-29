import Foundation

/// ID変換フック（プライバシー切替点）。
///
/// 検証段階のため現状は素通し。本番移行時は、この関数だけを
/// SHA-256(salt付き) 等へ差し替える。
///
/// 保存 (`ScanRecord.westerId`)・サーバ送信・CSV出力は、すべて
/// この関数を通過した値を使う。生の読取値はこの関数の外へ出さないこと。
/// （サーバ側の12桁再検証 `server/src/index.ts` の `WESTER_ID_RE` も
///  同時に変更が必要な点に注意）
func transformID(_ id: String) -> String {
    id
}
