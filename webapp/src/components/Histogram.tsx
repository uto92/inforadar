/** 時間帯別来場ヒストグラム（依存ライブラリなしのSVG） */
export default function Histogram({ timestamps }: { timestamps: string[] }) {
  if (timestamps.length === 0) {
    return <p className="muted">まだ来場記録がありません。</p>;
  }

  const byHour = new Map<number, number>();
  for (const iso of timestamps) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) continue;
    const hour = date.getHours();
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
  }
  const hoursPresent = [...byHour.keys()];
  const minHour = Math.min(...hoursPresent);
  const maxHour = Math.max(...hoursPresent);
  const hours: number[] = [];
  for (let h = minHour; h <= maxHour; h += 1) hours.push(h);

  const barWidth = 44;
  const gap = 14;
  const chartHeight = 190;
  const topPad = 26;
  const bottomPad = 30;
  const width = hours.length * (barWidth + gap) + gap;
  const height = chartHeight + topPad + bottomPad;
  const maxCount = Math.max(...byHour.values());

  return (
    <div className="hist-scroll">
      <svg
        width={Math.max(width, 280)}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="時間帯別の来場数グラフ"
      >
        {hours.map((hour, i) => {
          const count = byHour.get(hour) ?? 0;
          const barHeight = maxCount > 0 ? Math.round((count / maxCount) * chartHeight) : 0;
          const x = gap + i * (barWidth + gap);
          const y = topPad + (chartHeight - barHeight);
          return (
            <g key={hour}>
              {count > 0 && (
                <rect className="hist-bar" x={x} y={y} width={barWidth} height={Math.max(barHeight, 2)} rx={3} />
              )}
              <text className="hist-count" x={x + barWidth / 2} y={y - 6} textAnchor="middle">
                {count > 0 ? count : ""}
              </text>
              <text
                className="hist-label"
                x={x + barWidth / 2}
                y={topPad + chartHeight + 20}
                textAnchor="middle"
              >
                {hour}時
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
