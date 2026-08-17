/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SYNC_URL?: string;
  /** 公開面(visit-self)のURL。来場者向け場所QRの生成に使う */
  readonly VITE_SELF_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
