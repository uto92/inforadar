/// Cloudflare Access が付与するJWT（Cf-Access-Jwt-Assertion）の検証。
///
/// ブラウザ(webapp)は資格情報を持たない。代わりに Access が認証済みリクエストに
/// JWTを付けてWorkerへ渡すので、それを検証する。これにより
/// 「anonキー相当をJSバンドルに埋め込む」必要がなくなる。
///
/// Access を経由しない直リクエストにはこのヘッダが無いため弾かれる。
/// Access の設定漏れで素通しになる事故に備え、Worker側でも必ず検証する。

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

/** JWKSの再取得間隔。鍵のローテーションに追従しつつ毎回の取得は避ける */
const JWKS_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, CachedKeys>();

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
  } catch {
    return null;
  }
}

async function loadKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const cached = cache.get(teamDomain);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS取得に失敗 (HTTP ${res.status})`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    keys.set(jwk.kid, key);
  }
  cache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

export interface AccessConfig {
  /** 例: your-team.cloudflareaccess.com */
  teamDomain: string;
  /**
   * Access アプリケーションの Audience (AUD) タグ。省略可。
   *
   * AUDの役割は「同一チーム内の別アプリ向けに発行されたトークンを弾く」こと。
   * アプリが1つだけなら実質的な差は無いため、未設定でも動くようにしている
   * （新しい管理画面ではAUDが表示されず、取得できない場合があるため）。
   * アプリを増やす場合は必ず設定すること。
   */
  aud?: string;
}

/**
 * 検証に成功すれば認証済みユーザのメールアドレス、失敗すれば null。
 * 例外は投げず null に倒す（呼び出し側で401にする）。
 */
export async function verifyAccessJwt(
  request: Request,
  config: AccessConfig
): Promise<string | null> {
  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    // ブラウザからの通常アクセスではCookieにも入る
    /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get("Cookie") ?? "")?.[1] ??
    null;
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, signatureSeg] = parts;

  const header = decodeJson(headerSeg);
  const payload = decodeJson(payloadSeg);
  if (!header || !payload) return null;
  if (header.alg !== "RS256") return null;
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (!kid) return null;

  let keys: Map<string, CryptoKey>;
  try {
    keys = await loadKeys(config.teamDomain);
  } catch {
    return null;
  }
  const key = keys.get(kid);
  if (!key) return null;

  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(signatureSeg),
    new TextEncoder().encode(`${headerSeg}.${payloadSeg}`)
  );
  if (!verified) return null;

  // 署名が正しくても、別アプリ向け・期限切れのトークンは拒否する
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const nbf = typeof payload.nbf === "number" ? payload.nbf : 0;
  if (exp <= now) return null;
  if (nbf > now + 60) return null;
  if (payload.iss !== `https://${config.teamDomain}`) return null;
  if (config.aud) {
    const aud = payload.aud;
    const audOk = Array.isArray(aud) ? aud.includes(config.aud) : aud === config.aud;
    if (!audOk) return null;
  }

  return typeof payload.email === "string" ? payload.email : "";
}
