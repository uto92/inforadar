import { useState } from "react";
import { syncEngine } from "../lib/sync/engine";
import { clearSyncToken, getSyncToken, setSyncToken } from "../lib/syncToken";

/// 同期の合言葉を入力する欄。未設定なら催促、設定済みなら変更できる。
/// 合言葉は端末ごとに保存されるため、受付端末を増やすたびに1回入力する。

export default function SyncTokenCard() {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(() => getSyncToken() !== null);
  const [editing, setEditing] = useState(() => getSyncToken() === null);

  if (!syncEngine.hasBackend) return null;

  function save() {
    setSyncToken(value);
    setSaved(true);
    setEditing(false);
    setValue("");
    // 保存直後に同期を試し、結果（成功/合言葉違い）をすぐ画面に出す
    syncEngine.kick(true);
  }

  if (!editing) {
    return (
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          同期の合言葉は設定済みです。他の端末とデータが合算されます。
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          style={{ marginTop: 8 }}
          onClick={() => {
            clearSyncToken();
            setSaved(false);
            setEditing(true);
          }}
        >
          合言葉を変更する
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="section-title" style={{ marginTop: 0 }}>
        同期の合言葉
      </h2>
      <p className="muted">
        {saved
          ? "新しい合言葉を入力してください。"
          : "この端末はまだ同期に接続していません。合言葉を入力すると、他の端末と来場数が合算されます。入力は端末ごとに1回だけです。"}
      </p>
      <div className="field">
        <label htmlFor="sync-token">合言葉</label>
        <input
          id="sync-token"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="担当者から共有された文字列"
        />
      </div>
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={!value.trim()}
        onClick={save}
      >
        保存する
      </button>
      <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
        合言葉が無くても、この端末だけで受付を続けることはできます（記録は端末内に残ります）。
      </p>
    </div>
  );
}
