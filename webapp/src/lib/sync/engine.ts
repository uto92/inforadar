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
      const [e, c, s] = await Promise.all([
        db.events.where("synced").equals(0).count(),
        db.checkins.where("synced").equals(0).count(),
        db.scanErrors.where("synced").equals(0).count(),
      ]);
      return e + c + s;
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
    this.refreshMode();
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
