import { liveQuery } from "dexie";
import { db } from "../db";
import { resolveBackend, type SyncBackend } from "./backend";

/// オフラインファースト同期エンジン。
/// - liveQuery で未同期件数を監視し、書き込みがあれば自動でpush
/// - online復帰イベントでも起動
/// - 失敗時は指数バックオフ（2, 4, 8, … 最大300秒）
/// - Supabase未設定なら "local-only" のまま何もしない

export type SyncMode = "local-only" | "offline" | "idle" | "syncing" | "error";

export interface SyncState {
  mode: SyncMode;
  pending: number;
  lastError: string | null;
  lastSyncedAt: string | null;
}

const BATCH_SIZE = 100;
/** 取得位置の保存先。端末ごとに持つ */
const SINCE_KEY = "wester-checkin.sync.since";
/** 1回のrunで行うpullの最大回数（hasMore時の追従。無限ループ防止） */
const MAX_PULL_PAGES = 20;
/**
 * 定期同期の間隔。
 * 送るものが無い端末（他端末の記録を見るだけの端末や管理画面）は
 * 未同期件数の変化で起動しないため、定期的に自分から取りに行く必要がある。
 */
const POLL_INTERVAL_MS = 20_000;

class SyncEngine {
  private backend: SyncBackend | null = resolveBackend();
  private listeners = new Set<() => void>();
  private started = false;
  private running = false;
  private failures = 0;
  private retryTimer: number | undefined;
  private state: SyncState = {
    mode: this.backend ? "idle" : "local-only",
    pending: 0,
    lastError: null,
    lastSyncedAt: null,
  };

  /** アプリ起動時に一度呼ぶ（多重呼び出しは無視） */
  start(): void {
    if (this.started) return;
    this.started = true;
    liveQuery(async () => {
      const [e, p, c, s] = await Promise.all([
        db.events.where("synced").equals(0).count(),
        db.places.where("synced").equals(0).count(),
        db.checkins.where("synced").equals(0).count(),
        db.scanErrors.where("synced").equals(0).count(),
      ]);
      // places を送れない同期先（pushPlaces未実装）では未同期の場所が
      // 永久に解消せず「未同期 N件」が出続けるため、pending から除く
      const placesPending = this.backend?.pushPlaces ? p : 0;
      return e + placesPending + c + s;
    }).subscribe({
      next: (pending) => {
        this.patch({ pending });
        if (pending > 0) this.kick();
      },
      error: () => {},
    });
    window.addEventListener("online", () => {
      this.failures = 0;
      this.clearRetry();
      this.refreshMode();
      this.kick();
    });
    window.addEventListener("offline", () => this.refreshMode());
    // 画面に戻ってきたときは即座に最新化する（他端末の記録を反映）
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.kick();
    });
    this.refreshMode();
    // 起動直後に一度取りに行く。送るものが無くても他端末ぶんを取り込むため
    this.kick();
    window.setInterval(() => this.kick(), POLL_INTERVAL_MS);
  }

  get hasBackend(): boolean {
    return this.backend !== null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SyncState => this.state;

  /** 手動「今すぐ同期」は force=true で呼ぶ（バックオフ待ちを解除） */
  kick(force = false): void {
    if (!this.backend) return;
    if (force) {
      this.failures = 0;
      this.clearRetry();
    }
    if (!navigator.onLine) {
      this.refreshMode();
      return;
    }
    if (this.running || this.retryTimer !== undefined) return;
    void this.run();
  }

  private async run(): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    this.running = true;
    this.patch({ mode: "syncing" });
    try {
      // FK順: events → checkins → scan_errors。各テーブルを空になるまでバッチ送信
      for (;;) {
        const events = await db.events.where("synced").equals(0).limit(BATCH_SIZE).toArray();
        if (events.length > 0) {
          await backend.pushEvents(events);
          await db.events.where("id").anyOf(events.map((r) => r.id)).modify({ synced: 1 });
          continue;
        }
        const places = await db.places.where("synced").equals(0).limit(BATCH_SIZE).toArray();
        if (places.length > 0 && backend.pushPlaces) {
          await backend.pushPlaces(places);
          // places は可変（selfEnabled/nameの編集がある）。push待機中にユーザーが
          // 同じ行を編集していると、その編集は未送信のまま synced:1 で潰され、
          // 直後のpullで古い値へ巻き戻る（レビュー指摘）。送信した内容と現在値が
          // 一致する行だけを synced:1 にし、割り込み編集は synced:0 のまま残す。
          await db.transaction("rw", db.places, async () => {
            for (const sent of places) {
              const current = await db.places.get(sent.id);
              if (
                current &&
                current.synced === 0 &&
                current.name === sent.name &&
                current.selfEnabled === sent.selfEnabled
              ) {
                await db.places.update(sent.id, { synced: 1 });
              }
            }
          });
          continue;
        }
        const checkins = await db.checkins.where("synced").equals(0).limit(BATCH_SIZE).toArray();
        if (checkins.length > 0) {
          await backend.pushCheckins(checkins);
          await db.checkins.where("id").anyOf(checkins.map((r) => r.id)).modify({ synced: 1 });
          continue;
        }
        const errors = await db.scanErrors.where("synced").equals(0).limit(BATCH_SIZE).toArray();
        if (errors.length > 0) {
          await backend.pushScanErrors(errors);
          await db.scanErrors.where("id").anyOf(errors.map((r) => r.id)).modify({ synced: 1 });
          continue;
        }
        break;
      }
      // pushを終えてからpull。他端末ぶんを取り込む
      await this.pull(backend);
      this.failures = 0;
      this.patch({ mode: "idle", lastError: null, lastSyncedAt: new Date().toISOString() });
    } catch (e) {
      this.failures += 1;
      const message = e instanceof Error ? e.message : String(e);
      this.patch({ mode: "error", lastError: message });
      const delaySec = Math.min(2 ** this.failures, 300);
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = undefined;
        this.kick();
      }, delaySec * 1000);
    } finally {
      this.running = false;
    }
  }

  /**
   * 他端末ぶんの取り込み。
   * 取り込んだ行は synced: 1 で保存する（自分が送り返す必要はないため）。
   * 既に同じidがある場合は上書きしない。ローカルが常に正で、
   * 自端末の記録がサーバ由来のデータで書き換わることを避ける。
   */
  private async pull(backend: SyncBackend): Promise<void> {
    if (!backend.pull) return;
    let since = localStorage.getItem(SINCE_KEY);
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const result = await backend.pull(since);
      const newEvents = result.events.filter((r) => r.id);
      const pulledPlaces = (result.places ?? []).filter((r) => r.id);
      const newCheckins = result.checkins.filter((r) => r.id);
      const newErrors = result.scanErrors.filter((r) => r.id);

      if (newEvents.length > 0) {
        // salt はサーバに無い。他端末が作ったイベントは、そのままでは
        // ハッシュ照合ができないため空文字を入れて「読み取り不可」を明示する。
        // （同一イベントを複数端末で回す運用はソルト共有が前提。別途対応）
        const existing = new Set(
          (await db.events.where("id").anyOf(newEvents.map((r) => r.id)).toArray()).map((r) => r.id)
        );
        const toAdd = newEvents
          .filter((r) => !existing.has(r.id))
          .map((r) => ({ ...r, salt: "", synced: 1 as const }));
        if (toAdd.length > 0) await db.events.bulkAdd(toAdd);
      }
      if (pulledPlaces.length > 0) {
        // 場所は name / selfEnabled の変更が他端末から届くため、
        // ローカルに未送信の変更（synced:0）が無い行に限り上書きを許す
        for (const pl of pulledPlaces) {
          const existing = await db.places.get(pl.id);
          if (!existing) {
            await db.places.add({ ...pl, synced: 1 });
          } else if (existing.synced === 1) {
            await db.places.update(pl.id, {
              name: pl.name,
              selfEnabled: pl.selfEnabled,
              synced: 1,
            });
          }
        }
      }
      if (newCheckins.length > 0) {
        const existing = new Set(
          (await db.checkins.where("id").anyOf(newCheckins.map((r) => r.id)).toArray()).map(
            (r) => r.id
          )
        );
        const toAdd = newCheckins
          .filter((r) => !existing.has(r.id))
          .map((r) => ({ ...r, synced: 1 as const }));
        if (toAdd.length > 0) await db.checkins.bulkAdd(toAdd);
      }
      if (newErrors.length > 0) {
        const existing = new Set(
          (await db.scanErrors.where("id").anyOf(newErrors.map((r) => r.id)).toArray()).map(
            (r) => r.id
          )
        );
        const toAdd = newErrors
          .filter((r) => !existing.has(r.id))
          .map((r) => ({ ...r, synced: 1 as const }));
        if (toAdd.length > 0) await db.scanErrors.bulkAdd(toAdd);
      }

      since = result.nextSince;
      localStorage.setItem(SINCE_KEY, since);
      if (!result.hasMore) return;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private refreshMode(): void {
    if (!this.backend) {
      this.patch({ mode: "local-only" });
      return;
    }
    if (!navigator.onLine) {
      this.patch({ mode: "offline" });
      return;
    }
    if (!this.running && this.state.mode === "offline") {
      this.patch({ mode: "idle" });
    }
  }

  private patch(partial: Partial<SyncState>): void {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((listener) => listener());
  }
}

export const syncEngine = new SyncEngine();
