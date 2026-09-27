import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { errorMessage } from "../../../lib/errors";
import { rpc } from "../../../lib/queries";
import { useTenant } from "../../../lib/session";
import { Badge, Banner, Button, Chip, Dialog, Icon, Segmented } from "../../../ui/components";
import { downloadCsv, toCsv } from "../../analytics/range";
import { FIELDS, TEMPLATE_CSV, buildRows, guessMapping, type ImportRow, type Mapping } from "./mapping";
import { readTable, type Table } from "./parse";

const BATCH = 500;

type Status = "created" | "updated" | "duplicate" | "error";

interface RowResult {
  index: number;
  status: Status;
  message: string | null;
  customer_id: string | null;
  phone: string | null;
  warnings: string[];
}

interface ImportResult {
  dry_run: boolean;
  created: number;
  updated: number;
  duplicates: number;
  errors: number;
  rows: RowResult[];
}

type Step = "file" | "map" | "review" | "done";

const STATUS: Record<Status, { label: string; tone: "success" | "neutral" | "warning" | "error" }> = {
  created: { label: "Nuevo", tone: "success" },
  updated: { label: "Se completa", tone: "neutral" },
  duplicate: { label: "Ya existe", tone: "warning" },
  error: { label: "Error", tone: "error" },
};

/** Runs the import in batches and merges the results (row indexes are global). */
async function runImport(tenantId: string, rows: ImportRow[], onDuplicate: "skip" | "update", dryRun: boolean, progress: (done: number) => void): Promise<ImportResult> {
  const total: ImportResult = { dry_run: dryRun, created: 0, updated: 0, duplicates: 0, errors: 0, rows: [] };
  for (let i = 0; i < rows.length; i += BATCH) {
    const r = await rpc<ImportResult>("import_customers", {
      p_tenant: tenantId,
      p_rows: rows.slice(i, i + BATCH),
      p_options: { dry_run: dryRun, on_duplicate: onDuplicate },
    });
    total.created += r.created;
    total.updated += r.updated;
    total.duplicates += r.duplicates;
    total.errors += r.errors;
    total.rows.push(...r.rows.map((x) => ({ ...x, index: x.index + i })));
    progress(Math.min(rows.length, i + BATCH));
  }
  return total;
}

export function ImportCustomersDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { tenantId, can } = useTenant();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("file");
  const [fileName, setFileName] = useState("");
  const [table, setTable] = useState<Table>([]);
  const [mapping, setMapping] = useState<Mapping>([]);
  const [onDuplicate, setOnDuplicate] = useState<"skip" | "update">("skip");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<{ label: string; done: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Status | "all">("all");

  const headers = table[0] ?? [];
  const data = useMemo(() => table.slice(1), [table]);
  const rows = useMemo(() => buildRows(data, mapping), [data, mapping]);
  const hasName = mapping.includes("name");

  const reset = () => {
    setStep("file");
    setFileName("");
    setTable([]);
    setMapping([]);
    setOnDuplicate("skip");
    setResult(null);
    setError(null);
    setFilter("all");
  };
  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const t = await readTable(file);
      if (t.length < 2) throw new Error("El archivo no tiene clientes (se necesita una fila de títulos y al menos una fila de datos).");
      setTable(t);
      setMapping(guessMapping(t[0]!));
      setFileName(file.name);
      setStep("map");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      if (input.current) input.current.value = "";
    }
  };

  const run = async (dryRun: boolean) => {
    setError(null);
    setBusy({ label: dryRun ? "Revisando" : "Importando", done: 0 });
    try {
      const r = await runImport(tenantId, rows.map((x) => x.row), onDuplicate, dryRun, (done) => setBusy({ label: dryRun ? "Revisando" : "Importando", done }));
      setResult(r);
      setFilter(r.errors ? "error" : "all");
      setStep(dryRun ? "review" : "done");
      if (!dryRun) {
        void qc.invalidateQueries({ queryKey: ["customers"] });
        void qc.invalidateQueries({ queryKey: ["analytics"] });
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const problems = () => {
    if (!result) return;
    const header = [...headers, "Resultado", "Detalle"];
    const lines = result.rows
      .filter((r) => r.status === "error" || r.status === "duplicate" || r.warnings.length)
      .map((r) => [...(data[rows[r.index]!.line - 2] ?? []), STATUS[r.status].label, [r.message, ...r.warnings].filter(Boolean).join(". ")]);
    downloadCsv(`clientes-a-revisar.csv`, toCsv(header, lines));
  };

  const toImport = result ? result.created + result.updated : 0;
  const shown = result?.rows.filter((r) => filter === "all" || r.status === filter) ?? [];

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={step === "done" ? "Importación terminada" : "Importar clientes"}
      actions={
        step === "file" ? (
          <Button variant="text" onClick={close}>
            Cancelar
          </Button>
        ) : step === "map" ? (
          <>
            <Button variant="text" onClick={reset} disabled={!!busy}>
              Elegir otro archivo
            </Button>
            <Button onClick={() => run(true)} disabled={!hasName || !rows.length} loading={!!busy}>
              Revisar {rows.length.toLocaleString("es-MX")} filas
            </Button>
          </>
        ) : step === "review" ? (
          <>
            <Button variant="text" onClick={() => setStep("map")} disabled={!!busy}>
              Atrás
            </Button>
            <Button icon="upload" onClick={() => run(false)} disabled={!toImport} loading={!!busy}>
              Importar {toImport.toLocaleString("es-MX")} {toImport === 1 ? "cliente" : "clientes"}
            </Button>
          </>
        ) : (
          <Button onClick={close}>Listo</Button>
        )
      }
    >
      <div className="col gap-16">
        {error && <Banner tone="error">{error}</Banner>}
        {busy && (
          <div className="col gap-8">
            <div className="body-m">
              {busy.label} {busy.done.toLocaleString("es-MX")} de {rows.length.toLocaleString("es-MX")}…
            </div>
            <div className="progress">
              <span style={{ width: `${(busy.done / Math.max(1, rows.length)) * 100}%` }} />
            </div>
          </div>
        )}

        {step === "file" && (
          <>
            <p className="body-m" style={{ margin: 0 }}>
              Exporta tus clientes desde el otro sistema como <strong>Excel (.xlsx)</strong> o <strong>CSV</strong>. La primera fila debe tener los títulos de las
              columnas (Nombre, Teléfono, Correo, Dirección…). Antes de guardar nada verás una revisión fila por fila.
            </p>
            <label className="dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), pick(e.dataTransfer.files[0]))}>
              <input ref={input} type="file" accept=".xlsx,.csv,.txt,.tsv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => pick(e.target.files?.[0])} hidden />
              <Icon name="upload_file" size="lg" />
              <span className="title-s">Elegir archivo</span>
              <span className="body-s muted">o arrástralo aquí · .xlsx o .csv</span>
            </label>
            <div className="row wrap gap-8 body-s muted">
              <span>¿No sabes qué formato usar?</span>
              <button type="button" className="link-btn" onClick={() => downloadCsv("plantilla-clientes.csv", TEMPLATE_CSV)}>
                Descargar plantilla
              </button>
            </div>
          </>
        )}

        {step === "map" && !busy && (
          <>
            <div className="row wrap gap-8">
              <Icon name="description" />
              <strong className="truncate">{fileName}</strong>
              <span className="muted">· {data.length.toLocaleString("es-MX")} filas</span>
            </div>
            {!hasName && <Banner tone="warning">Indica qué columna tiene el nombre del cliente.</Banner>}
            <div className="map-list">
              <div className="map-row map-head">
                <span>Columna del archivo</span>
                <span>Guardar como</span>
              </div>
              {headers.map((h, col) => {
                const sample = data.map((r) => r[col]).filter(Boolean).slice(0, 2).join(" · ");
                return (
                  <div key={col} className="map-row">
                    <div className="col" style={{ gap: 2, minWidth: 0 }}>
                      <strong className="truncate">{h || `Columna ${col + 1}`}</strong>
                      <span className="body-s muted truncate">{sample || "—"}</span>
                    </div>
                    <select
                      className="input sm"
                      aria-label={`Campo para ${h || `columna ${col + 1}`}`}
                      value={mapping[col] ?? ""}
                      onChange={(e) => setMapping((m) => m.map((x, i) => (i === col ? (e.target.value as Mapping[number]) : x)))}
                    >
                      <option value="">No importar</option>
                      {FIELDS.filter((f) => f.key !== "points" || can("loyalty.manage")).map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <div className="col gap-8">
              <span className="title-s">Si el cliente ya existe (mismo teléfono o correo)</span>
              <Segmented
                value={onDuplicate}
                onChange={setOnDuplicate}
                options={[
                  { value: "skip", label: "Dejarlo como está" },
                  { value: "update", label: "Completar datos vacíos" },
                ]}
              />
              <span className="body-s muted">
                {onDuplicate === "skip"
                  ? "No se toca a los clientes que ya tienes."
                  : "Se agregan teléfono o correo si faltaban, etiquetas, notas y direcciones nuevas. Nunca se borra ni se reemplaza lo que ya capturaste."}
              </span>
            </div>
          </>
        )}

        {(step === "review" || step === "done") && result && !busy && (
          <>
            {step === "done" ? (
              <Banner tone="success" icon="check_circle">
                Se importaron {result.created.toLocaleString("es-MX")} clientes nuevos
                {result.updated ? ` y se completaron ${result.updated.toLocaleString("es-MX")}` : ""}.
                {result.duplicates ? ` ${result.duplicates.toLocaleString("es-MX")} ya existían y no se tocaron.` : ""}
                {result.errors ? ` ${result.errors.toLocaleString("es-MX")} filas tenían errores y no se importaron.` : ""}
              </Banner>
            ) : (
              <p className="body-m" style={{ margin: 0 }}>
                Así quedará tu importación. Todavía no se ha guardado nada.
              </p>
            )}
            <div className="chips">
              <Chip on={filter === "all"} onClick={() => setFilter("all")}>
                Todas · {result.rows.length.toLocaleString("es-MX")}
              </Chip>
              <Chip on={filter === "created"} onClick={() => setFilter("created")}>
                Nuevos · {result.created.toLocaleString("es-MX")}
              </Chip>
              {onDuplicate === "update" ? (
                <Chip on={filter === "updated"} onClick={() => setFilter("updated")}>
                  Se completan · {result.updated.toLocaleString("es-MX")}
                </Chip>
              ) : (
                <Chip on={filter === "duplicate"} onClick={() => setFilter("duplicate")}>
                  Ya existen · {result.duplicates.toLocaleString("es-MX")}
                </Chip>
              )}
              <Chip on={filter === "error"} onClick={() => setFilter("error")}>
                Con error · {result.errors.toLocaleString("es-MX")}
              </Chip>
            </div>
            <div className="table-wrap import-preview">
              <table className="table">
                <thead>
                  <tr>
                    <th>Fila</th>
                    <th>Cliente</th>
                    <th>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 300).map((r) => {
                    const src = rows[r.index]!;
                    return (
                      <tr key={r.index}>
                        <td className="num muted">{src.line}</td>
                        <td>
                          <div>{src.row.name || <span className="muted">(sin nombre)</span>}</div>
                          <div className="body-s muted">{[src.row.phone, src.row.email, src.row.line1].filter(Boolean).join(" · ")}</div>
                        </td>
                        <td>
                          <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                          {(r.message || r.warnings.length > 0) && (
                            <div className="body-s muted" style={{ marginTop: 4 }}>
                              {[r.message, ...r.warnings].filter(Boolean).join(". ")}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {shown.length > 300 && <div className="body-s muted" style={{ padding: 12 }}>Mostrando 300 de {shown.length.toLocaleString("es-MX")}.</div>}
            </div>
            {(result.errors > 0 || result.duplicates > 0 || result.rows.some((r) => r.warnings.length)) && (
              <div className="row wrap gap-8 body-s muted">
                <span>Corrige las filas en tu archivo y vuelve a importarlo: los clientes ya importados se detectan como repetidos.</span>
                <button type="button" className="link-btn" onClick={problems}>
                  Descargar filas a revisar
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
