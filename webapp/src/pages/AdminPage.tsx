import { useLiveQuery } from "dexie-react-hooks";
import { useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router-dom";
import PlacesCard from "../components/PlacesCard";
import QrCode from "../components/QrCode";
import Histogram from "../components/Histogram";
import SyncBadge from "../components/SyncBadge";
import { downloadCsv, sanitizeFilename, toCsv } from "../lib/csv";
import { db, type CheckinRow, type PlaceRow, type ScanErrorRow } from "../lib/db";
import { formatDateJa, formatDateTime } from "../lib/format";
import { buildJoinUrl } from "../lib/joinLink";
import { syncEngine } from "../lib/sync/engine";

export default function AdminPage() {
  const { eventId = "" } = useParams();
  // 他端末へイベント（とソルト）を引き渡すQRの表示切替
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // 追加する端末をどの場所の受付にするか（未指定可）
  const [sharePlaceId, setSharePlaceId] = useState("");
  // undefined = 読み込み中 / null = 該当なし（読込中に「見つかりません」を出さない）
  const event = useLiveQuery(async () => (await db.events.get(eventId)) ?? null, [eventId]);
  const checkins = useLiveQuery(
    () => db.checkins.where("eventId").equals(eventId).sortBy("checkedInAt"),
    [eventId],
    [] as CheckinRow[]
  );
  const errors = useLiveQuery(
    () => db.scanErrors.where("eventId").equals(eventId).sortBy("occurredAt"),
    [eventId],
    [] as ScanErrorRow[]
  );
  const places = useLiveQuery(() => db.places.orderBy("createdAt").toArray(), [], [] as PlaceRow[]);
  const syncState = useSyncExternalStore(syncEngine.subscribe, syncEngine.getSnapshot);

  if (event === undefined) {
    return (
      <main className="page">
        <p className="muted">読み込み中…</p>
      </main>
    );
  }
  if (event === null) {
    return (
      <main className="page">
        <p>
          イベントが見つかりません。<Link to="/">イベント選択へ戻る</Link>
        </p>
      </main>
    );
  }

  const placeName = new Map(places.map((pl) => [pl.id, pl.name]));
  const scanCount = checkins.filter((c) => c.method === "scan").length;
  const selfCount = checkins.filter((c) => c.method === "self").length;
  const nfcCount = checkins.filter((c) => c.method === "nfc").length;
  const manualCount = checkins.length - scanCount - selfCount - nfcCount;
  // 場所別の内訳（場所を使っている場合のみ表示）
  const byPlace = new Map<string, number>();
  for (const c of checkins) {
    const key = c.placeId ?? "";
    byPlace.set(key, (byPlace.get(key) ?? 0) + 1);
  }
  const placeRows = [...byPlace.entries()]
    .map(([id, n]) => ({ name: id ? (placeName.get(id) ?? "（不明な場所）") : "場所未指定", n }))
    .sort((a, b) => b.n - a.n);
  const showPlaces = placeRows.some((r) => r.name !== "場所未指定");
  const dupCount = errors.filter((e) => e.kind === "duplicate").length;
  const invalidCount = errors.length - dupCount;

  function exportCheckins() {
    if (!event) return;
    const csv = toCsv(
      [
        "event_name",
        "event_date",
        "venue",
        "place_name",
        "member_hash",
        "suffix_hash",
        "method",
        "checked_in_at",
        "checked_in_at_local",
        "device_id",
        "synced",
      ],
      checkins.map((c) => [
        event.name,
        event.eventDate,
        event.venue,
        c.placeId ? (placeName.get(c.placeId) ?? c.placeId) : "",
        c.memberHash ?? "",
        c.suffixHash,
        c.method,
        c.checkedInAt,
        formatDateTime(c.checkedInAt),
        c.deviceId,
        c.synced,
      ])
    );
    downloadCsv(`checkins_${event.eventDate}_${sanitizeFilename(event.name)}.csv`, csv);
  }

  function exportErrors() {
    if (!event) return;
    const csv = toCsv(
      [
        "event_name",
        "event_date",
        "kind",
        "symbology",
        "member_hash",
        "suffix_hash",
        "occurred_at",
        "occurred_at_local",
        "device_id",
      ],
      errors.map((e) => [
        event.name,
        event.eventDate,
        e.kind,
        e.symbology ?? "",
        e.memberHash ?? "",
        e.suffixHash ?? "",
        e.occurredAt,
        formatDateTime(e.occurredAt),
        e.deviceId,
      ])
    );
    downloadCsv(`scan_errors_${event.eventDate}_${sanitizeFilename(event.name)}.csv`, csv);
  }

  return (
    <main className="page">
      <header className="page-header">
        <Link to="/" className="back-link">
          イベント
        </Link>
        <SyncBadge />
      </header>
      <h1 className="page-title">{event.name}</h1>
      <p className="muted">
        {formatDateJa(event.eventDate)}・{event.venue}
      </p>

      <section className="card">
        <div className="stat-hero">
          <div className="value" aria-live="polite">
            {checkins.length}
          </div>
          <div className="label">来場者数（リアルタイム）</div>
        </div>
        <div className="stat-grid">
          <div className="stat-tile">
            <div className="label">スキャン</div>
            <div className="value">{scanCount}</div>
          </div>
          <div className="stat-tile">
            <div className="label">手入力</div>
            <div className="value">{manualCount}</div>
          </div>
          {(selfCount > 0 || nfcCount > 0) && (
            <div className="stat-tile">
              <div className="label">セルフ / NFC</div>
              <div className="value">
                {selfCount} / {nfcCount}
              </div>
            </div>
          )}
          <div className="stat-tile">
            <div className="label">重複読取（記録済を再読取）</div>
            <div className="value">{dupCount}</div>
          </div>
          <div className="stat-tile">
            <div className="label">対象外コード</div>
            <div className="value">{invalidCount}</div>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          時間帯別来場数
        </h2>
        <Histogram timestamps={checkins.map((c) => c.checkedInAt)} />
      </section>

      {showPlaces && (
        <section className="card">
          <h2 className="section-title" style={{ marginTop: 0 }}>
            場所別の来場数
          </h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {placeRows.map((r) => (
              <li
                key={r.name}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "6px 0",
                  borderTop: "1px solid var(--color-border-light)",
                }}
              >
                <span>{r.name}</span>
                <strong>{r.n}人</strong>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PlacesCard event={event} />

      <section className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          CSVエクスポート
        </h2>
        <p className="muted">会員IDはハッシュ値のみ出力されます（生値は保存されていません）。</p>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={exportCheckins}
            disabled={checkins.length === 0}
          >
            来場記録CSV（{checkins.length}件）
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-block"
            onClick={exportErrors}
            disabled={errors.length === 0}
          >
            エラーログCSV（{errors.length}件）
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          サーバ同期
        </h2>
        {syncEngine.hasBackend ? (
          <>
            <p className="muted">
              電波のある場所で自動送信され、他の端末の記録も自動で取り込まれます（20秒ごと）。
              {syncState.lastSyncedAt && ` 最終同期: ${formatDateTime(syncState.lastSyncedAt)}`}
            </p>
            {syncState.lastError && (
              <p style={{ color: "var(--color-error)", fontSize: 14 }}>
                エラー: {syncState.lastError}
              </p>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-block"
              onClick={() => syncEngine.kick(true)}
              disabled={syncState.mode === "syncing"}
            >
              {/* 受け取るだけの端末は未送信が常に0件。取得のためにも押せる必要がある */}
              {syncState.pending > 0 ? `今すぐ同期（未送信 ${syncState.pending} 件）` : "今すぐ同期"}
            </button>
          </>
        ) : (
          <p className="muted">
            同期先が未設定です。データはこの端末のブラウザ内（IndexedDB）にのみ保存され、
            他の端末とは合算されません。当日中にCSVエクスポートで退避することを推奨します。
            設定方法は DEPLOY.md を参照してください。
          </p>
        )}
      </section>

      <section className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          受付を増やす
        </h2>
        {shareOpen ? (
          <>
            <p className="muted">
              2台目のスマホの<strong>標準のカメラアプリ</strong>でこのQRを写し、
              表示されるリンクを開いてください。読み取りに必要な設定が引き継がれます。
            </p>
            {places.length > 0 && (
              <div className="field">
                <label htmlFor="share-place">追加する端末の受付場所</label>
                <select
                  id="share-place"
                  value={sharePlaceId}
                  onChange={(e) => setSharePlaceId(e.target.value)}
                  style={{
                    width: "100%",
                    minHeight: "var(--tap-min)",
                    padding: "8px 12px",
                    fontFamily: "inherit",
                    fontSize: 18,
                    color: "var(--color-text)",
                    background: "var(--color-bg)",
                    border: "2px solid var(--color-border)",
                    borderRadius: "var(--radius)",
                  }}
                >
                  <option value="">未指定</option>
                  {places.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {pl.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "center", padding: "12px 0" }}>
              <QrCode text={buildJoinUrl(event, sharePlaceId || null)} />
            </div>
            <p className="muted">
              このリンクには読み取りに必要な鍵が含まれます。関係者以外に共有しないでください。
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-block"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(buildJoinUrl(event))
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "コピーしました" : "リンクをコピー"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => setShareOpen(false)}
            >
              閉じる
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              同じイベントを他のスマホでも受付する場合に使います。
              集計は自動で合算され、同じ来場者を2台で読んでも二重には数えません。
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-block"
              onClick={() => setShareOpen(true)}
            >
              他の端末を追加する
            </button>
          </>
        )}
      </section>

      <div style={{ display: "grid", gap: 8, marginTop: 16 }}>
        <Link to={`/scan/${event.id}`} className="btn btn-primary btn-xl btn-block">
          スキャン画面へ
        </Link>
        <Link to={`/notice/${event.id}`} className="btn btn-ghost btn-block">
          受付掲示文を表示
        </Link>
      </div>
    </main>
  );
}
