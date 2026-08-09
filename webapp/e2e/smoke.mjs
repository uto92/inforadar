import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:4180/inforadar/";
const results = [];
const ok = (name, cond) => {
  results.push(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond) process.exitCode = 1;
};

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on("pageerror", (e) => results.push(`PAGEERROR: ${e.message}`));

// 1) イベント選択画面
await page.goto(BASE);
ok("トップにタイトル表示", await page.getByRole("heading", { name: "来場チェックイン" }).first().isVisible());
ok("ローカル保存のみバッジ", await page.getByText("ローカル保存のみ").isVisible());

// 2) イベント登録
await page.getByRole("button", { name: "＋ 新規イベント登録" }).click();
await page.locator("#ev-name").fill("スモークテスト夏祭り");
await page.locator("#ev-venue").fill("テスト駅前広場");
await page.getByRole("button", { name: "登録する" }).click();
await page.getByText("スモークテスト夏祭り").waitFor();
ok("イベントカード表示（本日のイベント）", await page.getByText("本日のイベント").isVisible());

// 3) スキャン画面へ（headlessカメラなし → 起動パネルが出るはず）
await page.getByRole("link", { name: "スキャン開始" }).click();
await page.getByRole("button", { name: "カメラを開始" }).waitFor();
ok("スキャン画面カウンタ=0", (await page.locator(".scan-count-num").innerText()) === "0");

// 4) 手入力チェックイン（末尾6桁）
await page.getByRole("button", { name: "手入力（末尾6桁）" }).click();
await page.locator(".manual-input").fill("579881");
await page.getByRole("button", { name: "チェックイン", exact: true }).click();
await page.locator(".feedback-ok").waitFor();
ok("成功オーバーレイ（緑）表示", await page.locator(".feedback-ok .feedback-title").innerText() === "チェックイン");
await page.locator(".feedback-ok").waitFor({ state: "detached" });
ok("カウンタが1に増加", (await page.locator(".scan-count-num").innerText()) === "1");

// 5) 同一末尾6桁を再入力 → 重複警告 + 別人として記録
await page.getByRole("button", { name: "手入力（末尾6桁）" }).click();
await page.locator(".manual-input").fill("579881");
await page.getByRole("button", { name: "チェックイン", exact: true }).click();
await page.locator(".feedback-duplicate").waitFor();
ok(
  "重複警告（黄）表示",
  (await page.locator(".feedback-duplicate .feedback-title").innerText()).includes("チェックイン済")
);
await page.getByRole("button", { name: "別人として記録する" }).click();
await page.locator(".feedback-ok").waitFor();
await page.locator(".feedback-ok").waitFor({ state: "detached" });
ok("別人として記録 → カウンタ2", (await page.locator(".scan-count-num").innerText()) === "2");
ok("重複件数の表示", (await page.locator(".scan-substats").innerText()).includes("再読取 1"));

// 6) 管理画面
await page.getByRole("link", { name: "管理" }).click();
await page.locator(".stat-hero .value").waitFor();
ok("管理画面の来場者数=2", (await page.locator(".stat-hero .value").innerText()) === "2");
ok("ヒストグラム描画", (await page.locator("svg[role='img']").count()) === 1);
const csvEnabled = await page.getByRole("button", { name: /来場記録CSV/ }).isEnabled();
ok("CSVボタン有効（2件）", csvEnabled);
const dl = page.waitForEvent("download");
await page.getByRole("button", { name: /来場記録CSV/ }).click();
const download = await dl;
const csvPath = await download.path();
const { readFileSync } = await import("node:fs");
const csv = readFileSync(csvPath, "utf-8");
ok("CSVにヘッダとハッシュ列", csv.includes("member_hash") && csv.includes("suffix_hash"));
ok("CSVに生の末尾6桁が含まれない", !csv.includes("579881"));
ok("CSVは2データ行", csv.trim().split("\r\n").length === 3);

// 7) 掲示文
await page.getByRole("link", { name: "受付掲示文を表示" }).click();
await page.locator(".notice-sheet").waitFor();
ok(
  "掲示文にイベント名差し込み",
  await page.getByText("スモークテスト夏祭り", { exact: false }).first().isVisible()
);
ok("掲示文に読み取り目的", await page.getByText("読み取りの目的").isVisible());

// 8) リロード後もデータ保持（IndexedDB永続化）
await page.goto(BASE);
await page.getByText("スモークテスト夏祭り").waitFor();
ok("リロード後もイベント・件数保持", (await page.locator(".event-card-count strong").innerText()) === "2");

await browser.close();
console.log(results.join("\n"));
