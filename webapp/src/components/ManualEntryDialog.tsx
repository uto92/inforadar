import { useEffect, useRef, useState } from "react";
import { SUFFIX_LEN } from "../lib/normalize";

/** カメラ不調時の手入力フォールバック（会員ID末尾6桁） */
export default function ManualEntryDialog({
  open,
  onSubmit,
  onClose,
}: {
  open: boolean;
  onSubmit: (digits: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue("");
      window.setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const valid = value.length === SUFFIX_LEN;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>手入力チェックイン</h2>
        <p className="muted">
          カメラで読み取れない場合、会員証番号の<strong>末尾{SUFFIX_LEN}桁</strong>
          を入力してください。
        </p>
        <div className="field">
          <input
            ref={inputRef}
            className="manual-input"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            placeholder={"0".repeat(SUFFIX_LEN)}
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, SUFFIX_LEN))}
            aria-label={`会員証番号の末尾${SUFFIX_LEN}桁`}
          />
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!valid}
            onClick={() => onSubmit(value)}
          >
            チェックイン
          </button>
          <button type="button" className="btn btn-ghost btn-block" onClick={onClose}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
