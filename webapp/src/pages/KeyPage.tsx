import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { adoptProjectSalt, db, ensureProjectSalt, getProjectSalt } from "../lib/db";

/// プロジェクト鍵（全イベント共通のハッシュソルト）の控えと復元。
///
/// この鍵はサーバに送っていないため、端末を失うと二度と取り戻せない。
/// 鍵を失うと、記録済みのハッシュは誰とも突合できない数値の羅列になる。
/// そのため必ず控えを取れるようにしておく。

export default function KeyPage() {
  const [salt, setSalt] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [input, setInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [eventCount, setEventCount] = useState(0);

  useEffect(() => {
    void (async () => {
      setSalt(await getProjectSalt());
      setEventCount(await db.events.count());
    })();
  }, []);

  async function generate() {
    const created = await ensureProjectSalt();
    setSalt(created);
    setRevealed(true);
  }

  async function restore() {
    const value = input.trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(value)) {
      setMessage("鍵の形式が違います。32文字の英数字（0-9, a-f）を入力してください。");
      return;
    }
    const ok = await adoptProjectSalt(value);
    if (!ok) {
      setMessage(
        "この端末には既に別の鍵が保存されています。上書きすると記録済みのデータと突合できなくなるため中止しました。"
      );
      return;
    }
    setSalt(value);
    setInput("");
    setMessage("鍵を取り込みました。");
  }

  return (
    <main className="page">
      <header className="page-header">
        <Link to="/" className="back-link">
          イベント
        </Link>
      </header>
      <h1 className="page-title">プロジェクト鍵</h1>
      <p className="muted">
        会員IDをハッシュ化するための鍵です。全イベントで共通のため、イベントをまたいで
        同じ来場者を判定できます。
      </p>

      <div className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          この端末の鍵
        </h2>
        {salt === null ? (
          <>
            <p className="muted">まだ鍵がありません。イベントを作成すると自動で生成されます。</p>
            <button type="button" className="btn btn-secondary btn-block" onClick={() => void generate()}>
              いま生成する
            </button>
          </>
        ) : revealed ? (
          <>
            <p
              style={{
                fontFamily: "ui-monospace, monospace",
                wordBreak: "break-all",
                fontSize: 18,
                background: "var(--color-bg-secondary)",
                padding: 12,
                borderRadius: 8,
              }}
            >
              {salt}
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-block"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(salt)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "コピーしました" : "コピーする"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => setRevealed(false)}
            >
              隠す
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-secondary btn-block" onClick={() => setRevealed(true)}>
            鍵を表示する
          </button>
        )}
      </div>

      <div className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          必ず控えてください
        </h2>
        <p className="muted">
          この鍵は<strong>サーバに保存していません</strong>。この端末から失われると復元できず、
          記録済みのデータは誰とも突合できなくなります。パスワード管理ツールなど、
          安全な場所に保管してください。
        </p>
        <p className="muted">
          鍵を知る人は、記録されたハッシュから会員IDを割り出せます（12桁は総当たりが可能なため）。
          パスワードと同じ扱いにしてください。
        </p>
      </div>

      <div className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          別の端末の鍵を取り込む
        </h2>
        <p className="muted">
          機種変更や端末追加のときに使います。
          {eventCount > 0 && "この端末には既に記録があるため、鍵が違う場合は取り込めません。"}
        </p>
        <div className="field">
          <label htmlFor="restore-key">控えておいた鍵</label>
          <input
            id="restore-key"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="32文字の英数字"
          />
        </div>
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!input.trim()}
          onClick={() => void restore()}
        >
          取り込む
        </button>
        {message && (
          <p className="muted" style={{ marginTop: 8 }}>
            {message}
          </p>
        )}
      </div>
    </main>
  );
}
