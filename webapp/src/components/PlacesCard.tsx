import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import {
  createPlace,
  db,
  getDevicePlace,
  setDevicePlace,
  setPlaceSelfEnabled,
  type EventRow,
} from "../lib/db";
import QrCode from "./QrCode";

/// 場所の管理（DESIGN.md Phase 1-2）。
/// - 場所の登録と、この端末をどの場所の受付にするかの紐づけ
/// - 来場者向けQR（公開面 visit-self へのリンク）の表示
///
/// ⚠ ここで表示する来場者向けQRは公開してよいURLのみで構成する。
///   ソルトを含む受付端末追加QR（SharePanel側）とは別物であり、混ぜてはならない。

const SELF_BASE = import.meta.env.VITE_SELF_URL?.replace(/\/+$/, "") ?? "";

export default function PlacesCard({ event }: { event: EventRow }) {
  const places = useLiveQuery(() => db.places.orderBy("createdAt").toArray(), [], []);
  const devicePlaceId = useLiveQuery(() => getDevicePlace(event.id), [event.id], null);

  const [name, setName] = useState("");
  const [selfEnabled, setSelfEnabled] = useState(false);
  const [visitorQrFor, setVisitorQrFor] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function add() {
    const trimmed = name.trim();
    if (!trimmed) return;
    await createPlace(trimmed, selfEnabled ? 1 : 0);
    setName("");
    setSelfEnabled(false);
  }

  const visitorUrl = (placeId: string) => `${SELF_BASE}/p/${event.id}/${placeId}`;

  return (
    <section className="card">
      <h2 className="section-title" style={{ marginTop: 0 }}>
        場所
      </h2>
      <p className="muted">
        「誰がどこに来たか」を記録するための受付場所です。場所を使わない運用では
        このまま（未指定）で問題ありません。
      </p>

      <div className="field">
        <label htmlFor="device-place">この端末の受付場所</label>
        <select
          id="device-place"
          value={devicePlaceId ?? ""}
          onChange={(e) => void setDevicePlace(event.id, e.target.value || null)}
          style={selectStyle}
        >
          <option value="">未指定</option>
          {places.map((pl) => (
            <option key={pl.id} value={pl.id}>
              {pl.name}
            </option>
          ))}
        </select>
        <p className="muted" style={{ marginTop: 4 }}>
          ここで選んだ場所が、この端末の読取すべてに記録されます。
        </p>
      </div>

      {places.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
          {places.map((pl) => (
            <li
              key={pl.id}
              style={{ borderTop: "1px solid var(--color-border-light)", padding: "10px 0" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <strong style={{ flex: 1 }}>{pl.name}</strong>
                <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={pl.selfEnabled === 1}
                    onChange={(e) => void setPlaceSelfEnabled(pl.id, e.target.checked ? 1 : 0)}
                  />
                  セルフ受付
                </label>
              </div>
              {pl.selfEnabled === 1 && (
                <div style={{ marginTop: 8 }}>
                  {SELF_BASE ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary btn-block"
                        style={{ minHeight: 40, fontSize: 14 }}
                        onClick={() => setVisitorQrFor(visitorQrFor === pl.id ? null : pl.id)}
                      >
                        {visitorQrFor === pl.id ? "来場者用QRを閉じる" : "来場者用QRを表示"}
                      </button>
                      {visitorQrFor === pl.id && (
                        <div style={{ textAlign: "center", padding: "12px 0" }}>
                          <p className="muted" style={{ marginTop: 0 }}>
                            このQRは<strong>掲示用（公開可）</strong>です。来場者が自分のスマホで
                            読むと、この場所へのチェックインページが開きます。
                          </p>
                          <div style={{ display: "flex", justifyContent: "center" }}>
                            <QrCode text={visitorUrl(pl.id)} size={200} />
                          </div>
                          <button
                            type="button"
                            className="btn btn-ghost btn-block"
                            style={{ minHeight: 40, fontSize: 14 }}
                            onClick={() => {
                              void navigator.clipboard
                                ?.writeText(visitorUrl(pl.id))
                                .then(() => setCopied(pl.id))
                                .catch(() => setCopied(null));
                            }}
                          >
                            {copied === pl.id ? "コピーしました" : "リンクをコピー"}
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="muted" style={{ margin: 0 }}>
                      公開面のURLが未設定のため、来場者用QRは表示できません
                      （ビルド時に VITE_SELF_URL を設定してください）。
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="new-place">場所を追加</label>
        <input
          id="new-place"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例: 中央改札前ブース"
        />
        <label
          style={{ fontSize: 14, display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}
        >
          <input
            type="checkbox"
            checked={selfEnabled}
            onChange={(e) => setSelfEnabled(e.target.checked)}
          />
          来場者によるセルフチェックインを許可する
        </label>
      </div>
      <button
        type="button"
        className="btn btn-secondary btn-block"
        disabled={!name.trim()}
        onClick={() => void add()}
      >
        追加する
      </button>
    </section>
  );
}

const selectStyle: React.CSSProperties = {
  width: "100%",
  minHeight: "var(--tap-min)",
  padding: "8px 12px",
  fontFamily: "inherit",
  fontSize: 18,
  color: "var(--color-text)",
  background: "var(--color-bg)",
  border: "2px solid var(--color-border)",
  borderRadius: "var(--radius)",
};
