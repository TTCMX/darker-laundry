import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Page } from "../../app/Shell";
import { todayISO } from "../../lib/format";
import { rpc } from "../../lib/queries";
import { useTenant } from "../../lib/session";
import { Banner, Button, Chip, IconButton, Tabs } from "../../ui/components";
import { Overview } from "./Overview";
import { PaymentsReport, ReceiptsReport } from "./Receipts";
import { CustomersReport, EmployeesReport, OperationsReport, QualityReport, ServicesReport } from "./Reports";
import { PRESETS, matchPreset, presetRange, previousRange, rangeLabel, validRange, type DateRange } from "./range";

export type AnalyticsTab = "overview" | "receipts" | "payments" | "services" | "customers" | "employees" | "operations" | "quality";

const TABS: { value: AnalyticsTab; label: string; icon: string }[] = [
  { value: "overview", label: "Ventas", icon: "monitoring" },
  { value: "receipts", label: "Recibos", icon: "receipt_long" },
  { value: "payments", label: "Pagos", icon: "payments" },
  { value: "services", label: "Servicios", icon: "sell" },
  { value: "customers", label: "Clientes", icon: "group" },
  { value: "employees", label: "Empleados", icon: "badge" },
  { value: "operations", label: "Operación", icon: "local_shipping" },
  { value: "quality", label: "Incidencias", icon: "report" },
];

/** Selected period, kept in the URL so a report can be shared or bookmarked. */
export function useRange(): [DateRange, (r: DateRange) => void] {
  const [params, setParams] = useSearchParams();
  const today = todayISO();
  const fallback = presetRange("30d", today);
  const r = { from: params.get("from") ?? fallback.from, to: params.get("to") ?? fallback.to };
  const range = validRange(r) ? fallback : r;
  const set = (x: DateRange) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("from", x.from);
        n.set("to", x.to);
        return n;
      },
      { replace: true },
    );
  return [range, set];
}

/** Runs one of the analytics_* database functions for the range. */
export function useReport<T>(fn: string, range: DateRange) {
  const { tenantId } = useTenant();
  return useQuery({
    queryKey: ["analytics", fn, tenantId, range.from, range.to],
    queryFn: () => rpc<T>(fn, { p_tenant: tenantId, p_from: range.from, p_to: range.to }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function AnalyticsPage() {
  const { tab = "overview" } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [range, setRange] = useRange();
  const current = (TABS.some((t) => t.value === tab) ? tab : "overview") as AnalyticsTab;
  const go = (t: AnalyticsTab) => navigate({ pathname: `/analytics/${t}`, search: params.toString() });

  return (
    <Page title="Ventas">
      <div className="col gap-16">
        <Tabs value={current} onChange={go} tabs={TABS} />
        <RangePicker range={range} onChange={setRange} />
        {current === "overview" && <Overview range={range} />}
        {current === "receipts" && <ReceiptsReport range={range} />}
        {current === "payments" && <PaymentsReport range={range} />}
        {current === "services" && <ServicesReport range={range} />}
        {current === "customers" && <CustomersReport range={range} />}
        {current === "employees" && <EmployeesReport range={range} />}
        {current === "operations" && <OperationsReport range={range} />}
        {current === "quality" && <QualityReport range={range} />}
      </div>
    </Page>
  );
}

function RangePicker({ range, onChange }: { range: DateRange; onChange: (r: DateRange) => void }) {
  const today = todayISO();
  const preset = matchPreset(range, today);
  const [custom, setCustom] = useState(preset === "custom");
  const [draft, setDraft] = useState(range);
  useEffect(() => setDraft(range), [range]);
  const error = validRange(draft);
  const prev = previousRange(range);
  return (
    <div className="col gap-8">
      <div className="range-bar">
        <div className="chips" role="group" aria-label="Periodo">
          {PRESETS.map((p) => (
            <Chip
              key={p.key}
              on={!custom && preset === p.key}
              onClick={() => {
                setCustom(false);
                onChange(presetRange(p.key, today));
              }}
            >
              {p.label}
            </Chip>
          ))}
          <Chip on={custom || preset === "custom"} icon="date_range" onClick={() => setCustom(true)}>
            Personalizado
          </Chip>
        </div>
      </div>
      {custom && (
        <div className="filters">
          <input className="input sm" type="date" aria-label="Desde" value={draft.from} max={today} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
          <span className="muted">a</span>
          <input className="input sm" type="date" aria-label="Hasta" value={draft.to} max={today} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          <Button variant="tonal" disabled={!!error} onClick={() => onChange(draft)}>
            Aplicar
          </Button>
          <IconButton icon="close" label="Cerrar" onClick={() => setCustom(false)} />
          {error && draft.from && draft.to && <Banner tone="warning">{error}</Banner>}
        </div>
      )}
      <div className="body-s muted">
        <strong style={{ color: "var(--on-surface)" }}>{rangeLabel(range)}</strong> · comparado con {rangeLabel(prev)}
      </div>
    </div>
  );
}
