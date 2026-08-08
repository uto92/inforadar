// 2端末での同期検証。別々のブラウザコンテキスト = 別端末（IndexedDBも別）。
// 端末Aで記録したチェックインが、サーバ経由で端末Bに反映されることを確認する。
//
// 使い方（server/ と webapp/ の両方を動かす）:
//   cd server && npm run migrate:local
//   cd server && npx wrangler dev --port 8787 --local \
//     --var DEV_OPEN_WC_SYNC:1 --var ALLOWED_ORIGINS:http://localhost:4180
//   cd webapp && VITE_SYNC_URL=http://localhost:8787 \
//     npx vite build --base=/inforadar/ --outDir <dir>/inforadar --emptyOutDir
//   (<dir> を静的配信して) node e2e/two-device-sync.mjs
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:4180/inforadar/";
const SYNC = process.env.SYNC_URL ?? "http://localhost:8787";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  if (String(actual) === String(expected)) { console.log(`  PASS: ${label}`); pass++; }
  else { console.log(`  FAIL: ${label}（期待 ${expected} / 実際 ${actual}）`); fail++; }
};

async function openDevice(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] PAGEERROR: ${e.message.slice(0, 120)}`));
  await page.goto(BASE);
  return { ctx, page };
}

console.log("1) 端末Aでイベント作成と手入力チェックイン");
const A = await openDevice("A");
await A.page.getByRole("button", { name: "＋ 新規イベント登録" }).click();
const EV_NAME = `同期テスト-${Date.now()}`;
await A.page.locator("#ev-name").fill(EV_NAME);
await A.page.locator("#ev-venue").fill("社内");
await A.page.getByRole("button", { name: "登録する" }).click();
await A.page.getByText(EV_NAME).first().waitFor();

const badge = await A.page.locator(".badge").first().innerText().catch(() => "");
check("同期先が設定され「ローカル保存のみ」でない", badge.includes("ローカル保存のみ") ? "local" : "synced", "synced");

// 他端末ぶんも一覧に並ぶため、対象イベントのカードに限定して押す
await A.page.locator(".card", { hasText: EV_NAME }).getByRole("link", { name: "スキャン開始" }).click();
await A.page.getByRole("button", { name: "手入力（末尾6桁）" }).click();
await A.page.locator("input").first().fill("579881");
await A.page.getByRole("button", { name: "チェックイン", exact: true }).click();
await A.page.waitForTimeout(1500);
check("端末Aのカウンタが1", await A.page.locator(".scan-count-num").innerText(), "1");

console.log("2) サーバに届いているか");
await A.page.waitForTimeout(3000);
const server = await fetch(`${SYNC}/v1/wc/sync`).then((r) => r.json());
// 過去実行のデータが残るため、このテストで作ったイベントに限定して数える
const myEvent = server.events.find((e) => e.name === EV_NAME);
const myCheckins = myEvent ? server.checkins.filter((c) => c.eventId === myEvent.id) : [];
check("サーバにこのイベントが登録された", myEvent ? "あり" : "なし", "あり");
check("このイベントのチェックインが1件", myCheckins.length, 1);
check("サーバに生の末尾6桁が無い", JSON.stringify(server).includes("579881") ? "あり" : "なし", "なし");

console.log("3) 端末Bを開いて他端末ぶんが取り込まれるか");
const B = await openDevice("B");
let bCount = "0";
for (let i = 0; i < 30; i++) {
  await B.page.waitForTimeout(1000);
  await B.page.reload();
  const card = B.page.locator(".card", { hasText: EV_NAME });
  if (await card.count()) {
    const m = /(\d+)/.exec(await card.locator(".event-card-count strong").innerText().catch(() => ""));
    bCount = m ? m[1] : "0";
    if (bCount !== "0") break;
  }
}
check("端末Bに端末Aのイベントが見える", (await B.page.locator("body").innerText()).includes(EV_NAME) ? "見える" : "見えない", "見える");
check("端末Bに端末Aのチェックイン1件が反映", bCount, "1");

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`);
await browser.close();
process.exitCode = fail === 0 ? 0 : 1;
