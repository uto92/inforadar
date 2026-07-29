import AVFoundation
import XCTest
@testable import WesterVisitScan

final class BarcodeClassifierTests: XCTestCase {

    // 受け入れ基準3: 実測値 A328913579881A (Codabar) → valid、コアは 328913579881
    func testMeasuredWesterCardIsValid() {
        let result = classifyBarcode(rawText: "A328913579881A", symbology: .codabar)
        XCTAssertEqual(result, .valid(westerID: "328913579881"))
    }

    // ガードは A〜D（大文字・小文字）のいずれの組み合わせでも許容
    func testAllGuardCombinationsAreAccepted() {
        let guards = ["A", "B", "C", "D", "a", "b", "c", "d"]
        for start in guards {
            for stop in guards {
                let result = classifyBarcode(
                    rawText: "\(start)328913579881\(stop)",
                    symbology: .codabar
                )
                XCTAssertEqual(
                    result, .valid(westerID: "328913579881"),
                    "guards \(start)…\(stop) should be valid"
                )
            }
        }
    }

    // 受け入れ基準4: QR / Code128 等の symbology は内容が正しくても対象外
    func testNonCodabarSymbologiesAreRejected() {
        let symbologies: [AVMetadataObject.ObjectType] = [
            .qr, .code128, .ean13, .ean8, .code39, .itf14, .pdf417,
        ]
        for symbology in symbologies {
            let result = classifyBarcode(rawText: "A328913579881A", symbology: symbology)
            XCTAssertEqual(
                result, .reject(reason: .wrongSymbology(symbology.rawValue)),
                "\(symbology.rawValue) should be rejected"
            )
        }
    }

    func testMissingGuardsAreRejected() {
        // ガードなし
        XCTAssertEqual(
            classifyBarcode(rawText: "328913579881", symbology: .codabar),
            .reject(reason: .malformedGuards)
        )
        // 末尾ガードなし
        XCTAssertEqual(
            classifyBarcode(rawText: "A328913579881", symbology: .codabar),
            .reject(reason: .malformedGuards)
        )
        // 先頭ガードなし
        XCTAssertEqual(
            classifyBarcode(rawText: "328913579881A", symbology: .codabar),
            .reject(reason: .malformedGuards)
        )
    }

    func testWrongCoreLengthIsRejected() {
        // 11桁
        XCTAssertEqual(
            classifyBarcode(rawText: "A32891357988A", symbology: .codabar),
            .reject(reason: .wrongLength(11))
        )
        // 13桁
        XCTAssertEqual(
            classifyBarcode(rawText: "A3289135798812A", symbology: .codabar),
            .reject(reason: .wrongLength(13))
        )
        // ガードのみ（コア0桁）
        XCTAssertEqual(
            classifyBarcode(rawText: "AA", symbology: .codabar),
            .reject(reason: .wrongLength(0))
        )
    }

    func testNonNumericCoreIsRejected() {
        // Codabar で許容される記号入り
        XCTAssertEqual(
            classifyBarcode(rawText: "A3289-3579881A", symbology: .codabar),
            .reject(reason: .coreNotNumeric)
        )
        // コア中間にガード文字
        XCTAssertEqual(
            classifyBarcode(rawText: "A32891357988BA", symbology: .codabar),
            .reject(reason: .coreNotNumeric)
        )
        // 全角数字は数字として扱わない
        XCTAssertEqual(
            classifyBarcode(rawText: "A３２８９１３５７９８８１A", symbology: .codabar),
            .reject(reason: .coreNotNumeric)
        )
    }

    func testEmptyAndTooShortAreRejected() {
        XCTAssertEqual(
            classifyBarcode(rawText: "", symbology: .codabar),
            .reject(reason: .malformedGuards)
        )
        XCTAssertEqual(
            classifyBarcode(rawText: "A", symbology: .codabar),
            .reject(reason: .malformedGuards)
        )
    }

    // 将来の厳密化フック: requiredPrefix（テストから注入して検証）
    func testRequiredPrefixHook() {
        XCTAssertEqual(
            classifyBarcode(rawText: "A328913579881A", symbology: .codabar, requiredPrefix: "32"),
            .valid(westerID: "328913579881")
        )
        XCTAssertEqual(
            classifyBarcode(rawText: "A928913579881A", symbology: .codabar, requiredPrefix: "32"),
            .reject(reason: .prefixMismatch)
        )
    }

    // 将来の厳密化フック: checkDigit（テストから注入して検証）
    func testCheckDigitHook() {
        XCTAssertEqual(
            classifyBarcode(
                rawText: "A328913579881A",
                symbology: .codabar,
                checkDigit: { _ in false }
            ),
            .reject(reason: .checkDigitFailed)
        )
        XCTAssertEqual(
            classifyBarcode(
                rawText: "A328913579881A",
                symbology: .codabar,
                checkDigit: { _ in true }
            ),
            .valid(westerID: "328913579881")
        )
    }

    // 既定のルール: 12桁固定、prefix / checkDigit は無効
    func testDefaultRulesAreLengthOnlyAndHooksDisabled() {
        XCTAssertEqual(IDRules.exactLength, 12)
        XCTAssertNil(IDRules.requiredPrefix)
        XCTAssertNil(IDRules.checkDigit)
    }
}
