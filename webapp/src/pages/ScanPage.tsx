import { Html5Qrcode, Html5QrcodeScannerState } from "html5-qrcode";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import FeedbackOverlay, { type Feedback } from "../components/FeedbackOverlay";
import ManualEntryDialog from "../components/ManualEntryDialog";
import { initAudio, playError, playSuccess, playWarn, vibrate } from "../lib/audio";
import {
  commitPending,
  db,
  recordManual,
  recordScan,
  type CheckinOutcome,
  type CheckinRow,
  type EventRow,
} from "../lib/db";
import { formatTime } from "../lib/format";

const SCANNER_ELEMENT_ID = "scanner-region";
/** 同一デコード文字列のクールダウン（連写抑止） */
const COOLDOWN_MS = 2500;

export default function ScanPage() {
  const { eventId = "" } = useParams();
  // undefined = 読み込み中 / null = 該当なし
  const event = useLiveQuery(async () => (await db.events.get(eventId)) ?? null, [eventId]);
  const count = useLiveQuery(
    () => db.checkins.where("eventId").equals(eventId).count(),
    [eventId],
    0
  );
  const dupCount = useLiveQuery(
    () =>
      db.scanErrors
        .where("eventId")
        .equals(eventId)
        .and((r) => r.kind === "duplicate")
        .count(),
    [eventId],
    0
  );
  const invalidCount = useLiveQuery(
    () =>
      db.scanErrors
        .where("eventId")
        .equals(eventId)
        .and((r) => r.kind === "invalid_format")
        .count(),
    [eventId],
    0
  );

  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [feedback, setFeedbackState] = useState<Feedback | null>(null);
  // 読み取れないときの原因切り分け用。カメラが動いているか / 何を読んだか を可視化する
  const [diagOpen, setDiagOpen] = useState(false);
  const [diag, setDiag] = useState({
    frames: 0,
    videoSize: "—",
    lastRaw: "",
    lastFormat: "",
  });
  const frameCountRef = useRef(0);
  const lastDiagPushRef = useRef(0);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const unmountedRef = useRef(false);
  const eventRef = useRef<EventRow | undefined>(undefined);
  const lastSeenRef = useRef(new Map<string, number>());
  const busyRef = useRef(false);
  const feedbackRef = useRef<Feedback | null>(null);
  const feedbackTimerRef = useRef<number | undefined>(undefined);

  eventRef.current = event ?? undefined;

  const setFeedback = useCallback((fb: Feedback | null, autoHideMs: number | null) => {
    window.clearTimeout(feedbackTimerRef.current);
    feedbackRef.current = fb;
    setFeedbackState(fb);
    if (fb && autoHideMs !== null) {
      feedbackTimerRef.current = window.setTimeout(() => {
        feedbackRef.current = null;
        setFeedbackState(null);
      }, autoHideMs);
    }
  }, []);

  const forceRecord = useCallback(
    async (row: CheckinRow, displaySuffix: string) => {
      await commitPending(row);
      playSuccess();
      vibrate(80);
      setFeedback(
        { kind: "ok", title: "チェックイン", sub: `＊＊${displaySuffix}（別人として記録）` },
        1200
      );
    },
    [setFeedback]
  );

  const presentOutcome = useCallback(
    (outcome: CheckinOutcome) => {
      if (outcome.status === "ok") {
        playSuccess();
        vibrate(80);
        setFeedback(
          {
            kind: "ok",
            title: "チェックイン",
            sub: `＊＊＊＊＊＊＊＊${outcome.displaySuffix}`,
          },
          900
        );
        return;
      }
      if (outcome.status === "duplicate") {
        playWarn();
        vibrate([60, 60, 60]);
        const sub = `${formatTime(outcome.matchedAt)} に受付済み`;
        if (outcome.pendingRow) {
          const row = outcome.pendingRow;
          const suffix = outcome.displaySuffix;
          setFeedback(
            {
              kind: "duplicate",
              title: "チェックイン済の可能性",
              sub: `末尾一致・${sub}`,
              actions: [
                { label: "別人として記録する", onClick: () => void forceRecord(row, suffix) },
                { label: "閉じる", onClick: () => setFeedback(null, null) },
              ],
            },
            null
          );
        } else {
          setFeedback({ kind: "duplicate", title: "チェックイン済", sub }, 1800);
        }
        return;
      }
      playError();
      vibrate(300);
      setFeedback(
        {
          kind: "invalid",
          title: "対象外のコードです",
          sub: "WESTER会員証のバーコードを読み取ってください",
        },
        1600
      );
    },
    [forceRecord, setFeedback]
  );

  const onDetected = useCallback(
    async (text: string, symbology: string) => {
      const ev = eventRef.current;
      if (!ev || busyRef.current) return;
      // ボタン付き警告の表示中は新規読取を無視（誤操作防止）
      if (feedbackRef.current?.actions) return;
      const now = Date.now();
      const last = lastSeenRef.current.get(text);
      if (last !== undefined && now - last < COOLDOWN_MS) return;
      if (lastSeenRef.current.size > 200) lastSeenRef.current.clear();
      lastSeenRef.current.set(text, now);
      busyRef.current = true;
      try {
        const outcome = await recordScan(ev, text, symbology);
        presentOutcome(outcome);
      } finally {
        busyRef.current = false;
      }
    },
    [presentOutcome]
  );

  const startCamera = useCallback(async () => {
    if (starting || running) return;
    setStarting(true);
    setCameraError(null);
    initAudio(); // ユーザー操作起点でAudioContextを初期化（iOS対策）
    try {
      // formatsToSupport は指定しない = 全形式を読取対象にする。
      // 形式を絞ると対象外のコードでは一切コールバックが返らず「完全な無音」に
      // なり、カメラが動いているかすら分からない。全形式を受け取ったうえで
      // normalizeScan で判定し、対象外は赤表示で明確に返す
      const scanner = scannerRef.current ?? new Html5Qrcode(SCANNER_ELEMENT_ID, { verbose: false });
      scannerRef.current = scanner;
      // 第1引数は html5-qrcode の仕様上キーを1つしか渡せない。
      // 解像度指定は configuration.videoConstraints 側で行う
      await scanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          // qrbox は指定しない = 映像全体を判定対象にする。
          // 枠を指定すると判定領域と映像の位置がずれた場合に永久に読めなくなるため、
          // 画面上の枠（.scan-guide）はあくまで位置合わせの目安として表示する
          videoConstraints: {
            facingMode: "environment",
            // Codabar等の1Dバーコードは細いバーの解像度が要るため高解像度を要求する
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        },
        (decodedText, result) => {
          const format = (
            result as { result?: { format?: { formatName?: unknown } } } | undefined
          )?.result?.format?.formatName;
          const symbology = typeof format === "string" ? format : "UNKNOWN";
          setDiag((d) => ({ ...d, lastRaw: decodedText, lastFormat: symbology }));
          void onDetected(decodedText, symbology);
        },
        // 各フレームで何も見つからないたびに呼ばれる。
        // これが増えていれば「カメラは動いていて読取処理も回っている」ことの証拠になる
        () => {
          frameCountRef.current += 1;
          const now = Date.now();
          if (now - lastDiagPushRef.current > 500) {
            lastDiagPushRef.current = now;
            const video = document.querySelector<HTMLVideoElement>(`#${SCANNER_ELEMENT_ID} video`);
            setDiag((d) => ({
              ...d,
              frames: frameCountRef.current,
              videoSize: video ? `${video.videoWidth}×${video.videoHeight}` : "—",
            }));
          }
        }
      );
      // カメラ起動中に画面を離れた場合の後始末
      if (unmountedRef.current) {
        await scanner.stop().catch(() => {});
        return;
      }
      setRunning(true);
    } catch (e) {
      setCameraError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [onDetected, running, starting]);

  const stopCamera = useCallback(async () => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    const state = scanner.getState();
    if (
      state === Html5QrcodeScannerState.SCANNING ||
      state === Html5QrcodeScannerState.PAUSED
    ) {
      await scanner.stop().catch(() => {});
    }
    setRunning(false);
  }, []);

  const restartCamera = useCallback(async () => {
    await stopCamera();
    await startCamera();
  }, [startCamera, stopCamera]);

  // 画面離脱時にカメラを確実に停止
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      const scanner = scannerRef.current;
      if (scanner) {
        const state = scanner.getState();
        if (
          state === Html5QrcodeScannerState.SCANNING ||
          state === Html5QrcodeScannerState.PAUSED
        ) {
          scanner.stop().catch(() => {});
        }
      }
      window.clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  async function submitManual(digits: string) {
    const ev = eventRef.current;
    if (!ev) return;
    setManualOpen(false);
    initAudio();
    const outcome = await recordManual(ev, digits);
    presentOutcome(outcome);
  }

  if (event === undefined) {
    return (
      <main className="page">
        <p className="muted">読み込み中…</p>
      </main>
    );
  }
  if (event === null) {
    return (
      <main className="page">
        <p>
          イベントが見つかりません。<Link to="/">イベント選択へ戻る</Link>
        </p>
      </main>
    );
  }

  return (
    <div className="scan-screen">
      <header className="scan-header">
        <div className="scan-header-nav">
          <Link to="/" className="back-link">
            イベント
          </Link>
          <span className="scan-event-name">{event.name}</span>
          <Link to={`/admin/${event.id}`} className="back-link" style={{ fontWeight: 700 }}>
            管理
          </Link>
        </div>
        <div className="scan-count" aria-live="polite">
          <span className="scan-count-num">{count}</span>
          <span className="scan-count-unit">人</span>
        </div>
        <div className="scan-substats">
          チェックイン済の再読取 {dupCount} 件・対象外 {invalidCount} 件
        </div>
      </header>

      <div className="scan-camera-wrap">
        <div id={SCANNER_ELEMENT_ID} className="scan-camera" />
        {running && (
          <>
            <div className="scan-guide" aria-hidden="true" />
            <p className="scan-hint">
              枠に合わせるだけで自動で読み取ります（ボタン操作は不要）
            </p>
          </>
        )}
        {!running && (
          <div className="scan-start-panel">
            {cameraError ? (
              <>
                <p style={{ fontWeight: 700, color: "var(--color-error)" }}>
                  カメラを起動できませんでした
                </p>
                <p className="muted">
                  ブラウザのカメラ許可を確認してください（HTTPSでのアクセスが必要です）。
                  カメラが使えない場合は下の手入力をご利用ください。
                </p>
                <p className="muted" style={{ wordBreak: "break-all" }}>
                  {cameraError}
                </p>
              </>
            ) : (
              <p className="muted">
                「カメラを開始」を押して、WESTER会員証のバーコードを枠内にかざしてください。
              </p>
            )}
            <button
              type="button"
              className="btn btn-primary btn-xl btn-block"
              onClick={() => void startCamera()}
              disabled={starting}
            >
              {starting ? "起動中…" : "カメラを開始"}
            </button>
          </div>
        )}
      </div>

      <footer className="scan-footer">
        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={() => setManualOpen(true)}
        >
          手入力（末尾6桁）
        </button>
        {running && (
          <button
            type="button"
            className="btn btn-ghost btn-block"
            onClick={() => void restartCamera()}
          >
            カメラを再起動
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-block"
          style={{ minHeight: 40, fontSize: 14 }}
          onClick={() => setDiagOpen((v) => !v)}
        >
          {diagOpen ? "診断を閉じる" : "読み取れないとき（診断）"}
        </button>
        {diagOpen && (
          <div className="diag">
            <div>
              カメラ映像: <strong>{diag.videoSize}</strong>
            </div>
            <div>
              読取処理の実行回数: <strong>{diag.frames}</strong>
              {diag.frames > 0 ? "（増えていれば正常に動作中）" : "（0のままなら停止中）"}
            </div>
            <div>
              最後に読めたコード:{" "}
              <strong>{diag.lastRaw ? `${diag.lastRaw}（${diag.lastFormat}）` : "まだ1件もなし"}</strong>
            </div>
            <p className="diag-note">
              数字が増えているのにコードが読めない場合は、カメラは動いていて
              バーコードを認識できていない状態です。カードを画面いっぱいに近づける／
              少し離す／明るい場所で試してください。
            </p>
          </div>
        )}
      </footer>

      <FeedbackOverlay feedback={feedback} onClose={() => setFeedback(null, null)} />
      {manualOpen && (
        <ManualEntryDialog
          onSubmit={(digits) => void submitManual(digits)}
          onClose={() => setManualOpen(false)}
        />
      )}
    </div>
  );
}
