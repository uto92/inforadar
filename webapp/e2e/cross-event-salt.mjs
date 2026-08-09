import { chromium } from "playwright-core";
// 同じ来場者が別イベントに来たとき、共通ソルトで同一人物と判定できるかを検証する
const BASE = process.env.BASE_URL ?? "http://localhost:4181/inforadar/";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 120)));
let pass = 0, fail = 0;
const check = (l, a, e) => { if (String(a) === String(e)) { console.log(`  PASS: ${l}`); pass++; } else { console.log(`  FAIL: ${l}（期待 ${e} / 実際 ${a}）`); fail++; } };

async function makeEvent(name) {
  await page.goto(BASE);
  await page.getByRole("button", { name: "＋ 新規イベント登録" }).click();
  await page.locator("#ev-name").fill(name);
  await page.locator("#ev-venue").fill("社内");
  await page.getByRole("button", { name: "登録する" }).click();
  await page.getByText(name).first().waitFor();
}
async function manualCheckin(name, digits) {
  await page.goto(BASE);
  const cards = await page.locator(".card", { hasText: name }).count();
  await page.locator(".card", { hasText: name }).first().getByRole("link", { name: "スキャン開始" }).click();
  const shown = await page.locator(".scan-event-name").innerText().catch(() => "?");
  console.log(`    [debug] 対象=${name} / 一致カード数=${cards} / 開いた画面=${shown}`);
  await page.getByRole("button", { name: "手入力（末尾6桁）" }).click();
  await page.locator("input").first().fill(digits);
  await page.getByRole("button", { name: "チェックイン", exact: true }).click();
  await page.waitForTimeout(1200);
  // 画面ヘッダに常時ある「チェックイン済の再読取」と混同しないよう、
  // 重複警告のオーバーレイの有無とカウンタで判定する
  const dup = await page.locator(".feedback-duplicate").count();
  const count = await page.locator(".scan-count-num").innerText().catch(() => "?");
  return { dup: dup > 0, count };
}

const A = `イベントA-${Date.now()}`, B = `イベントB-${Date.now()}`;
await makeEvent(A);
await makeEvent(B);

// 2つのイベントのソルトが同一か（＝共通ソルトが使われているか）
const salts = await page.evaluate(async () => {
  const req = indexedDB.open("wester-checkin");
  const dbh = await new Promise((res) => { req.onsuccess = () => res(req.result); });
  const tx = dbh.transaction("events", "readonly");
  const all = await new Promise((res) => { const r = tx.objectStore("events").getAll(); r.onsuccess = () => res(r.result); });
  return all.map((e) => e.salt);
});
check("2イベントのソルトが同一", new Set(salts).size, 1);
check("ソルトが空でない", salts[0] && salts[0].length === 32 ? "ok" : "ng", "ok");

// 同じ末尾6桁をA・B両方で記録し、Bでも「新規」として数えられること（別イベントなので重複ではない）
const rA = await manualCheckin(A, "579881");
check("イベントAで新規記録される", `${rA.dup}/${rA.count}`, "false/1");

const rB = await manualCheckin(B, "579881");
check("別イベントBでは重複扱いにならず新規記録される", `${rB.dup}/${rB.count}`, "false/1");

const rA2 = await manualCheckin(A, "579881");
check("同一イベントAの再読取は重複と判定されカウンタが増えない", `${rA2.dup}/${rA2.count}`, "true/1");

// ハッシュが一致するか＝横断分析が可能か
const hashes = await page.evaluate(async () => {
  const req = indexedDB.open("wester-checkin");
  const dbh = await new Promise((res) => { req.onsuccess = () => res(req.result); });
  const tx = dbh.transaction("checkins", "readonly");
  const all = await new Promise((res) => { const r = tx.objectStore("checkins").getAll(); r.onsuccess = () => res(r.result); });
  return all.map((c) => c.suffixHash);
});
check("A・Bのハッシュが一致（横断で同一人物と判定できる）", new Set(hashes).size, 1);

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`);
await browser.close();
process.exitCode = fail === 0 ? 0 : 1;
