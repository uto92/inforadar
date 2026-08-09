/**
 * Worker から配信する確認用 Web UI（素のHTML + 素のJS、ビルド不要）。
 *
 * 目的は「受信した事実」と「解釈結果」が別物であることを目で確かめられること。
 * したがって取引一覧からは必ず生HEXと first_session_id を辿れるようにしてある。
 */
export const INDEX_HTML = /* html */ `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>交通行動データ収集基盤</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #fff; --fg: #16181d; --muted: #6b7280;
    --line: #e3e6ea; --accent: #1f6feb; --warn: #b45309;
    font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --panel:#1c1f25; --fg:#e6e8eb; --muted:#9aa3ae;
            --line:#2b3038; --accent:#5a9bff; --warn:#f0b429; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-size:14px; line-height:1.6; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); background:var(--panel);
           display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:700; }
  .sub { color:var(--muted); font-size:12px; }
  main { padding:20px; max-width:1200px; margin:0 auto; }
  nav { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:16px; }
  nav button { background:transparent; border:1px solid var(--line); color:var(--fg);
               padding:6px 14px; border-radius:999px; cursor:pointer; font-size:13px; }
  nav button.active { background:var(--accent); border-color:var(--accent); color:#fff; }
  section { display:none; }
  section.active { display:block; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px;
           padding:16px; margin-bottom:16px; overflow-x:auto; }
  .panel h2 { font-size:13px; margin:0 0 12px; color:var(--muted); font-weight:600;
              letter-spacing:.04em; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line);
           white-space:nowrap; vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  code, .hex { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
  .hex { color:var(--muted); }
  input, textarea, select { background:var(--bg); color:var(--fg); border:1px solid var(--line);
          border-radius:6px; padding:6px 8px; font-size:13px; font-family:inherit; }
  textarea { width:100%; min-height:120px; font-family:ui-monospace, monospace; }
  button.action { background:var(--accent); border:none; color:#fff; padding:7px 14px;
                  border-radius:6px; cursor:pointer; font-size:13px; }
  button.action.secondary { background:transparent; border:1px solid var(--line); color:var(--fg); }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
  .stat { display:inline-block; margin-right:24px; }
  .stat b { display:block; font-size:20px; font-variant-numeric:tabular-nums; }
  .stat span { color:var(--muted); font-size:12px; }
  .note { color:var(--muted); font-size:12px; }
  .warn { color:var(--warn); }
  pre { background:var(--bg); padding:10px; border-radius:6px; overflow-x:auto; font-size:12px; }
  .unmapped { color:var(--warn); }
</style>
</head>
<body>
<header>
  <h1>交通行動データ収集基盤</h1>
  <span class="sub" id="parserVersion"></span>
  <span style="flex:1"></span>
  <label class="sub">APIトークン
    <input id="token" type="password" size="24" placeholder="Bearer token">
  </label>
  <button class="action secondary" id="saveToken">保存</button>
</header>
<main>
  <nav>
    <button data-tab="dash" class="active">ダッシュボード</button>
    <button data-tab="tx">取引（解釈結果）</button>
    <button data-tab="sessions">読取セッション（生データ）</button>
    <button data-tab="cards">被験者・カード</button>
    <button data-tab="ingest">投入（mock）</button>
  </nav>

  <section id="dash" class="active">
    <div class="panel">
      <h2>受信した事実</h2>
      <div id="dashFacts"></div>
    </div>
    <div class="panel">
      <h2>解釈結果</h2>
      <div id="dashDerived"></div>
      <div class="row" style="margin-top:12px">
        <button class="action" id="reparse">全期間を再解析（derived を作り直す）</button>
        <span class="note">生HEXは触りません。解釈だけを現行パーサで作り直します。</span>
      </div>
      <pre id="reparseResult" hidden></pre>
    </div>
  </section>

  <section id="tx">
    <div class="panel">
      <div class="row">
        <label>被験者 <select id="fParticipant"><option value="">すべて</option></select></label>
        <label>カード仮名 <select id="fCard"><option value="">すべて</option></select></label>
        <label>期間 <input id="fFrom" type="date"> 〜 <input id="fTo" type="date"></label>
        <button class="action" id="reload">表示</button>
        <button class="action secondary" id="csv">CSV</button>
      </div>
      <div class="note" id="txNote"></div>
      <table id="txTable">
        <thead><tr>
          <th>利用日</th><th>種別</th><th>入</th><th>出</th>
          <th>残額</th><th>利用額(推定)</th><th>被験者</th><th>生HEX</th><th>初出セッション</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>

  <section id="sessions">
    <div class="panel">
      <h2>読取セッション</h2>
      <table id="sessionTable">
        <thead><tr>
          <th>受信時刻</th><th>読取時刻</th><th>カード仮名</th><th>被験者</th>
          <th>件数</th><th>client</th><th></th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="panel" id="rawPanel" hidden>
      <h2>生データ（raw_observations）</h2>
      <table id="rawTable">
        <thead><tr><th>#</th><th>block_order</th><th>raw_hex</th><th>received_at</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>

  <section id="cards">
    <div class="panel">
      <h2>被験者</h2>
      <div class="row">
        <input id="newParticipantId" placeholder="participant_id 例: P001">
        <input id="newParticipantLabel" placeholder="ラベル（任意）">
        <button class="action" id="addParticipant">登録</button>
      </div>
      <table id="participantTable">
        <thead><tr><th>participant_id</th><th>ラベル</th><th>カード数</th><th>作成</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="panel">
      <h2>観測されたカード仮名</h2>
      <p class="note">
        仮名は端末内 HMAC で作られるため、再インストールや機種変更で同一カードでも値が変わります。
        同じ被験者に複数の仮名が並ぶのは正常です。
      </p>
      <table id="cardTable">
        <thead><tr>
          <th>カード仮名</th><th>被験者</th><th>セッション</th><th>取引</th>
          <th>最終受信</th><th>紐付け</th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>

  <section id="ingest">
    <div class="panel">
      <h2>mock HEX の投入</h2>
      <p class="note">
        <code>node tools/mock-hex.mjs</code> が出力した JSON をそのまま貼り付けて送信できます。
        iPhone からの実読取も同じ <code>POST /v1/ingest</code> を使います。
      </p>
      <textarea id="ingestBody" spellcheck="false"></textarea>
      <div class="row" style="margin-top:8px">
        <button class="action" id="send">送信</button>
        <button class="action secondary" id="fillSample">サンプルを入れる</button>
      </div>
      <pre id="ingestResult" hidden></pre>
    </div>
  </section>
</main>

<script>
const $ = (sel) => document.querySelector(sel);
let token = localStorage.getItem("api_token") || "";
$("#token").value = token;
$("#saveToken").onclick = () => {
  token = $("#token").value.trim();
  localStorage.setItem("api_token", token);
  refreshAll();
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(body.detail || body.error || res.status);
  return body;
}

document.querySelectorAll("nav button").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll("nav button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll("section").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    $("#" + btn.dataset.tab).classList.add("active");
  };
});

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const yen = (v) => (v === null || v === undefined ? "" : "¥" + Number(v).toLocaleString("ja-JP"));

async function loadDash() {
  const status = await api("/v1/parser");
  $("#parserVersion").textContent = "parser: " + status.current_parser_version;
  $("#dashFacts").innerHTML =
    stat(status.read_sessions, "読取セッション") + stat(status.raw_observations, "生ブロック（全件保持）");
  const stale = status.stale > 0
    ? '<div class="warn">旧バージョンで作られた行が ' + status.stale + ' 件あります。再解析してください。</div>'
    : '<div class="note">すべて現行パーサで生成されています。</div>';
  $("#dashDerived").innerHTML =
    stat(status.derived_total, "解釈済み取引") +
    status.by_parser_version.map((v) => stat(v.count, v.parser_version)).join("") + stale;
}
const stat = (n, label) => '<div class="stat"><b>' + Number(n).toLocaleString() + "</b><span>" + esc(label) + "</span></div>";

$("#reparse").onclick = async () => {
  if (!confirm("derived_transactions を全消しして生HEXから作り直します。よろしいですか？")) return;
  const result = await api("/v1/reparse", { method: "POST" });
  $("#reparseResult").hidden = false;
  $("#reparseResult").textContent = JSON.stringify(result, null, 2);
  refreshAll();
};

async function loadTransactions() {
  const params = new URLSearchParams();
  if ($("#fParticipant").value) params.set("participant_id", $("#fParticipant").value);
  if ($("#fCard").value) params.set("card_pseudonym", $("#fCard").value);
  if ($("#fFrom").value) params.set("from", $("#fFrom").value);
  if ($("#fTo").value) params.set("to", $("#fTo").value);
  const data = await api("/v1/transactions?" + params);
  $("#txNote").textContent =
    data.transactions.length + " 件" +
    (data.deduped ? "（別仮名で重複していた " + data.deduped + " 件を統合）" : "");
  $("#txTable").querySelector("tbody").innerHTML = data.transactions.map((t) => {
    const label = (text, code) =>
      !code ? "" : text === code
        ? '<span class="unmapped hex" title="駅マスタ未収載">' + esc(code) + "</span>"
        : esc(text);
    return "<tr>" +
      "<td>" + esc(t.used_date ?? "—") + "</td>" +
      "<td>" + esc(t.proc_type_label) + "</td>" +
      "<td>" + label(t.entry_label, t.entry_station_code) + "</td>" +
      "<td>" + label(t.exit_label, t.exit_station_code) + "</td>" +
      '<td class="num">' + yen(t.balance) + "</td>" +
      '<td class="num">' + (t.amount_estimated === null ? '<span class="note">推定不可</span>' : yen(t.amount_estimated)) + "</td>" +
      "<td>" + esc(t.participant_id ?? "未割当") + "</td>" +
      '<td class="hex">' + esc(t.source_raw_hex) + "</td>" +
      '<td class="hex">' + esc(t.first_session_id) + "</td>" +
      "</tr>";
  }).join("");
}
$("#reload").onclick = loadTransactions;
$("#csv").onclick = () => {
  // CSV も Authorization が要るので fetch → Blob でダウンロードする
  const params = new URLSearchParams();
  if ($("#fParticipant").value) params.set("participant_id", $("#fParticipant").value);
  if ($("#fCard").value) params.set("card_pseudonym", $("#fCard").value);
  fetch("/v1/transactions.csv?" + params, { headers: { Authorization: "Bearer " + token } })
    .then((r) => r.blob())
    .then((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "transactions.csv";
      a.click();
    });
};

async function loadSessions() {
  const data = await api("/v1/sessions");
  $("#sessionTable").querySelector("tbody").innerHTML = data.sessions.map((s) =>
    "<tr>" +
    "<td>" + esc(s.received_at) + "</td>" +
    "<td>" + esc(s.read_at) + "</td>" +
    '<td class="hex">' + esc(s.card_pseudonym) + "</td>" +
    "<td>" + esc(s.participant_id ?? "未割当") + "</td>" +
    '<td class="num">' + s.raw_count + "</td>" +
    "<td>" + esc(s.client_version ?? "") + "</td>" +
    '<td><button class="action secondary" data-session="' + esc(s.session_id) + '">生データ</button></td>' +
    "</tr>").join("");
  $("#sessionTable").querySelectorAll("button[data-session]").forEach((btn) => {
    btn.onclick = async () => {
      const data = await api("/v1/sessions/" + encodeURIComponent(btn.dataset.session) + "/raw");
      $("#rawPanel").hidden = false;
      $("#rawTable").querySelector("tbody").innerHTML = data.raw_observations.map((r) =>
        "<tr><td>" + r.id + "</td><td>" + r.block_order + '</td><td class="hex">' +
        esc(r.raw_hex) + "</td><td>" + esc(r.received_at) + "</td></tr>").join("");
      $("#rawPanel").scrollIntoView({ behavior: "smooth" });
    };
  });
}

async function loadCardsAndParticipants() {
  const [{ participants }, { cards }] = await Promise.all([api("/v1/participants"), api("/v1/cards")]);
  $("#participantTable").querySelector("tbody").innerHTML = participants.map((p) =>
    "<tr><td>" + esc(p.participant_id) + "</td><td>" + esc(p.label ?? "") +
    '</td><td class="num">' + p.card_count + "</td><td>" + esc(p.created_at) + "</td></tr>").join("");

  const options = '<option value="">すべて</option>' +
    participants.map((p) => '<option value="' + esc(p.participant_id) + '">' + esc(p.participant_id) + "</option>").join("");
  $("#fParticipant").innerHTML = options;
  $("#fCard").innerHTML = '<option value="">すべて</option>' +
    cards.map((c) => '<option value="' + esc(c.card_pseudonym) + '">' + esc(c.card_pseudonym.slice(0, 16)) + "…</option>").join("");

  $("#cardTable").querySelector("tbody").innerHTML = cards.map((c) =>
    "<tr>" +
    '<td class="hex">' + esc(c.card_pseudonym) + "</td>" +
    "<td>" + esc(c.participant_id ?? "未割当") + "</td>" +
    '<td class="num">' + c.session_count + "</td>" +
    '<td class="num">' + c.transaction_count + "</td>" +
    "<td>" + esc(c.last_received_at) + "</td>" +
    "<td>" + (c.participant_id ? "" :
      '<input size="8" placeholder="P001" data-link="' + esc(c.card_pseudonym) + '">' +
      '<button class="action secondary" data-linkbtn="' + esc(c.card_pseudonym) + '">紐付け</button>') +
    "</td></tr>").join("");

  $("#cardTable").querySelectorAll("button[data-linkbtn]").forEach((btn) => {
    btn.onclick = async () => {
      const pseudonym = btn.dataset.linkbtn;
      const input = $('input[data-link="' + CSS.escape(pseudonym) + '"]');
      await api("/v1/participants/" + encodeURIComponent(input.value.trim()) + "/cards", {
        method: "POST",
        body: JSON.stringify({ card_pseudonym: pseudonym }),
      });
      refreshAll();
    };
  });
}

$("#addParticipant").onclick = async () => {
  await api("/v1/participants", {
    method: "POST",
    body: JSON.stringify({
      participant_id: $("#newParticipantId").value.trim(),
      label: $("#newParticipantLabel").value.trim() || null,
    }),
  });
  $("#newParticipantId").value = "";
  $("#newParticipantLabel").value = "";
  refreshAll();
};

$("#send").onclick = async () => {
  try {
    const result = await api("/v1/ingest", { method: "POST", body: $("#ingestBody").value });
    $("#ingestResult").hidden = false;
    $("#ingestResult").textContent = JSON.stringify(result, null, 2);
    refreshAll();
  } catch (e) {
    $("#ingestResult").hidden = false;
    $("#ingestResult").textContent = "エラー: " + e.message;
  }
};

$("#fillSample").onclick = () => {
  // 1件だけの最小サンプル。16バイトの内訳は src/parser/cybernetics_v1.ts 参照。
  //   16 01 00 01 | 3509(2026-08-09) | 2E01(入 大阪) 2E05(出 京橋)
  //   | 1027(残額10000円, LE) | 000001(連番) | 01(近畿)
  $("#ingestBody").value = JSON.stringify({
    session_id: crypto.randomUUID(),
    card_pseudonym: "mockcard-webui-000000000000000000000000000000",
    device_id: "mock-device",
    read_at: new Date().toISOString(),
    client_version: "webui/0.1.0",
    participant_id: "P001",
    blocks: ["160100013509" + "2E012E05" + "1027" + "000001" + "01"],
  }, null, 2);
};

async function refreshAll() {
  try {
    await Promise.all([loadDash(), loadTransactions(), loadSessions(), loadCardsAndParticipants()]);
  } catch (e) {
    $("#parserVersion").innerHTML = '<span class="warn">' + esc(e.message) + "（APIトークンを確認してください）</span>";
  }
}
refreshAll();
</script>
</body>
</html>`;
