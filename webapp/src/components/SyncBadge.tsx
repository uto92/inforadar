import { useSyncExternalStore } from "react";
import { syncEngine } from "../lib/sync/engine";

export default function SyncBadge() {
  const state = useSyncExternalStore(syncEngine.subscribe, syncEngine.getSnapshot);

  let tone = "gray";
  let label = "";
  switch (state.mode) {
    case "local-only":
      tone = "gray";
      label = "ローカル保存のみ";
      break;
    case "offline":
      tone = state.pending > 0 ? "orange" : "gray";
      label = state.pending > 0 ? `オフライン・未送信 ${state.pending}件` : "オフライン";
      break;
    case "syncing":
      tone = "blue";
      label = "同期中…";
      break;
    case "error":
      tone = "red";
      label = `同期エラー・未送信 ${state.pending}件`;
      break;
    default:
      tone = state.pending > 0 ? "orange" : "green";
      label = state.pending > 0 ? `未同期 ${state.pending}件` : "同期済み";
  }

  return <span className={`badge badge-${tone}`}>{label}</span>;
}
