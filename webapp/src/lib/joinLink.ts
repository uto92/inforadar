/// 別端末へイベント（とハッシュのソルト）を引き渡すためのリンク。
///
/// ソルトはサーバに送っていない。サーバに置くと、12桁の会員IDは総当たりで
/// 探索可能なためハッシュ化の保護がほぼ無くなるためである。
/// そこで端末間の受け渡しだけで共有する。
///
/// ソルトは URL のフラグメント（#以降）に載せる。フラグメントはHTTPリクエストに
/// 含まれずサーバへ送信されないため、経路上にソルトが残らない。
/// 一方でブラウザ履歴やスクリーンショットには残るため、リンクの取り扱いは
/// 「関係者限り」とする（DEPLOY.md に記載）。

import type { EventRow } from "./db";

const SALT_RE = /^[0-9a-f]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JoinPayload {
  id: string;
  salt: string;
  name: string;
  eventDate: string;
  venue: string;
  /** 受け取った端末が受付場所として紐づく場所ID（任意） */
  placeId: string | null;
}

/** 受け取り用リンクを組み立てる。QR表示・コピーの両方で使う */
export function buildJoinUrl(
  event: EventRow,
  placeId: string | null = null,
  origin = window.location.href
): string {
  // HashRouter のため #/join?... の形になる。#以降は送信されない
  const base = origin.split("#")[0];
  const params = new URLSearchParams({
    e: event.id,
    s: event.salt,
    n: event.name,
    d: event.eventDate,
    v: event.venue,
  });
  if (placeId) params.set("p", placeId);
  return `${base}#/join?${params.toString()}`;
}

/** リンクのクエリからイベント情報を復元する。不正なら null */
export function parseJoinParams(search: URLSearchParams): JoinPayload | null {
  const id = search.get("e") ?? "";
  const salt = search.get("s") ?? "";
  const name = search.get("n") ?? "";
  const eventDate = search.get("d") ?? "";
  const venue = search.get("v") ?? "";
  if (!UUID_RE.test(id)) return null;
  // ソルトが壊れていると、同じ会員証でも別ハッシュになり重複判定が効かなくなる。
  // 黙って進めず必ず弾く
  if (!SALT_RE.test(salt)) return null;
  if (!name.trim() || !eventDate.trim()) return null;
  const placeRaw = (search.get("p") ?? "").toLowerCase();
  const placeId = UUID_RE.test(placeRaw) ? placeRaw : null;
  return { id, salt, name: name.trim(), eventDate, venue: venue.trim(), placeId };
}
