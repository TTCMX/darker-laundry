// Lightweight charts (HTML/CSS, no library): themable with the app tokens,
// responsive and readable on a phone.

import { useState, type ReactNode } from "react";
import { Icon } from "../../ui/components";
import { change } from "./range";

export interface TrendPoint {
  label: string;
  value: number;
  previous?: number;
}

/** Bars for the period, a tick for the same position in the previous period. */
export function TrendChart({ points, format, height = 200, empty = "Sin datos en este periodo" }: { points: TrendPoint[]; format: (n: number) => string; height?: number; empty?: string }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((p) => Math.max(p.value, p.previous ?? 0)));
  const total = points.reduce((s, p) => s + p.value, 0);
  const every = Math.max(1, Math.ceil(points.length / 8));
  const shown = active ?? points.length - 1;
  const cur = points[shown];
  if (!points.length || (total === 0 && points.every((p) => !p.previous))) return <div className="chart-empty">{empty}</div>;
  return (
    <div className="trend" onMouseLeave={() => setActive(null)}>
      {cur && (
        <div className="trend-readout" aria-live="polite">
          <span className="muted">{cur.label}</span>
          <strong className="num">{format(cur.value)}</strong>
          {cur.previous !== undefined && <span className="muted num">antes {format(cur.previous)}</span>}
        </div>
      )}
      <div className="trend-plot" style={{ height }}>
        {[0.5, 1].map((g) => (
          <div key={g} className="trend-grid" style={{ bottom: `${g * 100}%` }}>
            <span>{format(max * g)}</span>
          </div>
        ))}
        {points.map((p, i) => (
          <button
            key={i}
            type="button"
            className={`trend-col${i === shown ? " on" : ""}`}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onClick={() => setActive(i)}
            aria-label={`${p.label}: ${format(p.value)}`}
          >
            <span className="trend-bar" style={{ height: `${(p.value / max) * 100}%` }} />
            {p.previous !== undefined && p.previous > 0 && <span className="trend-prev" style={{ bottom: `${(p.previous / max) * 100}%` }} />}
          </button>
        ))}
      </div>
      <div className="trend-axis">
        {points.map((p, i) => (
          <span key={i}>{i % every === 0 ? p.label : ""}</span>
        ))}
      </div>
      {points.some((p) => p.previous !== undefined) && (
        <div className="legend">
          <span>
            <i className="sw bar" /> Periodo
          </span>
          <span>
            <i className="sw prev" /> Periodo anterior
          </span>
        </div>
      )}
    </div>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  display?: ReactNode;
  sub?: ReactNode;
}

/** Ranked horizontal bars with the share of the total. */
export function BarList({ rows, format, limit = 8, empty = "Sin datos" }: { rows: BarRow[]; format: (n: number) => string; limit?: number; empty?: string }) {
  const [all, setAll] = useState(false);
  const total = rows.reduce((s, r) => s + r.value, 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length || total === 0) return <div className="chart-empty">{empty}</div>;
  const visible = all ? rows : rows.slice(0, limit);
  return (
    <div className="barlist">
      {visible.map((r) => (
        <div key={r.key} className="barlist-row">
          <div className="row between gap-8">
            <span className="truncate">{r.label}</span>
            <span className="num nowrap">
              {r.display ?? format(r.value)} <span className="muted">· {Math.round((r.value / total) * 100)}%</span>
            </span>
          </div>
          <div className="barlist-track">
            <span style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          {r.sub && <div className="body-s muted">{r.sub}</div>}
        </div>
      ))}
      {rows.length > limit && (
        <button type="button" className="link-btn" onClick={() => setAll(!all)}>
          {all ? "Ver menos" : `Ver ${rows.length - limit} más`}
        </button>
      )}
    </div>
  );
}

const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

/** Weekday × hour grid of order counts. */
export function Heatmap({ cells }: { cells: { dow: number; hour: number; orders: number }[] }) {
  const map = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c.orders]));
  const max = Math.max(1, ...cells.map((c) => c.orders));
  const hours = cells.length ? cells.map((c) => c.hour) : [9, 18];
  const from = Math.min(8, ...hours);
  const to = Math.max(20, ...hours);
  const range = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const peak = cells.reduce((a, c) => (c.orders > (a?.orders ?? 0) ? c : a), null as (typeof cells)[number] | null);
  if (!cells.length) return <div className="chart-empty">Sin órdenes en este periodo</div>;
  return (
    <div className="col gap-8">
      <div className="heatmap" style={{ gridTemplateColumns: `36px repeat(${range.length}, minmax(10px, 1fr))` }}>
        <span />
        {range.map((h) => (
          <span key={h} className="hm-h">
            {h % 3 === 0 ? h : ""}
          </span>
        ))}
        {DAYS.map((d, i) => (
          <HeatRow key={d} day={d}>
            {range.map((h) => {
              const n = map.get(`${i + 1}-${h}`) ?? 0;
              return <span key={h} className="hm-c" title={`${d} ${h}:00 · ${n} órdenes`} style={{ opacity: n ? 0.15 + (0.85 * n) / max : 1, background: n ? undefined : "var(--surface-container)" }} />;
            })}
          </HeatRow>
        ))}
      </div>
      {peak && (
        <div className="body-s muted">
          Hora pico: {DAYS[peak.dow - 1]} de {peak.hour}:00 a {peak.hour + 1}:00 ({peak.orders} órdenes)
        </div>
      )}
    </div>
  );
}

function HeatRow({ day, children }: { day: string; children: ReactNode }) {
  return (
    <>
      <span className="hm-d">{day}</span>
      {children}
    </>
  );
}

/** "▲ 12%" compared with the previous period. `inverse` when lower is better. */
export function Delta({ current, previous, inverse }: { current: number; previous: number; inverse?: boolean }) {
  const c = change(current, previous);
  if (c === null) return <span className="delta new">Nuevo</span>;
  if (Math.abs(c) < 0.005) return <span className="delta flat">= igual</span>;
  const good = inverse ? c < 0 : c > 0;
  return (
    <span className={`delta ${good ? "up" : "down"}`}>
      <Icon name={c > 0 ? "arrow_upward" : "arrow_downward"} />
      {c >= 9 ? `${Math.round(c + 1)}×` : `${Math.round(Math.abs(c) * 100)}%`}
    </span>
  );
}

/** KPI tile with comparison. */
export function Kpi({ label, value, current, previous, inverse, hint, icon }: { label: string; value: ReactNode; current?: number; previous?: number; inverse?: boolean; hint?: ReactNode; icon?: string }) {
  return (
    <div className="stat kpi">
      <span className="label">
        {icon && <Icon name={icon} />}
        {label}
      </span>
      <span className="value">{value}</span>
      <span className="hint row gap-8 wrap">
        {current !== undefined && previous !== undefined && <Delta current={current} previous={previous} inverse={inverse} />}
        {hint}
      </span>
    </div>
  );
}
