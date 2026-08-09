/**
 * サイバネ規格 16バイト履歴ブロックの「組み立て側」。
 *
 * パーサ（src/parser）の逆向きの処理をここに1つだけ置き、mock 生成ツールと
 * テストの両方から使う。実装が2つに分かれると、パーサのバグをテストが
 * 同じバグで打ち消してしまうため、生成側は必ずここを共有すること。
 *
 * このファイルは Node からも Workers ランタイム（テスト）からも import される。
 * process / fs などのランタイム依存物をここに書かないこと。
 */

/**
 * 駅コードの暫定値。seeds/station_master.mock.sql と対になっている。
 * 実在の駅コードを検証したものではない（README の注意書きを参照）。
 */
export const STATIONS = {
  osaka: { line: 0x2e, station: 0x01 },
  kyobashi: { line: 0x2e, station: 0x05 },
  tennoji: { line: 0x2e, station: 0x0b },
  shinimamiya: { line: 0x2e, station: 0x0f },
  takatsuki: { line: 0x30, station: 0x03 },
  umeda_metro: { line: 0x42, station: 0x01 },
  namba_metro: { line: 0x42, station: 0x07 },
  /** マスタ未収載の駅（UI で「コードのまま表示」になることの確認用） */
  unmapped: { line: 0x2e, station: 0x13 },
};

/** 近畿。v1 パーサはリージョンコードをそのまま area_code として使う */
export const REGION_KINKI = 0x01;

export const PROC = {
  fare: 0x01, // 運賃支払
  charge: 0x02, // チャージ
  retail: 0x46, // 物販(70)
};

/** 未使用ブロック（カードの空き枠） */
export const BLANK_BLOCK = "0".repeat(32);

/**
 * 16バイト履歴ブロックを組み立てて 32桁の大文字HEX を返す。
 * date は UTC のフィールドを見る（日付だけを詰めるため）。
 */
export function encodeHistoryBlock({
  terminalType = 0x16,
  procType,
  paymentType = 0x00,
  entryExitType = 0x01,
  date,
  entry = null,
  exit = null,
  balance,
  seq,
  region = REGION_KINKI,
}) {
  const b = new Uint8Array(16);
  b[0] = terminalType;
  b[1] = procType;
  b[2] = paymentType;
  b[3] = entryExitType;

  // 年月日: YYYYYYYM MMMDDDDD（年は2000年からのオフセット）
  const bits =
    (((date.getUTCFullYear() - 2000) & 0x7f) << 9) |
    (((date.getUTCMonth() + 1) & 0x0f) << 5) |
    (date.getUTCDate() & 0x1f);
  b[4] = (bits >> 8) & 0xff;
  b[5] = bits & 0xff;

  b[6] = entry ? entry.line : 0x00;
  b[7] = entry ? entry.station : 0x00;
  b[8] = exit ? exit.line : 0x00;
  b[9] = exit ? exit.station : 0x00;

  // 残額はリトルエンディアン
  b[10] = balance & 0xff;
  b[11] = (balance >> 8) & 0xff;

  b[12] = (seq >> 16) & 0xff;
  b[13] = (seq >> 8) & 0xff;
  b[14] = seq & 0xff;
  b[15] = region;

  return [...b].map((v) => v.toString(16).toUpperCase().padStart(2, "0")).join("");
}

/**
 * 通勤（大阪⇄京橋）を軸に、たまに寄り道・チャージ・物販が混じる履歴を作る。
 * 返り値は実カードに合わせて新しい順（index 0 が最新）。
 */
export function buildMockHistory({
  records = 12,
  startSeq = 1000,
  startBalance = 5000,
  startDate = new Date(Date.now() - 30 * 86400_000),
  blankCount = null,
} = {}) {
  const trips = [
    { entry: STATIONS.osaka, exit: STATIONS.kyobashi, fare: 170 },
    { entry: STATIONS.kyobashi, exit: STATIONS.osaka, fare: 170 },
    { entry: STATIONS.osaka, exit: STATIONS.tennoji, fare: 210 },
    { entry: STATIONS.tennoji, exit: STATIONS.shinimamiya, fare: 130 },
    { entry: STATIONS.umeda_metro, exit: STATIONS.namba_metro, fare: 240 },
    { entry: STATIONS.osaka, exit: STATIONS.takatsuki, fare: 400 },
    { entry: STATIONS.osaka, exit: STATIONS.unmapped, fare: 190 },
  ];

  const out = [];
  let balance = startBalance;
  let seq = startSeq;
  const date = new Date(startDate.getTime());

  for (let i = 0; i < records; i += 1) {
    if (i % 2 === 0) date.setUTCDate(date.getUTCDate() + 1);

    if (i > 0 && i % 5 === 0) {
      // チャージ。残額が増えるので amount_estimated は負になる
      balance += 3000;
      out.push(
        encodeHistoryBlock({
          procType: PROC.charge,
          terminalType: 0x05,
          entryExitType: 0x02,
          date: new Date(date),
          entry: STATIONS.osaka,
          exit: STATIONS.osaka,
          balance,
          seq: seq++,
        }),
      );
      continue;
    }
    if (i > 0 && i % 7 === 0) {
      // 物販。offset 6-7 は時刻、8-9 は店舗コードなので駅として解釈させない
      balance -= 320;
      out.push(
        encodeHistoryBlock({
          procType: PROC.retail,
          terminalType: 0xc7,
          entryExitType: 0x00,
          date: new Date(date),
          entry: { line: 0x12, station: 0x30 },
          exit: { line: 0x01, station: 0x0a },
          balance,
          seq: seq++,
        }),
      );
      continue;
    }

    const trip = trips[i % trips.length];
    balance -= trip.fare;
    out.push(
      encodeHistoryBlock({
        procType: PROC.fare,
        date: new Date(date),
        entry: trip.entry,
        exit: trip.exit,
        balance,
        seq: seq++,
      }),
    );
  }

  out.reverse();

  const blanks = blankCount ?? Math.max(0, 20 - out.length);
  for (let i = 0; i < blanks; i += 1) out.push(BLANK_BLOCK);

  return out;
}
