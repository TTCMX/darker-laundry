// Icons render from a subset font (scripts/build-icons.py). This fails when
// code uses an icon that is not in the subset: run `npm run icons`.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

describe("icon font subset", () => {
  it("contains every icon used in the code", () => {
    const available = new Set<string>(JSON.parse(readFileSync(join(root, "../public/fonts/material-symbols.json"), "utf8")));
    const used = new Set<string>();
    for (const f of files(root)) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:\bicon=|<Icon name=|\bicon: )"([a-z0-9_]+)"/g)) used.add(m[1]!);
    }
    const missing = [...used].filter((i) => !available.has(i));
    expect(missing, "run `npm run icons`").toEqual([]);
    expect(used.size).toBeGreaterThan(20);
  });
});
