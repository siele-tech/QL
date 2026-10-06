import { useMemo, useState } from 'react';
import { compactKes, kes, shortDate } from '../format';

/**
 * Lightweight SVG charts. Palette validated (teal #00918b / gold #b8860b pass CVD + contrast checks).
 * Legends are always shown for ≥2 series; every mark has a hover tooltip; text uses ink tokens.
 */
export const SERIES = ['#00918b', '#b8860b'];

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Grouped bars over dates (e.g. disbursed vs collected). */
export function DailyBars({ data, series, height = 220 }: { data: { date: string; [k: string]: any }[]; series: { key: string; label: string }[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = height, padL = 56, padB = 26, padT = 10;
  const max = niceMax(Math.max(1, ...data.flatMap((d) => series.map((s) => d[s.key] ?? 0))));
  const n = data.length || 1;
  const bw = (W - padL) / n;
  const barW = Math.max(2, Math.min(14, (bw - 4) / series.length - 2));
  const y = (v: number) => padT + (H - padB - padT) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const labelEvery = Math.ceil(n / 8);
  return (
    <div className="chart">
      <Legend items={series.map((s, i) => ({ label: s.label, color: SERIES[i] }))} />
      <div className="chart-svg-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.label).join(' and ') + ' by day'} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="grid" />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="axis">{t === 0 ? '0' : compactKes(t).replace('KES ', '')}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const x0 = padL + i * bw + (bw - (barW + 2) * series.length) / 2;
            return (
              <g key={d.date} onMouseEnter={() => setHover(i)}>
                <rect x={padL + i * bw} y={padT} width={bw} height={H - padB - padT} fill="transparent" />
                {hover === i && <rect x={padL + i * bw} y={padT} width={bw} height={H - padB - padT} className="hover-band" />}
                {series.map((s, j) => {
                  const v = d[s.key] ?? 0;
                  const h = Math.max(0, H - padB - y(v));
                  return v > 0 ? <path key={s.key} d={roundedTop(x0 + j * (barW + 2), y(v), barW, h, Math.min(3, barW / 2))} fill={SERIES[j]} /> : null;
                })}
                {i % labelEvery === 0 && <text x={padL + i * bw + bw / 2} y={H - 8} textAnchor="middle" className="axis">{shortDate(d.date)}</text>}
              </g>
            );
          })}
          <line x1={padL} x2={W} y1={H - padB} y2={H - padB} className="baseline" />
        </svg>
        {hover !== null && data[hover] && (
          <div className="tooltip" style={{ left: `${((padL + hover * bw + bw / 2) / W) * 100}%` }}>
            <strong>{shortDate(data[hover].date)}</strong>
            {series.map((s, j) => <div key={s.key}><i style={{ background: SERIES[j] }} />{s.label}<b>{kes(data[hover][s.key] ?? 0)}</b></div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  if (h <= r) return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return <div className="legend">{items.map((i) => <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>)}</div>;
}

/** Horizontal bars with direct labels (status breakdown, funnel, aging). */
export function HBars({ rows, format = (v) => String(v), tone }: { rows: { label: string; value: number; sub?: string; tone?: 'teal' | 'gold' | 'terra' | 'muted' }[]; format?: (v: number) => string; tone?: 'teal' | 'gold' | 'terra' | 'muted' }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div className="hbar" key={r.label} title={`${r.label}: ${format(r.value)}${r.sub ? ' · ' + r.sub : ''}`}>
          <span className="hbar-label">{r.label}</span>
          <span className="hbar-track"><span className={`hbar-fill tone-${r.tone ?? tone ?? 'teal'}`} style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="hbar-value">{format(r.value)}{r.sub && <small>{r.sub}</small>}</span>
        </div>
      ))}
    </div>
  );
}

/** Score history line (behaviour). */
export function ScoreLine({ points, height = 140 }: { points: { score: number; created_at: string; reason: string }[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600, H = height, pad = 24;
  const pts = useMemo(() => points.map((p, i) => ({ ...p, x: pad + (points.length === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (points.length - 1)), y: pad / 2 + (H - pad * 1.5) * (1 - p.score / 100) })), [points, H]);
  if (!points.length) return null;
  return (
    <div className="chart">
      <div className="chart-svg-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Behaviour score over time" onMouseLeave={() => setHover(null)}>
          {[0, 50, 100].map((t) => <g key={t}><line x1={pad} x2={W - pad} y1={pad / 2 + (H - pad * 1.5) * (1 - t / 100)} y2={pad / 2 + (H - pad * 1.5) * (1 - t / 100)} className="grid" /><text x={pad - 6} y={pad / 2 + (H - pad * 1.5) * (1 - t / 100) + 4} textAnchor="end" className="axis">{t}</text></g>)}
          <polyline points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={SERIES[0]} strokeWidth={2} strokeLinejoin="round" />
          {pts.map((p, i) => (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <circle cx={p.x} cy={p.y} r={14} fill="transparent" />
              <circle cx={p.x} cy={p.y} r={hover === i ? 6 : 4} fill={SERIES[0]} stroke="var(--surface)" strokeWidth={2} />
            </g>
          ))}
        </svg>
        {hover !== null && <div className="tooltip" style={{ left: `${(pts[hover].x / W) * 100}%` }}><strong>{pts[hover].score} / 100</strong><div>{pts[hover].reason}</div><div className="muted">{shortDate(pts[hover].created_at)}</div></div>}
      </div>
    </div>
  );
}

/** Ring gauge for a single 0–100 score (a stat, not a comparison). */
export function ScoreRing({ score, size = 132, label = 'out of 100' }: { score: number; size?: number; label?: string }) {
  const r = size / 2 - 10, c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" strokeWidth={10} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--yellow)" strokeWidth={10} fill="none" strokeLinecap="round"
          strokeDasharray={`${(c * score) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="ring-center"><b>{score}</b><span>{label}</span></div>
    </div>
  );
}
