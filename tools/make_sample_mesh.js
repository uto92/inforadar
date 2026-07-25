#!/usr/bin/env node
// 動作確認用の合成メッシュデータを data/flow_mesh.js に生成する。
// (実データは tools/fetch_mlit_flow.py で取得すると、このファイルを上書きする)
// 駅周辺に1kmメッシュ格子で「昼高・夜低(ターミナル)」「夜高(住宅地)」等の
// もっともらしい滞在人口を合成する。実測値ではない。
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const src = fs.readFileSync(path.join(root, "data", "stations.js"), "utf8");

// stations.js から必要フィールドを抽出
const stations = [];
const re = /name:\s*"([^"]+)",\s*lat:\s*([\d.]+),\s*lon:\s*([\d.]+),\s*passengers:\s*(\d+),\s*spread:\s*(\d+),\s*profile:\s*\{([^}]+)\}/g;
let m;
while ((m = re.exec(src))) {
  const profile = {};
  for (const pm of m[6].matchAll(/(\w+):\s*([\d.]+)/g)) profile[pm[1]] = Number(pm[2]);
  stations.push({ name: m[1], lat: +m[2], lon: +m[3], passengers: +m[4], spread: +m[5], profile });
}
if (!stations.length) throw new Error("stations.js を読めませんでした");

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 1kmメッシュ(3次メッシュ)の中心座標に量子化
const DLAT = 1 / 120, DLON = 1 / 80;
const snap = (lat, lon) => [
  Math.floor(lat / DLAT) * DLAT + DLAT / 2,
  Math.floor(lon / DLON) * DLON + DLON / 2,
];

// タイプ別の 昼(11-15時)/深夜(1-5時) 滞在人口係数(平日, 休日)
const F = {
  terminal:  { wd: 1.0, wn: 0.12, hd: 0.75, hn: 0.12 },
  commuter:  { wd: 0.45, wn: 0.85, hd: 0.60, hn: 0.90 }, // 住宅地: 夜間人口が多い
  tourist:   { wd: 0.85, wn: 0.10, hd: 1.10, hn: 0.12 },
  nightlife: { wd: 0.70, wn: 0.18, hd: 0.65, hn: 0.20 },
  regional:  { wd: 0.80, wn: 0.45, hd: 0.65, hn: 0.48 },
};

const cellMap = new Map();
stations.forEach((st, si) => {
  const rnd = mulberry32(4000 + si * 104729);
  const scale = Math.pow(st.passengers, 0.78) * 0.9; // 滞在人口スケール(合成)
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = rnd(); while (!v) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const co = { wd: 0, wn: 0, hd: 0, hn: 0 };
  for (const [k, w] of Object.entries(st.profile))
    for (const key of Object.keys(co)) co[key] += w * F[k][key];

  const nDrops = 400;
  for (let i = 0; i < nDrops; i++) {
    const spreadDeg = (st.spread * 2.2) / 111320;
    const lat = st.lat + gauss() * spreadDeg;
    const lon = st.lon + gauss() * spreadDeg / Math.cos(st.lat * Math.PI / 180);
    const [clat, clon] = snap(lat, lon);
    const key = clat.toFixed(5) + "," + clon.toFixed(5);
    let c = cellMap.get(key);
    if (!c) { c = { lat: +clat.toFixed(5), lon: +clon.toFixed(5), wd: 0, wn: 0, hd: 0, hn: 0 }; cellMap.set(key, c); }
    const drop = scale / nDrops;
    c.wd += drop * co.wd * (0.7 + 0.6 * rnd());
    c.wn += drop * co.wn * (0.7 + 0.6 * rnd());
    c.hd += drop * co.hd * (0.7 + 0.6 * rnd());
    c.hn += drop * co.hn * (0.7 + 0.6 * rnd());
  }
});

const cells = [...cellMap.values()]
  .map(c => ({ ...c, wd: Math.round(c.wd), wn: Math.round(c.wn), hd: Math.round(c.hd), hn: Math.round(c.hn) }))
  .filter(c => Math.max(c.wd, c.wn, c.hd, c.hn) >= 30)
  .sort((a, b) => Math.max(b.wd, b.hd) - Math.max(a.wd, a.hd));

const meta = {
  source: "synthetic-sample",
  sourceName: "合成サンプル(動作確認用・実測値ではありません)",
  note: "tools/fetch_mlit_flow.py を実行すると実データに置き換わります",
  cellCount: cells.length,
};

const out = [
  "// 動作確認用の合成サンプルデータ(実測値ではありません)。",
  "// tools/fetch_mlit_flow.py を実行すると、国交省 全国の人流オープンデータから",
  "// 生成した実データでこのファイルが上書きされます。",
  `const FLOW_MESH = {`,
  `  meta: ${JSON.stringify(meta)},`,
  "  // wd=平日昼(11-15時), wn=平日深夜(1-5時), hd=休日昼, hn=休日深夜 [人]",
  "  cells: [",
  ...cells.map(c => `    ${JSON.stringify(c)},`),
  "  ],",
  "};",
  "",
].join("\n");

fs.writeFileSync(path.join(root, "data", "flow_mesh.js"), out);
console.log(`data/flow_mesh.js に ${cells.length} メッシュを書き出しました(合成サンプル)`);
