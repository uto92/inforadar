export type Feedback = {
  kind: "ok" | "duplicate" | "invalid";
  title: string;
  sub?: string;
  /** 指定時はボタン操作まで閉じない（手入力の suffix 一致警告など） */
  actions?: { label: string; onClick: () => void }[];
};

/** 2m先からでも成否が分かる全画面フィードバック */
export default function FeedbackOverlay({
  feedback,
  onClose,
}: {
  feedback: Feedback | null;
  onClose: () => void;
}) {
  if (!feedback) return null;
  const hasActions = feedback.actions && feedback.actions.length > 0;
  return (
    <div
      className={`feedback-overlay feedback-${feedback.kind}`}
      role="alert"
      onClick={hasActions ? undefined : onClose}
    >
      <Icon kind={feedback.kind} />
      <p className="feedback-title">{feedback.title}</p>
      {feedback.sub && <p className="feedback-sub">{feedback.sub}</p>}
      {hasActions && (
        <div className="feedback-actions">
          {feedback.actions!.map((action) => (
            <button key={action.label} type="button" className="btn" onClick={action.onClick}>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Icon({ kind }: { kind: Feedback["kind"] }) {
  const stroke = "currentColor";
  const common = {
    className: "feedback-icon",
    viewBox: "0 0 100 100",
    fill: "none",
    stroke,
    strokeWidth: 10,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "ok") {
    return (
      <svg {...common}>
        <polyline points="18,52 42,76 84,26" />
      </svg>
    );
  }
  if (kind === "duplicate") {
    return (
      <svg {...common}>
        <line x1="50" y1="16" x2="50" y2="62" />
        <circle cx="50" cy="84" r="2" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <line x1="24" y1="24" x2="76" y2="76" />
      <line x1="76" y1="24" x2="24" y2="76" />
    </svg>
  );
}
