import { chromium } from "playwright-core";

// 招待リンクによるソルト共有の検証。
// 端末Aのイベントを端末Bへ引き渡し、Bでも「読み取り」ができることを確認する。
// 使い方は e2e/two-device-sync.mjs と同じ（Worker + 同期URL付きビルドが必要）
//   npm run test:join
const BASE = process.env.BASE_URL ?? "http://localhost:4180/inforadar/";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
let pass = 0, fail = 0;
const check = (l, a, e) => {
  if (String(a) === String(e)) { console.log(`  PASS: ${l}`); pass++; }
  else { console.log(`  FAIL: ${l}（期待 ${e} / 実際 ${a}）`); fail++; }
};
const open = async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  PAGEERROR:", e.message.slice(0, 120)));
  await page.goto(BASE);
  return page;
};

const EV = `引継テスト-${Date.now()}`;
console.log("1) 端末Aでイベント作成");
const A = await open();
await A.getByRole("button", { name: "＋ 新規イベント登録" }).click();
await A.locator("#ev-name").fill(EV);
await A.locator("#ev-venue").fill("社内");
await A.getByRole("button", { name: "登録する" }).click();
await A.getByText(EV).first().waitFor();
await A.locator(".card", { hasText: EV }).getByRole("link", { name: "管理" }).click();
await A.getByRole("button", { name: "他の端末を追加する" }).click();
const qrShown = await A.locator("svg[aria-label]").count();
check("QRが表示される", qrShown > 0 ? "表示" : "なし", "表示");

// QR画像そのものは読めないため、同一のリンクを生成する「リンクをコピー」経由で取得する
await A.context().grantPermissions(["clipboard-read", "clipboard-write"]);
await A.getByRole("button", { name: "リンクをコピー" }).click();
await A.waitForTimeout(500);
const copied = await A.evaluate(() => navigator.clipboard.readText());
check("リンクがコピーできる", copied.includes("#/join?") ? "取得" : "失敗", "取得");
check("リンクにソルトが含まれる", /[?&]s=[0-9a-f]{32}/.test(copied) ? "あり" : "なし", "あり");
check("ソルトはフラグメント側にある（サーバに送信されない）",
  copied.indexOf("#") < copied.indexOf("s=") ? "内側" : "外側", "内側");

console.log("2) 端末Bでリンクを開く");
const B = await open();
await B.goto(copied.replace("http://localhost:4180", new URL(BASE).origin));
await B.getByText("この端末で受付できます").waitFor({ timeout: 15000 });
check("引き継ぎ画面が出る", "ok", "ok");
await B.getByRole("button", { name: "スキャンを開始" }).click();
await B.waitForTimeout(1000);

console.log("3) 端末Bで手入力チェックイン（同じソルトで記録されるか）");
await B.getByRole("button", { name: "手入力（末尾6桁）" }).click();
await B.locator("input").first().fill("579881");
await B.getByRole("button", { name: "チェックイン", exact: true }).click();
await B.waitForTimeout(1500);
check("端末Bで記録できる", await B.locator(".scan-count-num").innerText(), "1");

console.log("4) 端末Aでも同じ来場者が重複扱いになるか（ソルト一致の確認）");
await A.goto(BASE);
await A.waitForTimeout(3000);
await A.locator(".card", { hasText: EV }).getByRole("link", { name: "スキャン開始" }).click();
await A.getByRole("button", { name: "手入力（末尾6桁）" }).click();
await A.locator("input").first().fill("579881");
await A.getByRole("button", { name: "チェックイン", exact: true }).click();
await A.waitForTimeout(1500);
const body = await A.locator("body").innerText();
check("端末Aで同一人物が重複と判定される",
  body.includes("チェックイン済") ? "重複" : "新規", "重複");

// 受付場所の刻印は「取り込みが成立した経路」でだけ行われること。
// 拒否したリンクの p= を先に紐づけてしまうと、以後この端末の読取すべてに
// 拒否したはずの場所が刻まれる（レビュー指摘 minor）。
console.log("5) 拒否されたリンクの場所は紐づかない");
const eventId = new URL(copied.split("#")[1].replace("/join", ""), "http://x").searchParams.get("e");
const PLACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
// 端末Bは既に本物のソルトで取り込み済み。別ソルト＋場所つきのリンクを開かせる
const tampered = copied.replace(/([?&]s=)[0-9a-f]{32}/, "$1" + "f".repeat(32)) + `&p=${PLACE}`;
const devicePlace = (page, ev) =>
  page.evaluate(
    (ev) =>
      new Promise((resolve) => {
        const req = indexedDB.open("wester-checkin");
        req.onsuccess = () => {
          const g = req.result.transaction("meta", "readonly").objectStore("meta")
            .get(`devicePlace:${ev}`);
          g.onsuccess = () => resolve(g.result ? g.result.value : null);
          g.onerror = () => resolve("READ_ERROR");
        };
        req.onerror = () => resolve("OPEN_ERROR");
      }),
    ev
  );

check("前提: まだ場所は紐づいていない", await devicePlace(B, eventId), null);
await B.goto(tampered.replace("http://localhost:4180", new URL(BASE).origin));
await B.getByText("取り込めませんでした").waitFor({ timeout: 15000 });
check("別ソルトのリンクは拒否される", "拒否", "拒否");
check("拒否したリンクの場所は刻印されない", await devicePlace(B, eventId), null);

// 正しいソルト＋場所つきなら紐づくこと（上の検査が「常にnull」ではないことの確認）
await B.goto((copied + `&p=${PLACE}`).replace("http://localhost:4180", new URL(BASE).origin));
await B.getByText("この端末で受付できます").waitFor({ timeout: 15000 });
check("正しいリンクなら場所が紐づく", await devicePlace(B, eventId), PLACE);

console.log(`\n結果: PASS ${pass} / FAIL ${fail}`);
await browser.close();
process.exitCode = fail === 0 ? 0 : 1;
