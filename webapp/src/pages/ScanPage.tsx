import Quagga, { type QuaggaJSCodeReader } from "@ericblade/quagga2";
import jsQR from "jsqr";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import FeedbackOverlay, { type Feedback } from "../components/FeedbackOverlay";
import ManualEntryDialog from "../components/ManualEntryDialog";
import { initAudio, playError, playSuccess, playWarn, vibrate } from "../lib/audio";
import {
  commitPending,
  db,
  getDevicePlace,
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
/** 「読み取り」押下後、読取を受け付ける時間 */
const ARM_WINDOW_MS = 5000;
/**
 * 読み取り対象の1Dバーコード。WESTER会員証はCodabar想定。
 * html5-qrcode(ZXing系)はCodabarを読めなかったため Quagga2 に移行した
 * （検証: 同一のCodabar画像で html5-qrcode=失敗 / Quagga2=成功）。
 * 想定外の形式でも読めれば「対象外」と明示できるよう広めに有効化する
 */
const READERS: QuaggaJSCodeReader[] = [
  "codabar_reader",
  "code_128_reader",
  "code_39_reader",
  "code_93_reader",
  "ean_reader",
  "ean_8_reader",
  "i2of5_reader",
  "2of5_reader",
  "upc_reader",
  "upc_e_reader",
];
/**
 * QRの解析間隔。Quagga2は1次元専用のため、同じ映像から別途QRを解析する。
 * 会員証をQRで表示するサービスが多く、これが無いと全く反応しない。
 */
const QR_INTERVAL_MS = 250;

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

  // この端末の受付場所。読取時に checkin へ刻印する
  const devicePlaceId = useLiveQuery(() => getDevicePlace(eventId), [eventId], null);
  const devicePlace = useLiveQuery(
    async () => (devicePlaceId ? ((await db.places.get(devicePlaceId)) ?? null) : null),
    [devicePlaceId],
    null
  );
  const placeIdRef = useRef<string | null>(null);
  placeIdRef.current = devicePlaceId ?? null;

  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [arming, setArming] = useState(false);
  const [feedback, setFeedbackState] = useState<Feedback | null>(null);

  const startedRef = useRef(false);
  // 誤読対策: 同じ値を連続2回読めたときだけ確定する
  const pendingCodeRef = useRef<string | null>(null);
  // 「読み取り」を押している間だけ記録する。押していない間の読取は無視するため、
  // 意図しないタイミングで勝手にチェックインが積み上がらない
  const armedRef = useRef(false);
  const armTimerRef = useRef<number | undefined>(undefined);
  const qrTimerRef = useRef<number | undefined>(undefined);
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // 読取ハンドラは Quagga とQRループの両方から使う。最新の関数を ref で参照する
  const onDetectedRef = useRef<(text: string, symbology: string) => void>(() => {});
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
          sub: "会員証・ポイントカードのバーコードを読み取ってください",
        },
        1600
      );
    },
    [forceRecord, setFeedback]
  );

  /** 読み取り待機の解除。成功時・失敗時どちらからも呼ぶ */
  const disarm = useCallback(() => {
    window.clearTimeout(armTimerRef.current);
    armedRef.current = false;
    pendingCodeRef.current = null;
    setArming(false);
  }, []);

  /** 「読み取り」押下。この待機中に読めたものだけを記録する */
  const arm = useCallback(() => {
    if (!startedRef.current) return;
    initAudio();
    window.clearTimeout(armTimerRef.current);
    pendingCodeRef.current = null;
    armedRef.current = true;
    setArming(true);
    armTimerRef.current = window.setTimeout(() => {
      if (!armedRef.current) return;
      disarm();
      playError();
      vibrate(200);
      setFeedback(
        {
          kind: "invalid",
          title: "読み取れませんでした",
          sub: "バーコードを枠に合わせて、もう一度お試しください",
        },
        1600
      );
    }, ARM_WINDOW_MS);
  }, [disarm, setFeedback]);

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
      disarm();
      try {
        const outcome = await recordScan(ev, text, symbology, placeIdRef.current);
        presentOutcome(outcome);
      } finally {
        busyRef.current = false;
      }
    },
    [disarm, presentOutcome]
  );

  /**
   * QRの解析ループ。Quagga2が描画している映像から自前でフレームを取り出し、
   * jsQRにかける。1次元の読み取りと同じく「読み取り」押下中のみ記録する。
   */
  const startQrLoop = useCallback(() => {
    window.clearInterval(qrTimerRef.current);
    qrTimerRef.current = window.setInterval(() => {
      if (!armedRef.current || busyRef.current) return;
      const video = document.querySelector<HTMLVideoElement>(`#${SCANNER_ELEMENT_ID} video`);
      if (!video || !video.videoWidth) return;
      // 解析用に縮小する。等倍だと処理が重く、フレーム落ちで読み取り率が下がる
      const w = 640;
      const h = Math.round((video.videoHeight / video.videoWidth) * w);
      const canvas = (qrCanvasRef.current ??= document.createElement("canvas"));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, w, h);
      const image = ctx.getImageData(0, 0, w, h);
      const found = jsQR(image.data, w, h, { inversionAttempts: "attemptBoth" });
      if (found?.data) void onDetectedRef.current(found.data, "QR_CODE");
    }, QR_INTERVAL_MS);
  }, []);

  onDetectedRef.current = onDetected;

  const startCamera = useCallback(async () => {
    if (starting || running) return;
    setStarting(true);
    setCameraError(null);
    initAudio(); // ユーザー操作起点でAudioContextを初期化（iOS対策）
    try {
      const target = document.getElementById(SCANNER_ELEMENT_ID);
      if (!target) throw new Error("カメラの表示先が見つかりません");
      await new Promise<void>((resolve, reject) => {
        Quagga.init(
          {
            inputStream: {
              type: "LiveStream",
              target: target as HTMLElement,
              constraints: {
                facingMode: "environment",
                // 1Dバーコードは細いバーの解像度が要るため高解像度を要求する
                width: { ideal: 1920 },
                height: { ideal: 1080 },
              },
            },
            decoder: { readers: READERS },
            locate: true,
            // iOS Safari ではWorkerが不安定なためメインスレッドで処理する
            numOfWorkers: 0,
            frequency: 10,
          },
          (err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())
        );
      });
      // カメラ起動中に画面を離れた場合の後始末
      if (unmountedRef.current) {
        Quagga.stop();
        return;
      }
      Quagga.start();
      startedRef.current = true;
      startQrLoop();
      setRunning(true);
    } catch (e) {
      setCameraError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [running, starting]);

  const stopCamera = useCallback(async () => {
    window.clearInterval(qrTimerRef.current);
    qrTimerRef.current = undefined;
    if (startedRef.current) {
      Quagga.stop();
      startedRef.current = false;
    }
    setRunning(false);
  }, []);

  const restartCamera = useCallback(async () => {
    await stopCamera();
    await startCamera();
  }, [startCamera, stopCamera]);

  useEffect(() => {
    const handleDetected = (result: unknown) => {
      // 「読み取り」を押していない間の検出は捨てる
      if (!armedRef.current) return;
      const r = result as { codeResult?: { code?: string; format?: string } } | undefined;
      const code = r?.codeResult?.code;
      if (!code) return;
      const symbology = r?.codeResult?.format ?? "UNKNOWN";
      // 記録は連続2回同じ値が読めてから。1回の誤読で誤ったチェックインを作らない
      if (pendingCodeRef.current !== code) {
        pendingCodeRef.current = code;
        return;
      }
      pendingCodeRef.current = null;
      void onDetectedRef.current(code, symbology);
    };
    Quagga.onDetected(handleDetected);
    return () => {
      Quagga.offDetected(handleDetected);
    };
  }, []);

  // 画面離脱時にカメラを確実に停止
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      if (startedRef.current) {
        Quagga.stop();
        startedRef.current = false;
      }
      window.clearTimeout(feedbackTimerRef.current);
      window.clearTimeout(armTimerRef.current);
      window.clearInterval(qrTimerRef.current);
    };
  }, []);

  async function submitManual(digits: string) {
    const ev = eventRef.current;
    if (!ev) return;
    setManualOpen(false);
    initAudio();
    const outcome = await recordManual(ev, digits, placeIdRef.current);
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
          <span className="scan-event-name">
            {event.name}
            {devicePlace ? `｜${devicePlace.name}` : ""}
          </span>
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
            <div className={`scan-guide${arming ? " scan-guide-active" : ""}`} aria-hidden="true" />
            <p className="scan-hint">
              {arming
                ? "読み取り中… バーコードを枠に合わせてください"
                : "バーコードを枠に合わせて「読み取り」を押してください"}
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
                「カメラを開始」を押して、会員証のバーコードやQRコードを枠内にかざしてください。
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
        {running && (
          <button
            type="button"
            className="btn btn-primary btn-xl btn-block scan-read-btn"
            onClick={arm}
            disabled={arming}
          >
            {arming ? "読み取り中…" : "読み取り"}
          </button>
        )}
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
