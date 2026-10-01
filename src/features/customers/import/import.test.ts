import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildRows, guessMapping, toIsoDate } from "./mapping";
import { decodeText, parseCsv, readXlsx } from "./parse";

/** Tiny zip writer for the test (stored + deflated entries). */
function zip(files: Record<string, string>): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  let i = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = enc.encode(content);
    const deflate = i++ % 2 === 0;
    const data = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const nameB = enc.encode(name);
    const local = new Uint8Array(30 + nameB.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameB.length, true);
    local.set(nameB, 30);
    local.set(data, 30 + nameB.length);
    const central = new Uint8Array(46 + nameB.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameB, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...locals, ...centrals, end];
  const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out.buffer;
}

describe("customer import: files", () => {
  it("csv with quotes, semicolons and blank lines", () => {
    const t = parseCsv('Nombre;Teléfono;Notas\r\n"López, Ana";55 1234 5678;"dice ""hola""\nsegunda línea"\r\n\r\nBeto;;\r\n');
    expect(t).toEqual([
      ["Nombre", "Teléfono", "Notas"],
      ["López, Ana", "55 1234 5678", 'dice "hola"\nsegunda línea'],
      ["Beto", "", ""],
    ]);
  });

  it("decodes UTF-8 with BOM and Excel's Windows encoding", () => {
    const utf8 = new TextEncoder().encode("﻿Nombre,Teléfono");
    expect(decodeText(utf8.buffer as ArrayBuffer)).toBe("Nombre,Teléfono");
    const cp1252 = new Uint8Array([0x4e, 0xfa, 0xf1, 0x65, 0x7a]); // "Núñez"
    expect(decodeText(cp1252.buffer)).toBe("Núñez");
  });

  it("reads the first sheet of an .xlsx (shared strings, inline strings, numbers, gaps)", async () => {
    const buf = zip({
      "xl/workbook.xml": '<workbook><sheets><sheet name="Clientes" sheetId="1" r:id="rId3"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId3" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>',
      "xl/sharedStrings.xml": "<sst><si><t>Nombre</t></si><si><t>Tel</t></si><si><r><t>María </t></r><r><t>Pérez &amp; Cía</t></r></si><si><t>Colonia</t></si></sst>",
      "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>WRONG SHEET</t></is></c></row></sheetData></worksheet>",
      "xl/worksheets/sheet2.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>3</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><v>5.512345678E9</v></c><c r="D3" t="inlineStr"><is><t>Roma</t></is></c></row></sheetData></worksheet>',
    });
    expect(await readXlsx(buf)).toEqual([
      ["Nombre", "Tel", "", "Colonia"],
      ["María Pérez & Cía", "5512345678", "", "Roma"],
    ]);
  });
});

describe("customer import: mapping", () => {
  it("recognises common headers from other systems", () => {
    expect(guessMapping(["Nombre", "Apellidos", "Tel. Celular", "E-mail", "Dirección", "Col.", "C.P.", "Observaciones", "Puntos", "Fecha de alta", "ID"])).toEqual([
      "name", "name", "phone", "email", "line1", "neighborhood", "postal_code", "notes", "points", "customer_since", "",
    ]);
    // A field is only guessed once (except name).
    expect(guessMapping(["Teléfono", "Celular"])).toEqual(["phone", ""]);
  });

  it("builds rows: joins name parts, tags, dates, points", () => {
    const rows = buildRows(
      [
        ["Ana", "López", "vip", "frecuente", "45292", "1,200 pts"],
        ["", "", "", "", "", ""],
        ["Beto", "", "", "", "03/02/2024", ""],
      ],
      ["name", "name", "tags", "tags", "customer_since", "points"],
    );
    expect(rows).toEqual([
      { line: 2, row: { name: "Ana López", tags: "vip, frecuente", customer_since: "2024-01-01", points: "1200" } },
      { line: 4, row: { name: "Beto", customer_since: "2024-02-03" } },
    ]);
    expect(toIsoDate("2024-3-5")).toBe("2024-03-05");
  });
});
