import Foundation

/// CSVフォールバック出力。通信不能な環境でも共有シート経由でデータを持ち出せる。
/// westerId 列は保存値（= `transformID` 適用済み）をそのまま出力する。
enum CSVExporter {
    static let header = "wester_id,scanned_at,event,location,session_id,device_id"

    static func csv(records: [ScanRecord]) -> String {
        var lines = [header]
        lines.reserveCapacity(records.count + 1)
        for record in records {
            let fields = [
                record.westerId,
                record.scannedAt,
                record.eventName,
                record.locationName,
                record.sessionId.uuidString.lowercased(),
                record.deviceId.uuidString.lowercased(),
            ]
            lines.append(fields.map(escape).joined(separator: ","))
        }
        // BOM付きUTF-8: Excelでの文字化け対策
        return "\u{FEFF}" + lines.joined(separator: "\r\n") + "\r\n"
    }

    static func writeTempFile(records: [ScanRecord], label: String) throws -> URL {
        let stamp = fileStampFormatter.string(from: Date())
        let safeLabel = label.isEmpty ? "all" : label.replacingOccurrences(
            of: "[/\\\\:*?\"<>|\\s]",
            with: "_",
            options: .regularExpression
        )
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("wester_\(safeLabel)_\(stamp).csv")
        try Data(csv(records: records).utf8).write(to: url, options: .atomic)
        return url
    }

    private static func escape(_ field: String) -> String {
        if field.contains(",") || field.contains("\"") || field.contains("\n") || field.contains("\r") {
            return "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return field
    }

    private static let fileStampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd_HHmmss"
        return formatter
    }()
}
