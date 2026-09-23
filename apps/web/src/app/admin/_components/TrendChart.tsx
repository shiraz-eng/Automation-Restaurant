/** Small inline-SVG line chart — no chart library exists in this repo, and
 *  a handful of daily-bucketed points don't warrant adding one. */
export function TrendChart({
  points,
  height = 120,
  color = 'rgb(202 138 4)',
}: {
  points: { label: string; value: number }[];
  height?: number;
  color?: string;
}) {
  if (points.length === 0) {
    return <div className="text-ink-muted text-xs py-8 text-center">No data in this range.</div>;
  }
  const width = 600;
  const max = Math.max(1, ...points.map((p) => p.value));
  const stepX = points.length > 1 ? width / (points.length - 1) : 0;
  const coords = points.map((p, i) => {
    const x = points.length > 1 ? i * stepX : width / 2;
    const y = height - (p.value / max) * (height - 16) - 8;
    return { x, y, ...p };
  });
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const areaPath = `${path} L${coords[coords.length - 1].x.toFixed(1)},${height} L${coords[0].x.toFixed(1)},${height} Z`;

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ minWidth: 320 }} preserveAspectRatio="none">
        <path d={areaPath} fill={color} fillOpacity={0.12} stroke="none" />
        <path d={path} fill="none" stroke={color} strokeWidth={2} />
        {coords.map((c) => (
          <circle key={c.label} cx={c.x} cy={c.y} r={2.5} fill={color} />
        ))}
      </svg>
      <div className="flex justify-between text-[10px] text-ink-muted mt-1">
        <span>{points[0].label}</span>
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  );
}
