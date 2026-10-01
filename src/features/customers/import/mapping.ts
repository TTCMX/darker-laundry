// Which column of the other system's file goes to which customer field.
// Headers are recognised in Spanish and English; the user can change any
// choice before importing.

import type { Table } from "./parse";

export type FieldKey =
  | "name"
  | "phone"
  | "email"
  | "line1"
  | "line2"
  | "neighborhood"
  | "city"
  | "state"
  | "postal_code"
  | "instructions"
  | "notes"
  | "tags"
  | "points"
  | "customer_since";

export const FIELDS: { key: FieldKey; label: string; hint?: string; synonyms: string[] }[] = [
  { key: "name", label: "Nombre", hint: "Si nombre y apellido vienen separados, asigna las dos columnas aquí.", synonyms: ["nombre", "name", "cliente", "nombre completo", "full name", "razon social", "apellido", "apellidos", "last name", "first name", "nombres", "contacto"] },
  { key: "phone", label: "Teléfono", synonyms: ["telefono", "tel", "celular", "cel", "movil", "whatsapp", "phone", "mobile", "telefono movil", "numero", "tel celular"] },
  { key: "email", label: "Correo", synonyms: ["correo", "email", "e mail", "mail", "correo electronico"] },
  { key: "line1", label: "Calle y número", synonyms: ["direccion", "domicilio", "calle", "address", "calle y numero", "direccion 1", "address 1", "numero exterior", "no ext"] },
  { key: "line2", label: "Interior / depto.", synonyms: ["interior", "depto", "departamento", "numero interior", "no int", "address 2", "direccion 2"] },
  { key: "neighborhood", label: "Colonia", synonyms: ["colonia", "col", "barrio", "fraccionamiento", "neighborhood"] },
  { key: "city", label: "Ciudad / municipio", synonyms: ["ciudad", "municipio", "alcaldia", "delegacion", "city", "localidad"] },
  { key: "state", label: "Estado", synonyms: ["estado", "state", "entidad", "provincia"] },
  { key: "postal_code", label: "Código postal", synonyms: ["cp", "c p", "codigo postal", "postal code", "zip", "zip code"] },
  { key: "instructions", label: "Referencias", synonyms: ["referencias", "referencia", "indicaciones", "instrucciones", "entre calles"] },
  { key: "notes", label: "Notas", synonyms: ["notas", "nota", "observaciones", "comentarios", "notes", "comments", "preferencias"] },
  { key: "tags", label: "Etiquetas", hint: "Separadas por coma.", synonyms: ["etiquetas", "etiqueta", "tags", "tipo", "categoria", "segmento", "grupo"] },
  { key: "points", label: "Puntos de lealtad", hint: "Saldo inicial; solo para clientes sin puntos.", synonyms: ["puntos", "points", "saldo de puntos", "puntos acumulados", "monedero"] },
  { key: "customer_since", label: "Cliente desde", synonyms: ["fecha de alta", "alta", "cliente desde", "fecha registro", "fecha de registro", "registro", "created", "created at", "since", "fecha"] },
];

export type Mapping = (FieldKey | "")[];

export const normalizeHeader = (h: string) =>
  h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function guessField(header: string): FieldKey | "" {
  const h = normalizeHeader(header);
  if (!h) return "";
  for (const f of FIELDS) if (f.synonyms.includes(h)) return f.key;
  // "Teléfono celular", "Nombre del cliente", "Correo de contacto"...
  for (const f of FIELDS) if (f.synonyms.some((s) => s.length > 3 && (h.startsWith(s + " ") || h.endsWith(" " + s)))) return f.key;
  return "";
}

/** Guesses every column; a field is only guessed once, except the name (first + last name). */
export function guessMapping(headers: string[]): Mapping {
  const used = new Set<FieldKey>();
  return headers.map((h) => {
    const f = guessField(h);
    if (!f || (used.has(f) && f !== "name")) return "";
    used.add(f);
    return f;
  });
}

export type ImportRow = Partial<Record<FieldKey, string>>;

/** Excel date serial (days since 1899-12-30) or dd/mm/yyyy → yyyy-mm-dd. */
export function toIsoDate(v: string): string {
  const s = v.trim();
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) return new Date(Math.round((n - 25569) * 86_400_000)).toISOString().slice(0, 10);
  }
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(s);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  }
  m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  return s;
}

/** Applies the mapping to the data rows (header excluded). Empty rows are dropped. */
export function buildRows(data: Table, mapping: Mapping): { row: ImportRow; line: number }[] {
  const out: { row: ImportRow; line: number }[] = [];
  data.forEach((cells, i) => {
    const row: ImportRow = {};
    mapping.forEach((field, col) => {
      const value = (cells[col] ?? "").trim();
      if (!field || !value) return;
      const sep = field === "tags" ? ", " : field === "notes" || field === "instructions" ? ". " : " ";
      row[field] = row[field] ? `${row[field]}${sep}${value}` : value;
    });
    if (row.customer_since) row.customer_since = toIsoDate(row.customer_since);
    // "1,200 pts" → "1200"; text with no digits is sent as-is so the import warns about it.
    if (row.points) row.points = row.points.replace(/[^\d.-]/g, "") || row.points;
    if (Object.keys(row).length) out.push({ row, line: i + 2 });
  });
  return out;
}

export const TEMPLATE_CSV =
  "Nombre,Teléfono,Correo,Calle y número,Colonia,Ciudad,Código postal,Referencias,Notas,Etiquetas,Puntos,Cliente desde\r\n" +
  'Ana López,55 1234 5678,ana@ejemplo.com,Av. Juárez 120,Centro,CDMX,06000,Portón verde,Sin suavizante,"vip, frecuente",120,15/03/2024\r\n';
