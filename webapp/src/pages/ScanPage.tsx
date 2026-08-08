import { Html5Qrcode, Html5QrcodeScannerState, Html5QrcodeSupportedFormats } from "html5-qrcode";
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
      const scanner =
        scannerRef.current ??
        new Html5Qrcode(SCANNER_ELEMENT_ID, {
          formatsToSupport: [
            Html5QrcodeSupportedFormats.QR_CODE,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODABAR,
          ],
          verbose: false,
        });
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: (viewfinderWidth, viewfinderHeight) => ({
            width: Math.floor(Math.min(viewfinderWidth * 0.9, 480)),
            height: Math.floor(Math.min(viewfinderHeight * 0.45, 240)),
          }),
        },
        (decodedText, result) => {
          const format = (
            result as { result?: { format?: { formatName?: unknown } } } | undefined
          )?.result?.format?.formatName;
          void onDetected(decodedText, typeof format === "string" ? format : "UNKNOWN");
        },
        undefined
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
