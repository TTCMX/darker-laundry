// Reads the customer list exported from another system: CSV (any separator,
// UTF-8 or the Windows encoding Excel uses in Spanish) or Excel .xlsx.
// No dependencies: .xlsx is a zip of XML files, unzipped with the browser's
// DecompressionStream.

export type Table = string[][];

export async function readTable(file: File): Promise<Table> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return readXlsx(buf);
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
    throw new Error("Es un Excel antiguo (.xls). Ábrelo en Excel y guárdalo como .xlsx o CSV.");
  }
  return parseCsv(decodeText(buf));
}

/** UTF-8 when valid, otherwise Windows-1252 (Excel "CSV" in Spanish Windows). */
export function decodeText(buf: ArrayBuffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("windows-1252").decode(buf);
  }
  return text.replace(/^﻿/, "");
}

/** RFC 4180 CSV; the separator (, ; or tab) is detected from the first line. */
export function parseCsv(text: string): Table {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const count = (ch: string) => {
    let n = 0;
    let quoted = false;
    for (const c of first) {
      if (c === '"') quoted = !quoted;
      else if (c === ch && !quoted) n++;
    }
    return n;
  };
  const sep = [",", ";", "\t", "|"].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ",");
  const rows: Table = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return trimTable(rows);
}

const trimTable = (rows: Table): Table =>
  rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ""));

// ── .xlsx ───────────────────────────────────────────────────────────────────

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal zip reader: returns the files whose name passes `want`. */
async function unzip(buf: ArrayBuffer, want: (name: string) => boolean): Promise<Map<string, string>> {
  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("El archivo no es un Excel válido.");
  const entries = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const utf8 = new TextDecoder();
  for (let n = 0; n < entries; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    const data = method === 0 ? raw : method === 8 ? await inflate(raw) : null;
    if (data) out.set(name, utf8.decode(data));
  }
  return out;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

/** Text of every <t> inside a fragment (handles rich text runs). */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!)).join("");

const colIndex = (ref: string) => {
  const letters = ref.replace(/\d+/g, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** First worksheet of an .xlsx as a table of strings. */
export async function readXlsx(buf: ArrayBuffer): Promise<Table> {
  const files = await unzip(buf, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));

  // First sheet in workbook order (not necessarily sheet1.xml).
  let sheetPath = "xl/worksheets/sheet1.xml";
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(files.get("xl/workbook.xml") ?? "")?.[1];
  if (rid) {
    const rel = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*/?>`).exec(files.get("xl/_rels/workbook.xml.rels") ?? "")?.[0];
    const target = rel && /Target="([^"]+)"/.exec(rel)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = files.get(sheetPath) ?? [...files.entries()].find(([n]) => n.startsWith("xl/worksheets/"))?.[1];
  if (!sheet) throw new Error("No encontré ninguna hoja en el Excel.");

  const rows: Table = [];
  for (const r of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(/\br="(\d+)"/.exec(r[1]!)?.[1] ?? rows.length + 1) - 1;
    const cells: string[] = [];
    let next = 0;
    for (const c of r[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const body = c[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = "";
      if (type === "s") value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = textOf(body);
      else if (type === "b") value = v === "1" ? "VERDADERO" : "FALSO";
      else if (v !== undefined) {
        value = decodeXml(v);
        // Phone numbers stored as numbers can come as 5.5123456789E9.
        if (/^-?\d+(\.\d+)?E[+-]?\d+$/i.test(value)) {
          const n = Number(value);
          if (Number.isFinite(n) && Number.isInteger(n)) value = n.toFixed(0);
        }
      }
      cells[idx] = value;
    }
    rows[rowNum] = Array.from(cells, (x) => x ?? "");
  }
  return trimTable(Array.from(rows, (r) => r ?? []));
}
