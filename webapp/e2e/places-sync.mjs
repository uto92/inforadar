// 場所（DESIGN.md Phase 1）の同期検証。
//
// 使い方は e2e/two-device-sync.mjs と同じ（Worker + 同期URL付きビルドが必要）:
//   cd server && npx wrangler dev --port 8787 --local \
//     --var DEV_OPEN_WC_SYNC:1 --var ALLOWED_ORIGINS:http://localhost:4180
//   node e2e/places-sync.mjs
//
// 2つを見る:
//   1) 場所が端末A→サーバ→端末B へ渡り、未同期バッジが残らないこと
//   2) push応答を待っている間の編集が失われないこと（レビュー指摘 minor）
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:4180/inforadar/";
const SYNC = process.env.SYNC_URL ?? "http://localhost:8787";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
let pass = 0,
  fail = 0;
const check = (label, actual, expected) => {
  if (String(actual) === String(expected)) {
    console.log(`  PASS: ${label}`);
    pass++;
  } else {
    console.log(`  FAIL: ${label}（期待 ${expected} / 実際 ${actual}）`);
    fail++;
  }
};

async function openDevice(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${name}] PAGEERROR: ${e.message.slice(0, 120)}`));
  await page.goto(BASE);
  return page;
}

/** 管理画面を開く。イベントが無ければ作る */
async function openAdmin(page, eventName) {
  await page.getByRole("button", { name: "＋ 新規イベント登録" }).click();
  await page.locator("#ev-name").fill(eventName);
  await page.locator("#ev-venue").fill("社内");
  await page.getByRole("button", { name: "登録する" }).click();
  await page.getByText(eventName).first().waitFor();
  await page.locator(".card", { hasText: eventName }).getByRole("link", { name: "管理" }).click();
  await page.getByRole("heading", { name: "場所", exact: true }).waitFor();
}

/** サーバ上の場所を名前で引く */
async function serverPlace(name) {
  const res = await fetch(`${SYNC}/v1/wc/sync`, { headers: { Origin: new URL(BASE).origin } });
  const body = await res.json();
  return (body.places ?? []).find((p) => p.name === name) ?? null;
}

const STAMP = Date.now();
const PLACE = `中央改札前-${STAMP}`;

console.log("1) 端末Aで場所を登録し、サーバへ届くか");
const A = await openDevice("A");
await openAdmin(A, `場所テスト-${STAMP}`);
await A.locator("#new-place").fill(PLACE);
await A.getByRole("button", { name: "追加する", exact: true }).click();
await A.locator("li", { hasText: PLACE }).waitFor();
await A.waitForTimeout(3000);

const onServer = await serverPlace(PLACE);
check("サーバに場所が登録された", onServer ? "あり" : "なし", "あり");
check("セルフ受付は初期値のまま無効", onServer?.selfEnabled, 0);

// pushPlaces を持つ同期先では、場所を送り切れば未同期は0に戻る。
// （持たない同期先で「未同期N件」が消えない問題は engine.ts 側で除外して対処）
const badge = await A.locator("body").innerText();
check("未同期バッジが残らない", /未同期\s*\d+\s*件/.test(badge) ? "残る" : "無い", "無い");

console.log("2) 端末Bに場所が反映されるか");
const B = await openDevice("B");
await B.waitForTimeout(4000);
await B.reload();
await B.waitForTimeout(2000);
const seenByB = await B.evaluate(
  (nm) =>
    new Promise((resolve) => {
      const req = indexedDB.open("wester-checkin");
      req.onsuccess = () => {
        const all = req.result.transaction("places", "readonly").objectStore("places").getAll();
        all.onsuccess = () => resolve(all.result.some((p) => p.name === nm) ? "あり" : "なし");
        all.onerror = () => resolve("READ_ERROR");
      };
      req.onerror = () => resolve("OPEN_ERROR");
    }),
  PLACE
);
check("端末Bに端末Aの場所が反映", seenByB, "あり");

console.log("3) push応答を待つ間の編集が失われないか");
// 場所は可変（name / selfEnabled）。push を投げてから応答が返るまでの間に
// ユーザーが同じ行を編集すると、その編集は未送信のまま synced:1 で潰され、
// 直後の pull で古い値へ巻き戻る——という取りこぼしを再現する。
const C = await openDevice("C");
await openAdmin(C, `編集競合テスト-${STAMP}`);

// places を含む push だけを遅らせる。その隙にセルフ受付を切り替える
let delayed = 0;
await C.route("**/v1/wc/sync", async (route) => {
  const req = route.request();
  if (req.method() === "POST" && (req.postData() ?? "").includes('"places"')) {
    delayed += 1;
    await new Promise((r) => setTimeout(r, 5000));
  }
  await route.continue();
});

const RACE = `競合ブース-${STAMP}`;
await C.locator("#new-place").fill(RACE);
await C.getByRole("button", { name: "追加する", exact: true }).click();
await C.locator("li", { hasText: RACE }).waitFor();
// push が飛んで応答待ちに入るのを待ってから編集する
await C.waitForTimeout(1200);
check("places の push が遅延された", delayed > 0 ? "された" : "されない", "された");

const row = C.locator("li", { hasText: RACE });
// チェックボックスは Dexie の値で制御されるため、クリック直後は前の値に戻る。
// 反映されるまで待ってから次へ進む
const waitChecked = async (want, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await row.getByRole("checkbox").isChecked()) === want) return want;
    if (Date.now() > until) return !want;
    await C.waitForTimeout(250);
  }
};
await row.getByRole("checkbox").click();
check("編集直後はセルフ受付が有効", await waitChecked(true, 5000), true);

// 遅延した push の完了 → 次の push → pull が一巡するまで待つ
await C.waitForTimeout(12000);
check(
  "応答待ち中の編集が巻き戻らない",
  await row.getByRole("checkbox").isChecked(),
  true
);
const raced = await serverPlace(RACE);
check("編集がサーバにも反映される", raced?.selfEnabled, 1);

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`);
await browser.close();
process.exitCode = fail === 0 ? 0 : 1;
