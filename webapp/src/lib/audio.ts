/// 読取音はWebAudioで生成（音源ファイル不要）。
/// iOS Safariの制約: AudioContextはユーザー操作起点で作成/resumeが必要なため、
/// 「カメラを開始」等のタップハンドラから initAudio() を呼ぶこと。

let ctx: AudioContext | null = null;

export function initAudio(): void {
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  ctx ??= new AC();
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
}

function tone(
  freq: number,
  startAt: number,
  duration: number,
  type: OscillatorType = "sine",
  volume = 0.35
): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = ctx.currentTime + startAt;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

export function playSuccess(): void {
  tone(1318.5, 0, 0.09);
  tone(1760, 0.09, 0.14);
}

export function playWarn(): void {
  tone(660, 0, 0.12, "square", 0.25);
  tone(660, 0.18, 0.12, "square", 0.25);
}

export function playError(): void {
  tone(220, 0, 0.3, "square", 0.25);
}

/** iOS Safariは非対応（no-op）。音＋全画面表示で代替する前提 */
export function vibrate(pattern: number | number[]): void {
  if ("vibrate" in navigator) {
    navigator.vibrate(pattern);
  }
}
