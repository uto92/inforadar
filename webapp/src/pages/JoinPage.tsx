import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { adoptProjectSalt, db, setDevicePlace } from "../lib/db";
import { getDeviceId } from "../lib/deviceId";
import { parseJoinParams } from "../lib/joinLink";

/// 別端末から渡されたリンクを開いた側の画面。
/// イベントとハッシュのソルトを取り込み、この端末でも読み取れるようにする。

type State =
  | { kind: "working" }
  | { kind: "done"; eventId: string; name: string; updated: boolean }
  | { kind: "error"; message: string };

export default function JoinPage() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "working" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const payload = parseJoinParams(search);
      if (!payload) {
        setState({
          kind: "error",
          message: "リンクが正しくありません。共有元の端末で作り直してください。",
        });
        return;
      }
      // QRに場所が入っていれば、この端末をその場所の受付として紐づける
      if (payload.placeId) await setDevicePlace(payload.id, payload.placeId);
      const existing = await db.events.get(payload.id);
      if (existing) {
        // 同期で先に取り込んだイベントは salt が空。ここで補うと読み取り可能になる
        if (!existing.salt) {
          await db.events.update(payload.id, { salt: payload.salt });
          if (!cancelled) {
            setState({ kind: "done", eventId: payload.id, name: payload.name, updated: true });
          }
          return;
        }
        // 既に別のソルトを持っている場合は上書きしない。
        // 上書きすると既存のチェックインと照合できなくなり重複判定が壊れる
        if (existing.salt !== payload.salt) {
          setState({
            kind: "error",
            message:
              "この端末には同じイベントが別の設定で登録されています。取り込むと既存の記録と照合できなくなるため中止しました。",
          });
          return;
        }
        if (!cancelled) {
          setState({ kind: "done", eventId: payload.id, name: payload.name, updated: false });
        }
        return;
      }
      // 引き継いだソルトをプロジェクト共通ソルトとしても採用する。
      // これにより、この端末で新規作成するイベントも同じソルトになり、
      // イベントをまたいだ再訪の判定が成立する
      const adopted = await adoptProjectSalt(payload.salt);
      if (!adopted) {
        setState({
          kind: "error",
          message:
            "この端末には別のプロジェクト鍵が保存されています。取り込むとイベントをまたいだ集計が合わなくなるため中止しました。管理画面の「プロジェクト鍵」を確認してください。",
        });
        return;
      }
      await db.events.add({
        id: payload.id,
        name: payload.name,
        eventDate: payload.eventDate,
        venue: payload.venue,
        salt: payload.salt,
        deviceId: getDeviceId(),
        createdAt: new Date().toISOString(),
        // サーバ側は同じidを無視するため、送っても重複しない
        synced: 0,
      });
      if (!cancelled) {
        setState({ kind: "done", eventId: payload.id, name: payload.name, updated: true });
      }
    })().catch((e) => {
      if (!cancelled) {
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [search]);

  if (state.kind === "working") {
    return (
      <main className="page">
        <p className="muted">読み込み中…</p>
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main className="page">
        <h1 className="page-title">取り込めませんでした</h1>
        <div className="card">
          <p>{state.message}</p>
        </div>
        <Link to="/" className="btn btn-secondary btn-block">
          イベント一覧へ
        </Link>
      </main>
    );
  }

  return (
    <main className="page">
      <h1 className="page-title">この端末で受付できます</h1>
      <div className="card">
        <p className="event-card-name">{state.name}</p>
        <p className="muted">
          {state.updated
            ? "イベントの設定を取り込みました。この端末でも読み取りができます。"
            : "このイベントは既に取り込み済みです。"}
        </p>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-xl btn-block"
        onClick={() => navigate(`/scan/${state.eventId}`)}
      >
        スキャンを開始
      </button>
      <Link to="/" className="btn btn-ghost btn-block" style={{ marginTop: 8 }}>
        イベント一覧へ
      </Link>
    </main>
  );
}
