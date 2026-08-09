/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/index";

declare global {
  namespace Cloudflare {
    // テスト用の追加バインディング。TEST_MIGRATIONS は vitest.config.ts で
    // migrations/ を読み込んで渡している（本番と同じDDLでテストするため）
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

type WorkerEnv = Env;

export {};
