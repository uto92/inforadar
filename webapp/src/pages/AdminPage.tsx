import { useLiveQuery } from "dexie-react-hooks";
import { useSyncExternalStore } from "react";
import { Link, useParams } from "react-router-dom";
import Histogram from "../components/Histogram";
import SyncBadge from "../components/SyncBadge";
import { downloadCsv, sanitizeFilename, toCsv } from "../lib/csv";
import { db, type CheckinRow, type ScanErrorRow } from "../lib/db";
import { formatDateJa, formatDateTime } from "../lib/format";
import { syncEngine } from "../lib/sync/engine";

export default function AdminPage() {
  const { eventId = "" } = useParams();
  const event = useLiveQuery(() => db.events.get(eventId), [eventId]);
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
  const syncState = useSyncExternalStore(syncEngine.subscribe, syncEngine.getSnapshot);

  if (!event) {
    return (
      <main className="page">
        <p>
          イベントが見つかりません。<Link to="/">イベント選択へ戻る</Link>
        </p>
      </main>
    );
  }

  const scanCount = checkins.filter((c) => c.method === "scan").length;
  const manualCount = checkins.length - scanCount;
  const dupCount = errors.filter((e) => e.kind === "duplicate").length;
  const invalidCount = errors.length - dupCount;

  function exportCheckins() {
    if (!event) return;
    const csv = toCsv(
      [
        "event_name",
        "event_date",
        "venue",
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
              電波のある場所で自動送信されます。未送信分が残る場合は手動で実行してください。
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
              disabled={syncState.mode === "syncing" || syncState.pending === 0}
            >
              今すぐ同期（未送信 {syncState.pending} 件）
            </button>
          </>
        ) : (
          <p className="muted">
            Supabaseは未設定です。データはこの端末のブラウザ内（IndexedDB）にのみ保存されています。
            当日中にCSVエクスポートで退避することを推奨します。設定方法はREADMEを参照してください。
          </p>
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
