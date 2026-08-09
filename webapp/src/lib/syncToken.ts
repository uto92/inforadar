/// 同期先(Worker)への合言葉。
///
/// Cloudflare Access による保護は断念した。Access はホスト名がCloudflareの
/// ゾーンに属している必要があり（`*.pages.dev` / `*.workers.dev` は不可）、
/// そのためだけに会社ドメインのDNSをCloudflareへ移すのは、Google Workspaceの
/// メールを止めるリスクに見合わないと判断したため。
///
/// 代わりに、Workerが元から持つ Bearer トークン認証を使う。
/// トークンはJSバンドルに埋め込まず、受付スタッフが端末ごとに1回入力する。
/// バンドルに埋め込むと、URLを知る第三者が同期先のデータを読めてしまう。

const KEY = "wester-checkin.sync.token";

export function getSyncToken(): string | null {
  try {
    const value = localStorage.getItem(KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    // プライベートブラウズ等で localStorage が使えない場合
    return null;
  }
}

export function setSyncToken(token: string): void {
  try {
    const trimmed = token.trim();
    if (trimmed) localStorage.setItem(KEY, trimmed);
    else localStorage.removeItem(KEY);
  } catch {
    // 保存できなくても記録自体は続行できるため握りつぶす
  }
}

export function clearSyncToken(): void {
  setSyncToken("");
}
