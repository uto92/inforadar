import { useLiveQuery } from "dexie-react-hooks";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import SyncBadge from "../components/SyncBadge";
import { createEvent, db, type EventRow } from "../lib/db";
import type { CardMode } from "../lib/normalize";
import { formatDateJa, todayIsoDate } from "../lib/format";

export default function EventsPage() {
  const events = useLiveQuery(
    () => db.events.orderBy("createdAt").reverse().toArray(),
    [],
    [] as EventRow[]
  );
  const [formOpen, setFormOpen] = useState(false);
  const [cardMode, setCardMode] = useState<CardMode>("any");
  const [name, setName] = useState("");
  const [eventDate, setEventDate] = useState(todayIsoDate());
  const [venue, setVenue] = useState("");

  const today = todayIsoDate();
  const todays = events.filter((e) => e.eventDate === today);
  const others = events
    .filter((e) => e.eventDate !== today)
    .sort((a, b) => b.eventDate.localeCompare(a.eventDate));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !venue.trim() || !eventDate) return;
    await createEvent({ name, eventDate, venue, cardMode });
    setName("");
    setVenue("");
    setEventDate(todayIsoDate());
    setFormOpen(false);
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1 className="page-title">来場チェックイン</h1>
        <SyncBadge />
      </header>

      {todays.length > 0 && (
        <>
          <h2 className="section-title">本日のイベント</h2>
          {todays.map((event) => (
            <EventCard key={event.id} event={event} highlight />
          ))}
        </>
      )}

      <h2 className="section-title">イベント一覧</h2>
      {others.length === 0 && todays.length === 0 && (
        <p className="muted">
          イベントがまだ登録されていません。下の「新規イベント登録」から事前に登録してください。
        </p>
      )}
      {others.map((event) => (
        <EventCard key={event.id} event={event} />
      ))}

      <div style={{ marginTop: 24 }}>
        {formOpen ? (
          <form className="card" onSubmit={submit}>
            <h2 className="section-title" style={{ marginTop: 0 }}>
              新規イベント登録
            </h2>
            <div className="field">
              <label htmlFor="ev-name">イベント名</label>
              <input
                id="ev-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: ○○駅マルシェ"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="ev-date">開催日</label>
              <input
                id="ev-date"
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="ev-venue">会場</label>
              <input
                id="ev-venue"
                value={venue}
                onChange={(e) => setVenue(e.target.value)}
                placeholder="例: ○○駅 改札前広場"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="ev-cardmode">受け付けるカード</label>
              <select
                id="ev-cardmode"
                value={cardMode}
                onChange={(e) => setCardMode(e.target.value as CardMode)}
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
                <option value="any">すべて（発行元を問わない）</option>
                <option value="wester12">WESTER会員証のみ（数字12桁）</option>
              </select>
              <p className="muted" style={{ marginTop: 4 }}>
                {cardMode === "any"
                  ? "来場者が持っている任意の会員証・ポイントカードを受け付けます。どの会社のカードかは記録しません。"
                  : "数字12桁のIDのみ受け付けます。それ以外は「対象外」として弾きます。"}
              </p>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <button type="submit" className="btn btn-primary btn-block">
                登録する
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                onClick={() => setFormOpen(false)}
              >
                閉じる
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-block"
            onClick={() => setFormOpen(true)}
          >
            ＋ 新規イベント登録
          </button>
        )}
      </div>

      <Link to="/key" className="btn btn-ghost btn-block" style={{ marginTop: 24 }}>
        プロジェクト鍵（控え・引き継ぎ）
      </Link>
    </main>
  );
}

function EventCard({ event, highlight = false }: { event: EventRow; highlight?: boolean }) {
  const count = useLiveQuery(
    () => db.checkins.where("eventId").equals(event.id).count(),
    [event.id],
    0
  );
  return (
    <section
      className="card"
      style={highlight ? { borderColor: "var(--color-primary)", borderWidth: 2 } : undefined}
    >
      <div className="event-card-count">
        <strong>{count}</strong>人
      </div>
      <h3 className="event-card-name">{event.name}</h3>
      <p className="event-card-meta">
        {formatDateJa(event.eventDate)}・{event.venue}
      </p>
      <div className="event-card-actions">
        <Link to={`/scan/${event.id}`} className="btn btn-primary">
          スキャン開始
        </Link>
        <Link to={`/admin/${event.id}`} className="btn btn-secondary">
          管理
        </Link>
        <Link to={`/notice/${event.id}`} className="btn btn-secondary">
          掲示文
        </Link>
      </div>
    </section>
  );
}
