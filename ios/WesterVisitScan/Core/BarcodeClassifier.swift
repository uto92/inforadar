import AVFoundation

/// バーコード判定結果。
enum ScanResult: Equatable {
    /// WESTER会員ID。associated value はガード除去後のコア12桁
    /// （`transformID` 適用「前」の生値。保存前に必ず `transformID` を通すこと）。
    case valid(westerID: String)
    /// 対象外。レコード保存せず、セッション内の対象外カウントのみ加算する。
    case reject(reason: RejectReason)
}

/// 対象外の内訳（UI表示はいずれも「WESTER会員証ではありません」）。
enum RejectReason: Equatable {
    case wrongSymbology(String)
    case malformedGuards
    case coreNotNumeric
    case wrongLength(Int)
    case prefixMismatch
    case checkDigitFailed
}

/// 会員IDの厳密化フック。社内仕様が判明したらここだけを更新する。
enum IDRules {
    /// 確定済み: ガード除去後は数字ちょうど12桁
    static let exactLength = 12
    /// 社内仕様判明後に設定（例: "32"）。nil の間は無効
    static let requiredPrefix: String? = nil
    /// チェックディジット検証。nil の間は無効
    static let checkDigit: ((String) -> Bool)? = nil
}

/// Codabar (NW-7) のスタート/ストップ記号
private let codabarGuards: Set<Character> = ["A", "B", "C", "D", "a", "b", "c", "d"]

/// 読取値を WESTER会員ID (valid) / 対象外 (reject) に分類する。
///
/// valid の条件（すべて満たすこと）:
/// - symbology が `.codabar`
/// - 先頭・末尾が Codabar ガード文字 `[A-Da-d]`
/// - ガードを除いたコアが ASCII数字のみ かつ ちょうど `exactLength` 桁
/// - （有効化されていれば）`requiredPrefix` / `checkDigit` を満たす
///
/// `exactLength` 等の引数は単体テストからルールを注入するためのもので、
/// 実運用では既定値（= `IDRules`）のまま2引数で呼び出す。
func classifyBarcode(
    rawText: String,
    symbology: AVMetadataObject.ObjectType,
    exactLength: Int = IDRules.exactLength,
    requiredPrefix: String? = IDRules.requiredPrefix,
    checkDigit: ((String) -> Bool)? = IDRules.checkDigit
) -> ScanResult {
    guard symbology == .codabar else {
        return .reject(reason: .wrongSymbology(symbology.rawValue))
    }
    guard rawText.count >= 2,
          let first = rawText.first,
          let last = rawText.last,
          codabarGuards.contains(first),
          codabarGuards.contains(last) else {
        return .reject(reason: .malformedGuards)
    }
    let core = String(rawText.dropFirst().dropLast())
    guard core.allSatisfy({ $0.isASCII && $0.isNumber }) else {
        return .reject(reason: .coreNotNumeric)
    }
    guard core.count == exactLength else {
        return .reject(reason: .wrongLength(core.count))
    }
    if let prefix = requiredPrefix, !core.hasPrefix(prefix) {
        return .reject(reason: .prefixMismatch)
    }
    if let check = checkDigit, !check(core) {
        return .reject(reason: .checkDigitFailed)
    }
    return .valid(westerID: core)
}
