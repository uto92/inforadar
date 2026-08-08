import qrcode from "qrcode-generator";

/// QRの表示のみ（読取はしない）。2台目はiPhone標準のカメラでこれを読む。
/// アプリ側にQR読取を持たせずに済むため、読取ライブラリは1次元専用のままでよい。

export default function QrCode({ text, size = 240 }: { text: string; size?: number }) {
  // 型番0 = 内容量に応じて自動選択。誤り訂正Mは印刷・画面表示の両方で実用的
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  // 静止領域（クワイエットゾーン）。これが無いと読み取り率が落ちる
  const margin = 4;
  const total = count + margin * 2;

  const cells: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        cells.push(`M${col + margin},${row + margin}h1v1h-1z`);
      }
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label="他の端末で読み取るQRコード"
      style={{ display: "block", background: "#ffffff" }}
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={cells.join("")} fill="#1a1a1c" />
    </svg>
  );
}
