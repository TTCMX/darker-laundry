import { useState } from "react";
import { errorMessage } from "../../lib/errors";
import { Banner, Button, useToast } from "../../ui/components";
import { downloadCsv, toCsv, type CsvValue } from "./range";

/** Downloads a CSV (opens in Excel / Google Sheets). `rows` may fetch data. */
export function CsvButton({ filename, header, rows, label = "CSV" }: { filename: string; header: string[]; rows: () => CsvValue[][] | Promise<CsvValue[][]>; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const data = await rows();
      downloadCsv(`${filename}.csv`, toCsv(header, data));
    } catch (err) {
      toast.show(errorMessage(err), { error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="text" icon="download" onClick={run} loading={busy} aria-label={`Descargar ${label}`}>
      {label}
    </Button>
  );
}

export function ReportError({ error }: { error: unknown }) {
  return <Banner tone="error">No se pudo cargar el reporte: {errorMessage(error)}</Banner>;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span className="body-s muted">
        {total === 0 ? "Sin resultados" : `${page * pageSize + 1}–${Math.min(total, (page + 1) * pageSize)} de ${total.toLocaleString("es-MX")}`}
      </span>
      <div className="row gap-8">
        <Button variant="text" icon="chevron_left" disabled={page === 0} onClick={() => onPage(page - 1)}>
          Anterior
        </Button>
        <Button variant="text" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
          Siguiente
        </Button>
      </div>
    </div>
  );
}

export const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
export const count = (n: number | null | undefined) => Math.round(Number(n ?? 0)).toLocaleString("es-MX");
