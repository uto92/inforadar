import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { db, type EventRow } from "../lib/db";
import { formatDateJa } from "../lib/format";

/// 収集目的の掲示文テンプレート（受付掲示用）。印刷・コピーに対応。
/// 管理者・問い合わせ先はプレースホルダのため、運用前に差し替えること。

const PLACEHOLDER_ADMIN = "西日本旅客鉄道株式会社 ○○部 ○○課";
const PLACEHOLDER_CONTACT = "wester-inquiry@example.com ／ 0570-00-0000";
const PLACEHOLDER_RETENTION = "取得から6か月以内に削除します。";

function noticeLines(event: EventRow): { heading: string; body: string }[] {
  return [
    {
      heading: "読み取りの目的",
      body:
        `本イベント「${event.name}」（${formatDateJa(event.eventDate)}・${event.venue}）では、` +
        "来場状況の把握と施策の効果測定のため、お手持ちの会員証・ポイントカードのバーコードを読み取らせていただきます。",
    },
    {
      heading: "取得する情報",
      body:
        "会員番号は読み取りと同時に復元困難な符号（ハッシュ値）へ変換して記録し、" +
        "会員番号そのものは保存しません。あわせて読取日時を記録します。" +
        "氏名・連絡先など、その他の個人情報は取得しません。",
    },
    {
      heading: "利用範囲",
      body: "取得した情報は来場者数の集計にのみ利用し、第三者への提供は行いません。",
    },
    { heading: "保存期間", body: PLACEHOLDER_RETENTION },
    { heading: "管理者", body: PLACEHOLDER_ADMIN },
    { heading: "お問い合わせ", body: PLACEHOLDER_CONTACT },
  ];
}

export default function NoticePage() {
  const { eventId = "" } = useParams();
  // undefined = 読み込み中 / null = 該当なし（読込中に「見つかりません」を出さない）
  const event = useLiveQuery(async () => (await db.events.get(eventId)) ?? null, [eventId]);
  const [copied, setCopied] = useState(false);

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

  const sections = noticeLines(event);
  const plainText = [
    "お客様へ ― 会員証の読み取りについて",
    "",
    ...sections.flatMap((s) => [`■ ${s.heading}`, s.body, ""]),
    "読み取りをご希望されない場合は、お近くのスタッフへお申し出ください。",
  ].join("\n");

  async function copyText() {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボード不可の環境では選択コピーで代替
    }
  }

  return (
    <main className="page">
      <header className="page-header no-print">
        <Link to={`/admin/${event.id}`} className="back-link">
          管理画面
        </Link>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={() => void copyText()}>
            {copied ? "コピーしました" : "文面をコピー"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => window.print()}>
            印刷
          </button>
        </div>
      </header>

      <div className="notice-sheet">
        <h2>
          お客様へ
          <br />
          会員証の読み取りについて
        </h2>
        {sections.map((section) => (
          <div key={section.heading}>
            <h3>■ {section.heading}</h3>
            <p>{section.body}</p>
          </div>
        ))}
        <p style={{ marginTop: 20, fontWeight: 700 }}>
          読み取りをご希望されない場合は、お近くのスタッフへお申し出ください。
        </p>
      </div>

      <p className="muted no-print" style={{ marginTop: 12 }}>
        ※ 管理者・お問い合わせ先・保存期間はプレースホルダです。運用開始前に
        <code> src/pages/NoticePage.tsx </code>の定数を実際の値へ差し替えてください。
      </p>
    </main>
  );
}
