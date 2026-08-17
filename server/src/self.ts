/// 公開面: 来場者自身によるチェックイン（visit-self Worker）。
///
/// DESIGN.md の Phase 2。場所に掲示されたQRを来場者が自分のスマホで読むと
/// このWorkerのページが開き、本人がボタンを押してチェックインする。
///
/// スタッフ面（visit-checkin, Cloudflare Access保護）とはWorkerを分ける。
/// このWorkerは意図的に公開であり、以下を守る:
///   - 秘密を一切持たない（ソルト・APIキーはここに置かない。D1バインディングのみ）
///   - 身元は「端末仮名」= ブラウザが生成し保存するランダム値（段2）。
///     カード読取は行わない（仮名計算にソルトが必要になり、公開面に置けないため）
///   - 書き込めるのは self_enabled が立っている場所へのチェックインだけ
///
/// 既知の限界（実証段階として受容・DESIGN.md §7）:
///   - QRの写真リプレイ / スクリプトによる水増しは防がない。
///     同一ブラウザの重複は端末仮名のユニーク制約で1回に潰れる

import { HASH_RE, UUID_RE } from "./webappSync";

export interface Env {
  DB: D1Database;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/v1/health") {
      return json({ ok: true });
    }
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // 来場者向けページ: /p/<eventId>/<placeId>
    const page = /^\/p\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (page && request.method === "GET") {
      return renderPage(page[1].toLowerCase(), page[2].toLowerCase(), env);
    }

    if (url.pathname === "/self/checkin" && request.method === "POST") {
      return handleCheckin(request, env);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function loadTarget(eventId: string, placeId: string, env: Env) {
  if (!UUID_RE.test(eventId) || !UUID_RE.test(placeId)) return null;
  const [ev, pl] = await Promise.all([
    env.DB.prepare("SELECT id, name, event_date, venue FROM wc_events WHERE id = ?1")
      .bind(eventId)
      .first<{ id: string; name: string; event_date: string; venue: string }>(),
    env.DB.prepare("SELECT id, name, self_enabled FROM wc_places WHERE id = ?1")
      .bind(placeId)
      .first<{ id: string; name: string; self_enabled: number }>(),
  ]);
  if (!ev || !pl) return null;
  // フラグが降りている場所は「存在しない」のと同じ扱いにする
  if (pl.self_enabled !== 1) return null;
  return { ev, pl };
}

async function renderPage(eventId: string, placeId: string, env: Env): Promise<Response> {
  const target = await loadTarget(eventId, placeId, env);
  if (!target) {
    return html(
      `<main><h1>ご利用いただけません</h1>
       <p>このQRコードは現在利用できません。お近くのスタッフにお声がけください。</p></main>`,
      404
    );
  }
  const { ev, pl } = target;
  return html(`<main>
  <p class="place">${esc(pl.name)}</p>
  <h1>${esc(ev.name)}</h1>
  <p class="meta">${esc(ev.event_date)}・${esc(ev.venue)}</p>

  <div class="card">
    <h2>チェックインのご案内</h2>
    <p>来場状況の把握と施策の効果測定のため、ご来場を記録させていただきます。</p>
    <ul>
      <li>記録されるのは<strong>この端末のランダムな識別子・場所・時刻</strong>のみです</li>
      <li>お名前・連絡先・カード情報は<strong>一切取得しません</strong></li>
      <li>identifierは端末内で生成され、あなたが誰かを特定するものではありません</li>
    </ul>
  </div>

  <button id="go" type="button">チェックインする</button>
  <p id="result" role="status"></p>
</main>
<script>
(function () {
  var KEY = "visit-self-pseudonym";
  function pseudonym() {
    var v = null;
    try { v = localStorage.getItem(KEY); } catch (e) {}
    if (v && /^[0-9a-f]{64}$/.test(v)) return v;
    var buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    v = Array.prototype.map.call(buf, function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
    try { localStorage.setItem(KEY, v); } catch (e) {}
    return v;
  }
  var btn = document.getElementById("go");
  var out = document.getElementById("result");
  btn.addEventListener("click", function () {
    btn.disabled = true;
    out.textContent = "送信中…";
    fetch("/self/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: ${JSON.stringify(ev.id)},
        placeId: ${JSON.stringify(pl.id)},
        pseudonym: pseudonym()
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.status === "stored") {
        document.body.className = "ok";
        out.textContent = "チェックインしました。ようこそ！";
      } else if (d.status === "already") {
        document.body.className = "warn";
        out.textContent = "この端末では受付済みです。";
        btn.disabled = true;
        return;
      } else {
        out.textContent = "受け付けられませんでした。スタッフにお声がけください。";
        btn.disabled = false;
      }
    }).catch(function () {
      out.textContent = "通信に失敗しました。電波の良い場所でもう一度お試しください。";
      btn.disabled = false;
    });
  });
})();
</script>`);
}

async function handleCheckin(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ status: "error" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const eventId = typeof b.eventId === "string" ? b.eventId.toLowerCase() : "";
  const placeId = typeof b.placeId === "string" ? b.placeId.toLowerCase() : "";
  const pseudonym = typeof b.pseudonym === "string" ? b.pseudonym.toLowerCase() : "";
  if (!UUID_RE.test(eventId) || !UUID_RE.test(placeId) || !HASH_RE.test(pseudonym)) {
    return json({ status: "error" }, 400);
  }
  // 実在し、かつ自己チェックインが許可された場所以外には書き込めない
  const target = await loadTarget(eventId, placeId, env);
  if (!target) return json({ status: "error" }, 404);

  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO wc_checkins" +
      " (id, event_id, place_id, member_hash, suffix_hash, method, checked_in_at, device_id)" +
      " VALUES (?1, ?2, ?3, ?4, NULL, 'self', ?5, 'self-web')"
  )
    .bind(crypto.randomUUID(), eventId, placeId, pseudonym, new Date().toISOString())
    .run();

  return json({ status: (result.meta?.changes ?? 0) > 0 ? "stored" : "already" });
}

function html(bodyInner: string, status = 200): Response {
  const doc = `<!doctype html>
<html lang="ja"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>来場チェックイン</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Hiragino Sans", sans-serif;
         background: #f6f6f8; color: #1a1a1c; line-height: 1.7; }
  main { max-width: 480px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 24px; margin: 4px 0; }
  h2 { font-size: 16px; margin: 0 0 8px; }
  .place { display: inline-block; background: #e8eefc; color: #2949c4;
           font-weight: 700; border-radius: 999px; padding: 4px 14px; margin: 0; }
  .meta { color: #57575e; margin-top: 0; }
  .card { background: #fff; border: 1px solid #e2e2e6; border-radius: 12px;
          padding: 16px; margin: 16px 0; }
  ul { padding-left: 20px; margin: 8px 0 0; }
  li { margin: 4px 0; }
  button { display: block; width: 100%; min-height: 64px; font-size: 20px;
           font-weight: 700; color: #fff; background: #2949c4; border: none;
           border-radius: 10px; cursor: pointer; }
  button:disabled { opacity: 0.5; }
  #result { text-align: center; font-weight: 700; font-size: 18px; min-height: 1.5em; }
  body.ok #result { color: #1a7f37; }
  body.warn #result { color: #9a6700; }
</style>
</head><body>${bodyInner}</body></html>`;
  return new Response(doc, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
