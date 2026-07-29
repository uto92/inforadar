import XCTest
@testable import WesterVisitScan

final class IDTransformTests: XCTestCase {

    // 検証段階は素通し（生の12桁がそのまま保存・送信・CSVに使われる）
    func testPassthrough() {
        XCTAssertEqual(transformID("328913579881"), "328913579881")
        XCTAssertEqual(transformID("000000000000"), "000000000000")
        XCTAssertEqual(transformID("999999999999"), "999999999999")
    }

    // 同一入力は常に同一出力（ハッシュ化へ差し替えた後も必須の性質。
    // これが崩れるとサーバの uuid 冪等化とは別軸で会員IDの集計が壊れる）
    func testDeterministic() {
        XCTAssertEqual(transformID("328913579881"), transformID("328913579881"))
    }

    func testDistinctInputsRemainDistinct() {
        XCTAssertNotEqual(transformID("328913579881"), transformID("328913579882"))
    }
}
