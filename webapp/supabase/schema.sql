-- WESTER来場チェックイン: Supabaseテーブル定義 + RLS
-- SupabaseダッシュボードのSQL Editorにそのまま貼り付けて実行する。

create table public.events (
  id         uuid primary key,           -- クライアント生成（オフライン作成対応）
  name       text not null,
  event_date date not null,
  venue      text not null,
  salt       text not null,              -- イベントごとのハッシュソルト
  device_id  text,
  created_at timestamptz not null default now()
);

create table public.checkins (
  id            uuid primary key,        -- クライアント生成 = 同期の冪等キー
  event_id      uuid not null references public.events(id),
  member_hash   text,                    -- SHA-256(salt:会員ID)。手入力時はnull
  suffix_hash   text not null,           -- SHA-256(salt:sfx:末尾6桁)。手入力照合用
  method        text not null check (method in ('scan', 'manual')),
  checked_in_at timestamptz not null,
  device_id     text,
  created_at    timestamptz not null default now()
);

-- 同一イベント×同一会員のデータ品質バックストップ（アプリ側でも重複判定済み）
create unique index checkins_event_member_uidx
  on public.checkins (event_id, member_hash)
  where member_hash is not null;

create index checkins_event_time_idx on public.checkins (event_id, checked_in_at);

-- 重複読取・対象外コードのエラーログ
create table public.scan_errors (
  id          uuid primary key,
  event_id    uuid not null references public.events(id),
  kind        text not null check (kind in ('duplicate', 'invalid_format')),
  member_hash text,
  suffix_hash text,
  symbology   text,
  occurred_at timestamptz not null,
  device_id   text,
  created_at  timestamptz not null default now()
);

create index scan_errors_event_idx on public.scan_errors (event_id, occurred_at);

-- ---------------------------------------------------------------- RLS
-- 実証パイロット方針:
--   anon ロールに select / insert のみ許可し、update / delete のポリシーは
--   一切作らない = anonキーが漏れても既存データの改ざん・削除はできない。
--   （閲覧は可能。保存されているのはハッシュ値のみ。既知の制約リスト参照）
-- 本番移行時は Supabase Auth を導入し、to anon を to authenticated へ
-- 差し替えた上でスタッフのみにアカウントを発行する。

alter table public.events      enable row level security;
alter table public.checkins    enable row level security;
alter table public.scan_errors enable row level security;

create policy "pilot_events_select"      on public.events      for select to anon using (true);
create policy "pilot_events_insert"      on public.events      for insert to anon with check (true);
create policy "pilot_checkins_select"    on public.checkins    for select to anon using (true);
create policy "pilot_checkins_insert"    on public.checkins    for insert to anon with check (true);
create policy "pilot_scan_errors_select" on public.scan_errors for select to anon using (true);
create policy "pilot_scan_errors_insert" on public.scan_errors for insert to anon with check (true);
