import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // カメラ(getUserMedia)はHTTPS必須のため、スマホ実機での開発確認は
  // cloudflared等のトンネル越しに行う。Vite 5.4.12+ のHostヘッダ検査を
  // トンネルドメインに対して許可しておく（dev/previewサーバのみに影響）。
  server: {
    allowedHosts: [".trycloudflare.com"],
  },
  preview: {
    allowedHosts: [".trycloudflare.com"],
  },
});
