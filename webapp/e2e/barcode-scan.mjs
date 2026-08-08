// 実バーコードの読取総合テスト。
// Codabarバーコードから Y4M 映像を生成し、Chromium の仮想カメラに流し込んで
// アプリが実際にチェックインを成立させるところまで検証する。
// html5-qrcode が Codabar を読めずスキャンが全く動かなかった不具合の再発防止。
//
// 使い方:
//   npm run build:pages
//   (別ターミナルで) docs/ を /inforadar/ 配下に配信する静的サーバを起動
//   BASE_URL=http://localhost:4180/inforadar/ node e2e/barcode-scan.mjs
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4180/inforadar/";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const JSBARCODE = resolve(HERE, "../node_modules/jsbarcode/dist/JsBarcode.all.min.js");

const W = 640, H = 480, FRAMES = 90;
const CODE = "A328913579881A";           // ガード除去後 328913579881 = 12桁
const EXPECT_SUFFIX = "579881";

// 1) バーコード画像をブラウザで生成し、生のRGBAを取り出す
const gen = await chromium.launch({ executablePath: CHROMIUM });
const gp = await gen.newPage();
await gp.setContent("<canvas id='c'></canvas><canvas id='bar'></canvas>");
await gp.addScriptTag({ path: JSBARCODE });
const rgbaB64 = await gp.evaluate(
  ({ W, H, CODE }) => {
    const bar = document.getElementById("bar");
    // @ts-ignore
    JsBarcode(bar, CODE, { format: "codabar", width: 3, height: 150, displayValue: false, margin: 10 });
    const c = document.getElementById("c");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    const w = W * 0.86, h = (bar.height / bar.width) * w;
    ctx.drawImage(bar, (W - w) / 2, (H - h) / 2, w, h);
    const d = ctx.getImageData(0, 0, W, H).data;
    let s = ""; const chunk = 8192;
    for (let i = 0; i < d.length; i += chunk) s += String.fromCharCode.apply(null, d.subarray(i, i + chunk));
    return btoa(s);
  },
  { W, H, CODE }
);
await gen.close();

// 2) RGBA -> I420 -> Y4M
const rgba = Buffer.from(rgbaB64, "base64");
const yP = Buffer.alloc(W * H), uP = Buffer.alloc((W / 2) * (H / 2)), vP = Buffer.alloc((W / 2) * (H / 2));
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    yP[y * W + x] = Math.max(16, Math.min(235, Math.round(0.257 * r + 0.504 * g + 0.098 * b + 16)));
    if (y % 2 === 0 && x % 2 === 0) {
      const ci = (y / 2) * (W / 2) + x / 2;
      uP[ci] = Math.max(16, Math.min(240, Math.round(-0.148 * r - 0.291 * g + 0.439 * b + 128)));
      vP[ci] = Math.max(16, Math.min(240, Math.round(0.439 * r - 0.368 * g - 0.071 * b + 128)));
    }
  }
}
const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420\n`)];
for (let f = 0; f < FRAMES; f++) parts.push(Buffer.from("FRAME\n"), yP, uP, vP);
writeFileSync(resolve(HERE, "card.y4m"), Buffer.concat(parts));
console.log("バーコード映像を生成:", CODE);

// 3) その映像を仮想カメラとしてアプリを動かす
const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${resolve(HERE, "card.y4m")}`,
  ],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera"] });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 120)));
await page.goto(BASE_URL);
await page.getByRole("button", { name: "＋ 新規イベント登録" }).click();
await page.locator("#ev-name").fill("実読取テスト");
await page.locator("#ev-venue").fill("社内");
await page.getByRole("button", { name: "登録する" }).click();
await page.getByText("実読取テスト").first().waitFor();
await page.getByRole("link", { name: "スキャン開始" }).click();
await page.getByRole("button", { name: "カメラを開始" }).click();

// 「読み取り」を押さない限り記録されないこと（勝手に読み続けない）
await page.getByRole("button", { name: "読み取り", exact: true }).waitFor({ timeout: 20000 });
await page.waitForTimeout(4000);
const idleCount = await page.locator(".scan-count-num").innerText().catch(() => "?");
if (idleCount !== "0") {
  console.log(`FAIL: ボタン未押下で ${idleCount} 件記録された（自動読取が止まっていない）`);
  await browser.close();
  process.exit(1);
}
console.log("ボタン未押下では記録なし → PASS");

// ここから「読み取り」押下で読む
await page.getByRole("button", { name: "読み取り", exact: true }).click();

let ok = false;
let sawSuffix = false;
// 成功表示は900msで自動的に消えるため、細かい間隔で監視する
for (let i = 0; i < 100; i++) {
  const body = await page.locator("body").innerText().catch(() => "");
  if (body.includes(EXPECT_SUFFIX)) sawSuffix = true;
  const cnt = await page.locator(".scan-count-num").innerText().catch(() => "0");
  if (cnt !== "0") {
    console.log(`${((i + 1) * 0.2).toFixed(1)}秒以内に読取成功 → カウンタ ${cnt} 人`);
    ok = true;
    break;
  }
  await page.waitForTimeout(200);
}
if (!ok) console.log("FAIL: 20秒経過しても読み取れなかった");
else console.log(`末尾6桁 ${EXPECT_SUFFIX} の表示: ${sawSuffix ? "確認" : "未確認（表示は900msで消えるため取りこぼす場合あり）"}`);
process.exitCode = ok ? 0 : 1;
await page.screenshot({ path: resolve(HERE, "barcode-scan.png") });
await browser.close();
