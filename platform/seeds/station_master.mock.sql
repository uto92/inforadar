-- ============================================================================
--  station_master の【暫定・検証用】データ
--
--  ⚠ ここに入っている area/line/station コードは実在の駅コードではない。
--    tools/lib/encode.mjs が生成する mock HEX と対になるよう作った値であり、
--    「駅名が出る／出ないの経路が end-to-end で通っていること」を確認する
--    ためだけのもの。実運用では正規の対応表（近畿圏優先）を
--      POST /v1/station-master  { "csv": "area,line,station,会社,路線,駅名\n..." }
--    から投入し、このファイルの行は上書き・削除すること。
--
--  未収載のコードは UI にコードのまま表示される（推測で駅名を作らない）。
--  mock には意図的にマスタ未収載の 01-2E-13 が混じっている。
-- ============================================================================

INSERT INTO station_master
  (area_code, line_code, station_code, company_name, line_name, station_name)
VALUES
  ('01', '2E', '01', 'JR西日本',    '大阪環状線', '大阪'),
  ('01', '2E', '05', 'JR西日本',    '大阪環状線', '京橋'),
  ('01', '2E', '0B', 'JR西日本',    '大阪環状線', '天王寺'),
  ('01', '2E', '0F', 'JR西日本',    '大阪環状線', '新今宮'),
  ('01', '30', '03', 'JR西日本',    'JR京都線',   '高槻'),
  ('01', '42', '01', 'Osaka Metro', '御堂筋線',   '梅田'),
  ('01', '42', '07', 'Osaka Metro', '御堂筋線',   'なんば'),
  ('01', '55', '01', '阪急電鉄',    '神戸本線',   '大阪梅田'),
  ('01', '60', '02', '近畿日本鉄道', '奈良線',     '鶴橋')
ON CONFLICT(area_code, line_code, station_code) DO UPDATE SET
  company_name = excluded.company_name,
  line_name    = excluded.line_name,
  station_name = excluded.station_name;
