import { describe, expect, it } from "vitest";
import { PARSER_VERSION, normalizeHex, parseHistoryBlock } from "../src/parser";
import { PROC, REGION_KINKI, STATIONS, encodeHistoryBlock } from "../tools/lib/encode.mjs";

describe("parseHistoryBlock", () => {
  it("組み立てた履歴ブロックを往復で復元できる", () => {
    const hex = encodeHistoryBlock({
      procType: PROC.fare,
      date: new Date(Date.UTC(2026, 7, 9)), // 2026-08-09
      entry: STATIONS.osaka,
      exit: STATIONS.kyobashi,
      balance: 4830,
      seq: 1234,
    });

    const result = parseHistoryBlock(hex);
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;

    expect(result.value).toMatchObject({
      usedDate: "2026-08-09",
      procType: PROC.fare,
      balance: 4830,
      seq: 1234,
      regionCode: REGION_KINKI,
      entryStationCode: "01-2E-01",
      exitStationCode: "01-2E-05",
    });
  });

  it("残額をリトルエンディアンで読む", () => {
    // 10000円 = 0x2710 → バイト列は 10 27 の順に入る
    const hex = encodeHistoryBlock({
      procType: PROC.fare,
      date: new Date(Date.UTC(2026, 0, 1)),
      entry: STATIONS.osaka,
      exit: STATIONS.osaka,
      balance: 10000,
      seq: 1,
    });
    expect(hex.slice(20, 24)).toBe("1027");

    const result = parseHistoryBlock(hex);
    expect(result.kind === "transaction" && result.value.balance).toBe(10000);
  });

  it("年月日ビットの境界（月末・年またぎ）を復元できる", () => {
    for (const [year, month, day] of [
      [2026, 1, 1],
      [2026, 12, 31],
      [2031, 2, 28],
    ] as const) {
      const hex = encodeHistoryBlock({
        procType: PROC.fare,
        date: new Date(Date.UTC(year, month - 1, day)),
        entry: STATIONS.osaka,
        exit: STATIONS.kyobashi,
        balance: 1000,
        seq: 5,
      });
      const result = parseHistoryBlock(hex);
      expect(result.kind === "transaction" && result.value.usedDate).toBe(
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      );
    }
  });

  it("全0のブロックは未使用枠として blank になる", () => {
    expect(parseHistoryBlock("0".repeat(32))).toEqual({ kind: "blank" });
  });

  it("物販は入出場駅として解釈しない（offset 6-7 は時刻のため）", () => {
    const hex = encodeHistoryBlock({
      procType: PROC.retail,
      terminalType: 0xc7,
      date: new Date(Date.UTC(2026, 7, 9)),
      entry: { line: 0x12, station: 0x30 },
      exit: { line: 0x01, station: 0x0a },
      balance: 2000,
      seq: 9,
    });
    const result = parseHistoryBlock(hex);
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;
    expect(result.value.entryStationCode).toBeNull();
    expect(result.value.exitStationCode).toBeNull();
    expect(result.value.balance).toBe(2000);
  });

  it("日付ビットが空でもレコード自体は捨てない", () => {
    const hex = `1601000100002E012E05102700000101`;
    const result = parseHistoryBlock(hex);
    expect(result.kind).toBe("transaction");
    expect(result.kind === "transaction" && result.value.usedDate).toBeNull();
  });

  it("長さ違い・非HEXは理由付きで unparsable になる（例外にしない）", () => {
    expect(parseHistoryBlock("DEADBEEF")).toEqual({
      kind: "unparsable",
      reason: "unexpected_length:4bytes",
    });
    expect(parseHistoryBlock("ZZZZ")).toEqual({ kind: "unparsable", reason: "not_hex" });
    expect(parseHistoryBlock("")).toEqual({ kind: "unparsable", reason: "not_hex" });
  });

  it("空白・区切り付きのHEXを正規化できる", () => {
    expect(normalizeHex("16 01 00 01")).toBe("16010001");
    expect(normalizeHex("16-01:00-01")).toBe("16010001");
    expect(normalizeHex("16010")).toBeNull();
  });

  it("parser_version は derived に必ず記録される値と一致する", () => {
    expect(PARSER_VERSION).toBe("cybernetics-v1");
  });
});
