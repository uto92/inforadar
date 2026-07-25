// JR西日本 主要駅データ
// passengers: 1日平均乗車人員(人/日)。JR西日本公表値(近年度)をもとにした概算値。
// profile: 時間帯変動プロファイルの混合比率(合計1.0)
//   terminal  : 大規模ターミナル(朝夕ピーク+日中・夜間も高水準)
//   commuter  : 住宅地・通勤駅(朝の鋭いピーク+夕方の帰宅ピーク)
//   tourist   : 観光地アクセス駅(昼間中心の山型)
//   nightlife : 繁華街(夕方〜夜にピーク)
//   regional  : 地方中核駅(朝夕ピークのなだらかな二山型)
// spread: ヒートマップの広がりの目安(m)。駅勢圏・市街地の広がりのイメージ。

const STATIONS = [
  // ===== 大阪エリア =====
  { name: "大阪",             lat: 34.7025, lon: 135.4959, passengers: 423000, spread: 700, profile: { terminal: 0.55, nightlife: 0.35, tourist: 0.10 } },
  { name: "新大阪",           lat: 34.7335, lon: 135.5002, passengers: 130000, spread: 450, profile: { terminal: 0.80, tourist: 0.20 } },
  { name: "天王寺",           lat: 34.6476, lon: 135.5137, passengers: 140000, spread: 550, profile: { terminal: 0.55, nightlife: 0.30, tourist: 0.15 } },
  { name: "京橋",             lat: 34.6967, lon: 135.5347, passengers: 130000, spread: 500, profile: { terminal: 0.50, nightlife: 0.40, commuter: 0.10 } },
  { name: "鶴橋",             lat: 34.6656, lon: 135.5306, passengers:  96000, spread: 400, profile: { commuter: 0.55, nightlife: 0.45 } },
  { name: "新今宮",           lat: 34.6497, lon: 135.5010, passengers:  60000, spread: 400, profile: { commuter: 0.45, tourist: 0.35, nightlife: 0.20 } },
  { name: "北新地",           lat: 34.6996, lon: 135.4977, passengers:  45000, spread: 350, profile: { terminal: 0.40, nightlife: 0.60 } },
  { name: "弁天町",           lat: 34.6693, lon: 135.4633, passengers:  33000, spread: 350, profile: { commuter: 0.80, tourist: 0.20 } },
  { name: "西九条",           lat: 34.6828, lon: 135.4665, passengers:  30000, spread: 350, profile: { commuter: 0.60, tourist: 0.40 } },
  { name: "ユニバーサルシティ", lat: 34.6674, lon: 135.4360, passengers:  30000, spread: 400, profile: { tourist: 0.90, nightlife: 0.10 } },
  { name: "吹田",             lat: 34.7645, lon: 135.5240, passengers:  30000, spread: 350, profile: { commuter: 1.0 } },
  { name: "茨木",             lat: 34.8164, lon: 135.5622, passengers:  47000, spread: 400, profile: { commuter: 0.90, nightlife: 0.10 } },
  { name: "高槻",             lat: 34.8510, lon: 135.6220, passengers:  64000, spread: 450, profile: { commuter: 0.85, nightlife: 0.15 } },

  // ===== 神戸・兵庫エリア =====
  { name: "尼崎",             lat: 34.7269, lon: 135.4113, passengers:  45000, spread: 400, profile: { commuter: 0.85, nightlife: 0.15 } },
  { name: "西宮",             lat: 34.7371, lon: 135.3533, passengers:  33000, spread: 350, profile: { commuter: 1.0 } },
  { name: "芦屋",             lat: 34.7325, lon: 135.3021, passengers:  30000, spread: 350, profile: { commuter: 1.0 } },
  { name: "住吉",             lat: 34.7195, lon: 135.2624, passengers:  33000, spread: 350, profile: { commuter: 1.0 } },
  { name: "六甲道",           lat: 34.7146, lon: 135.2373, passengers:  24000, spread: 320, profile: { commuter: 0.90, nightlife: 0.10 } },
  { name: "三ノ宮",           lat: 34.6945, lon: 135.1951, passengers: 120000, spread: 600, profile: { terminal: 0.45, nightlife: 0.40, tourist: 0.15 } },
  { name: "元町",             lat: 34.6890, lon: 135.1877, passengers:  25000, spread: 350, profile: { tourist: 0.45, nightlife: 0.35, commuter: 0.20 } },
  { name: "神戸",             lat: 34.6795, lon: 135.1780, passengers:  67000, spread: 450, profile: { terminal: 0.50, commuter: 0.30, nightlife: 0.20 } },
  { name: "垂水",             lat: 34.6295, lon: 135.0509, passengers:  32000, spread: 350, profile: { commuter: 1.0 } },
  { name: "明石",             lat: 34.6489, lon: 134.9925, passengers:  50000, spread: 400, profile: { commuter: 0.80, regional: 0.20 } },
  { name: "西明石",           lat: 34.6659, lon: 134.9600, passengers:  24000, spread: 320, profile: { commuter: 0.90, terminal: 0.10 } },
  { name: "姫路",             lat: 34.8265, lon: 134.6903, passengers:  48000, spread: 450, profile: { regional: 0.55, tourist: 0.25, nightlife: 0.20 } },

  // ===== 京都・滋賀エリア =====
  { name: "京都",             lat: 34.9858, lon: 135.7588, passengers: 200000, spread: 650, profile: { terminal: 0.45, tourist: 0.45, nightlife: 0.10 } },
  { name: "大津",             lat: 35.0031, lon: 135.8617, passengers:  17000, spread: 300, profile: { commuter: 0.90, tourist: 0.10 } },
  { name: "石山",             lat: 34.9629, lon: 135.9083, passengers:  23000, spread: 320, profile: { commuter: 1.0 } },
  { name: "南草津",           lat: 35.0006, lon: 135.9448, passengers:  30000, spread: 350, profile: { commuter: 1.0 } },
  { name: "草津",             lat: 35.0175, lon: 135.9596, passengers:  30000, spread: 350, profile: { commuter: 0.90, regional: 0.10 } },

  // ===== 奈良・和歌山エリア =====
  { name: "奈良",             lat: 34.6807, lon: 135.8199, passengers:  30000, spread: 400, profile: { tourist: 0.55, commuter: 0.35, regional: 0.10 } },
  { name: "王寺",             lat: 34.5943, lon: 135.7061, passengers:  20000, spread: 300, profile: { commuter: 1.0 } },
  { name: "和歌山",           lat: 34.2330, lon: 135.1916, passengers:  18000, spread: 350, profile: { regional: 0.80, tourist: 0.20 } },
  { name: "関西空港",         lat: 34.4326, lon: 135.2432, passengers:  25000, spread: 450, profile: { tourist: 0.70, terminal: 0.30 } },

  // ===== 岡山・広島・山口エリア =====
  { name: "岡山",             lat: 34.6660, lon: 133.9180, passengers:  60000, spread: 500, profile: { regional: 0.60, terminal: 0.25, nightlife: 0.15 } },
  { name: "倉敷",             lat: 34.5997, lon: 133.7700, passengers:  17000, spread: 320, profile: { regional: 0.60, tourist: 0.40 } },
  { name: "福山",             lat: 34.4900, lon: 133.3620, passengers:  17000, spread: 320, profile: { regional: 0.85, nightlife: 0.15 } },
  { name: "広島",             lat: 34.3979, lon: 132.4754, passengers:  74000, spread: 550, profile: { regional: 0.45, terminal: 0.30, nightlife: 0.25 } },
  { name: "横川",             lat: 34.4116, lon: 132.4426, passengers:  14000, spread: 280, profile: { commuter: 1.0 } },
  { name: "徳山",             lat: 34.0522, lon: 131.8060, passengers:   7000, spread: 260, profile: { regional: 1.0 } },
  { name: "新山口",           lat: 34.0939, lon: 131.3958, passengers:   8000, spread: 280, profile: { regional: 0.80, terminal: 0.20 } },
  { name: "下関",             lat: 33.9500, lon: 130.9239, passengers:   9000, spread: 300, profile: { regional: 0.85, tourist: 0.15 } },

  // ===== 山陰エリア =====
  { name: "鳥取",             lat: 35.4938, lon: 134.2225, passengers:   4000, spread: 260, profile: { regional: 1.0 } },
  { name: "米子",             lat: 35.4285, lon: 133.3319, passengers:   4500, spread: 260, profile: { regional: 1.0 } },
  { name: "松江",             lat: 35.4630, lon: 133.0636, passengers:   5500, spread: 260, profile: { regional: 0.85, tourist: 0.15 } },
  { name: "出雲市",           lat: 35.3620, lon: 132.7570, passengers:   4000, spread: 260, profile: { regional: 0.70, tourist: 0.30 } },

  // ===== 北陸エリア =====
  { name: "敦賀",             lat: 35.6455, lon: 136.0559, passengers:   6000, spread: 280, profile: { regional: 0.70, terminal: 0.30 } },
  { name: "福井",             lat: 36.0622, lon: 136.2233, passengers:  20000, spread: 350, profile: { regional: 0.70, terminal: 0.20, tourist: 0.10 } },
  { name: "金沢",             lat: 36.5780, lon: 136.6478, passengers:  46000, spread: 450, profile: { regional: 0.40, tourist: 0.35, terminal: 0.25 } },
  { name: "富山",             lat: 36.7010, lon: 137.2130, passengers:  15000, spread: 320, profile: { regional: 0.65, terminal: 0.20, tourist: 0.15 } },
];

// 時間帯変動プロファイル(5:00〜24:00、1時間刻み。値は相対値で後で正規化される)
// index 0 = 5時台, 1 = 6時台, ..., 19 = 24時台
const HOURLY_PROFILES = {
  //           5    6    7    8    9    10   11   12   13   14   15   16   17   18   19   20   21   22   23   24
  terminal:  [0.06, 0.18, 0.55, 0.95, 0.70, 0.55, 0.55, 0.60, 0.58, 0.58, 0.62, 0.70, 0.85, 1.00, 0.85, 0.65, 0.55, 0.45, 0.28, 0.10],
  commuter:  [0.08, 0.30, 0.90, 1.00, 0.45, 0.22, 0.20, 0.22, 0.22, 0.24, 0.30, 0.45, 0.65, 0.85, 0.70, 0.50, 0.42, 0.35, 0.20, 0.06],
  tourist:   [0.02, 0.05, 0.15, 0.35, 0.60, 0.85, 0.95, 1.00, 1.00, 0.95, 0.90, 0.80, 0.65, 0.45, 0.30, 0.20, 0.12, 0.08, 0.04, 0.02],
  nightlife: [0.03, 0.05, 0.15, 0.30, 0.25, 0.28, 0.35, 0.50, 0.45, 0.42, 0.45, 0.55, 0.75, 0.95, 1.00, 0.95, 0.90, 0.80, 0.55, 0.25],
  regional:  [0.08, 0.25, 0.70, 0.90, 0.55, 0.45, 0.45, 0.50, 0.48, 0.48, 0.55, 0.65, 0.85, 1.00, 0.75, 0.50, 0.38, 0.28, 0.15, 0.05],
};

// エリアビュー(画面のプリセット)
const AREA_VIEWS = [
  { name: "京阪神",   center: [135.45, 34.78], zoom: 9.6 },
  { name: "大阪",     center: [135.50, 34.69], zoom: 11.5 },
  { name: "神戸",     center: [135.18, 34.69], zoom: 11.5 },
  { name: "京都",     center: [135.76, 34.99], zoom: 11.5 },
  { name: "岡山・広島", center: [133.2, 34.5],  zoom: 8.2 },
  { name: "山陰",     center: [133.6, 35.45],  zoom: 8.2 },
  { name: "北陸",     center: [136.5, 36.2],   zoom: 8.2 },
  { name: "全域",     center: [134.5, 35.1],   zoom: 6.8 },
];
