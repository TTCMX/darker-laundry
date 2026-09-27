// ESC/POS receipt builder for 58 mm (32 columns) and 80 mm (48 columns)
// thermal printers. Pure: takes already formatted strings and returns the
// bytes to send, so it is shared by every transport (Bluetooth today).

export type PaperWidth = 32 | 48;

export interface ReceiptLine {
  left: string;
  right?: string;
  bold?: boolean;
  /** Small second line under the row (e.g. "2 kg x $45.00"). */
  detail?: string;
}

export interface ReceiptDoc {
  /** Printed big and centered. */
  title: string;
  /** Centered lines under the title (legal name, tax id, phone, address...). */
  header: string[];
  /** Left aligned info (order number, date, customer...). */
  info: string[];
  items: ReceiptLine[];
  totals: ReceiptLine[];
  /** Payments, balance, loyalty... each group separated by a rule. */
  sections: ReceiptLine[][];
  /** Free text lines (order notes). */
  notes: string[];
  /** Centered text at the bottom. */
  footer: string[];
  qr?: string | null;
  /** Blank box at the top to write on the paper ticket. */
  annotationSpace?: boolean;
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export const CMD = {
  INIT: [ESC, 0x40],
  BOLD: [ESC, 0x45, 1],
  UNBOLD: [ESC, 0x45, 0],
  CENTER: [ESC, 0x61, 1],
  LEFT: [ESC, 0x61, 0],
  BIG: [GS, 0x21, 0x11],
  NORMAL: [GS, 0x21, 0x00],
  CUT: [GS, 0x56, 0x41, 0x10],
} as const;

/**
 * Cheap thermal printers don't agree on code pages, so we print plain ASCII:
 * accents are dropped ("Recolección" → "Recoleccion"), and anything else
 * outside ASCII becomes a close equivalent or disappears.
 */
export function toAscii(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[   ]/g, " ")
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/·/g, "-")
    .replace(/…/g, "...")
    .replace(/[¡¿]/g, "")
    .replace(/[^\x20-\x7e\n]/g, "");
}

/** Word-wraps to `width` columns, hard-breaking words that don't fit. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of toAscii(text).split("\n")) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** Left text and right-aligned amount on one line; long labels wrap above the amount. */
export function row(left: string, right: string, width: number): string[] {
  const l = toAscii(left).trim();
  const r = toAscii(right).trim();
  if (l.length + 1 + r.length <= width) return [l + " ".repeat(width - l.length - r.length) + r];
  const lines = wrap(l, width);
  const last = lines[lines.length - 1] ?? "";
  if (last.length + 1 + r.length <= width) {
    lines[lines.length - 1] = last + " ".repeat(width - last.length - r.length) + r;
    return lines;
  }
  return [...lines, " ".repeat(Math.max(0, width - r.length)) + r];
}

/** One printed line, device independent: ESC/POS bytes and the browser preview both come from here. */
export type LayoutLine =
  | { text: string; center?: boolean; bold?: boolean; big?: boolean }
  | { qr: string };

export function layout(doc: ReceiptDoc, width: PaperWidth = 32): LayoutLine[] {
  const out: LayoutLine[] = [];
  let center = true;
  const text = (t: string, style: { bold?: boolean; big?: boolean } = {}) => out.push({ text: t, center, ...style });
  const rule = () => text(".".repeat(width));
  const rows = (rs: ReceiptLine[]) => {
    for (const r of rs) {
      for (const l of r.right === undefined ? wrap(r.left, width) : row(r.left, r.right, width)) text(l, { bold: r.bold });
      if (r.detail) for (const l of wrap(r.detail, width)) text(l);
    }
  };

  if (doc.annotationSpace) {
    text("_".repeat(width));
    ["", "", "", ""].forEach((l) => text(l));
    text("_".repeat(width));
    text("");
  }
  // Double width halves the columns.
  for (const l of wrap(doc.title, Math.floor(width / 2))) text(l, { bold: true, big: true });
  for (const h of doc.header) for (const l of wrap(h, width)) text(l);
  text("");

  center = false;
  for (const i of doc.info) for (const l of wrap(i, width)) text(l);
  rule();
  for (const group of [doc.items, doc.totals, ...doc.sections]) {
    if (!group.length) continue;
    rows(group);
    rule();
  }
  if (doc.notes.length) {
    for (const n of doc.notes) for (const l of wrap(n, width)) text(l);
    rule();
  }

  center = true;
  if (doc.qr) {
    text("");
    out.push({ qr: doc.qr });
  }
  if (doc.footer.length) {
    text("");
    for (const f of doc.footer) for (const l of wrap(f, width)) text(l);
  }
  return out;
}

function qrBytes(data: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(toAscii(data)));
  const len = bytes.length + 3;
  return [
    ...[GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00], // model 2
    ...[GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06], // module size
    ...[GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31], // error correction M
    ...[GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...bytes],
    ...[GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30], // print
  ];
}

export function buildReceipt(doc: ReceiptDoc, width: PaperWidth = 32): Uint8Array {
  const out: number[] = [...CMD.INIT];
  let center: boolean | null = null;
  let bold = false;
  let big = false;
  for (const line of layout(doc, width)) {
    if ("qr" in line) {
      if (center !== true) out.push(...CMD.CENTER);
      center = true;
      out.push(...qrBytes(line.qr), LF);
      continue;
    }
    const c = !!line.center;
    if (c !== center) out.push(...(c ? CMD.CENTER : CMD.LEFT));
    if (!!line.big !== big) out.push(...(line.big ? CMD.BIG : CMD.NORMAL));
    if (!!line.bold !== bold) out.push(...(line.bold ? CMD.BOLD : CMD.UNBOLD));
    center = c;
    big = !!line.big;
    bold = !!line.bold;
    for (let i = 0; i < line.text.length; i++) out.push(line.text.charCodeAt(i));
    out.push(LF);
  }
  if (big) out.push(...CMD.NORMAL);
  if (bold) out.push(...CMD.UNBOLD);
  out.push(LF, LF, LF, ...CMD.CUT);
  return Uint8Array.from(out);
}
