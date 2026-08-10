import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
// 各形式のコードをY4M映像にして仮想カメラへ流し、読み取れるかを検証する
const W = 1280, H = 720, FRAMES = 90;
const BASE = process.env.BASE_URL ?? "http://localhost:4181/inforadar/";
const CASES = [
  { label: "Codabar",  file: "codabar", kind: "1d", format: "codabar", value: "A328913579881A" },
  { label: "Code128",  file: "code128", kind: "1d", format: "CODE128", value: "SC1234567890" },
  { label: "EAN-13",   file: "ean13",   kind: "1d", format: "EAN13",   value: "4901777018686" },
  { label: "Code39",   file: "code39",  kind: "1d", format: "CODE39",  value: "ABC123456789" },
  { label: "QRコード", file: "qr",      kind: "qr", value: "MEMBER-9876543210" },
];

const gen = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const gp = await gen.newPage();
await gp.setContent("<canvas id='c'></canvas><canvas id='bar'></canvas><div id='qr'></div>");
await gp.addScriptTag({ path: new URL("../node_modules/", import.meta.url).pathname + "jsbarcode/dist/JsBarcode.all.min.js" });
await gp.addScriptTag({ path: new URL("../node_modules/", import.meta.url).pathname + "qrcode-generator/dist/qrcode.js" });

function y4m(rgbaB64) {
  const rgba = Buffer.from(rgbaB64, "base64");
  const yP = Buffer.alloc(W * H), uP = Buffer.alloc((W/2)*(H/2)), vP = Buffer.alloc((W/2)*(H/2));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y*W+x)*4, r = rgba[i], g = rgba[i+1], b = rgba[i+2];
    yP[y*W+x] = Math.max(16, Math.min(235, Math.round(0.257*r+0.504*g+0.098*b+16)));
    if (y%2===0 && x%2===0) { const ci=(y/2)*(W/2)+x/2;
      uP[ci]=Math.max(16,Math.min(240,Math.round(-0.148*r-0.291*g+0.439*b+128)));
      vP[ci]=Math.max(16,Math.min(240,Math.round(0.439*r-0.368*g-0.071*b+128))); }
  }
  const parts=[Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420\n`)];
  for (let f=0; f<FRAMES; f++) parts.push(Buffer.from("FRAME\n"), yP, uP, vP);
  return Buffer.concat(parts);
}

let pass = 0, fail = 0;
for (const c of CASES) {
  const rgbaB64 = await gp.evaluate(({ W, H, c }) => {
    const cv = document.getElementById("c"); cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0,0,W,H);
    if (c.kind === "1d") {
      const bar = document.getElementById("bar");
      // @ts-ignore
      JsBarcode(bar, c.value, { format: c.format, width: 3, height: 150, displayValue: false, margin: 10 });
      const w = W*0.86, h = (bar.height/bar.width)*w;
      ctx.drawImage(bar, (W-w)/2, (H-h)/2, w, h);
    } else {
      // @ts-ignore
      const q = qrcode(0, "M"); q.addData(c.value); q.make();
      const n = q.getModuleCount(), cell = Math.floor((H*0.7)/n), size = cell*n;
      const ox = (W-size)/2, oy = (H-size)/2;
      ctx.fillStyle = "#000";
      for (let r=0; r<n; r++) for (let col=0; col<n; col++) if (q.isDark(r,col)) ctx.fillRect(ox+col*cell, oy+r*cell, cell, cell);
    }
    const d = ctx.getImageData(0,0,W,H).data;
    let s=""; const ch=8192;
    for (let i=0;i<d.length;i+=ch) s+=String.fromCharCode.apply(null,d.subarray(i,i+ch));
    return btoa(s);
  }, { W, H, c });
  writeFileSync(`mf-${c.file}.y4m`, y4m(rgbaB64));

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
    args: ["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",
           `--use-file-for-fake-video-capture=${process.cwd()}/mf-${c.file}.y4m`],
  });
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera"] });
  const page = await ctx2.newPage();
  await page.goto(BASE);
  const name = `${c.label}-${Date.now()}`;
  await page.getByRole("button", { name: "＋ 新規イベント登録" }).click();
  await page.locator("#ev-name").fill(name);
  await page.locator("#ev-venue").fill("社内");
  await page.getByRole("button", { name: "登録する" }).click();
  await page.getByText(name).first().waitFor();
  await page.locator(".card", { hasText: name }).first().getByRole("link", { name: "スキャン開始" }).click();
  await page.getByRole("button", { name: "カメラを開始" }).click();
  await page.getByRole("button", { name: "読み取り", exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "読み取り", exact: true }).click();
  let ok = false;
  for (let i=0;i<40;i++) { await page.waitForTimeout(250);
    if ((await page.locator(".scan-count-num").innerText().catch(()=> "0")) !== "0") { ok = true; break; } }
  console.log(ok ? `  PASS: ${c.label} を読み取れた` : `  FAIL: ${c.label} を読み取れない`);
  ok ? pass++ : fail++;
  await browser.close();
  try { (await import("node:fs")).unlinkSync(`mf-${c.file}.y4m`); } catch {}
}
await gen.close();
console.log(`\n結果: PASS ${pass} / FAIL ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
