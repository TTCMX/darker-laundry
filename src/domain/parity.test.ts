// The database enforces permissions and order transitions; the UI mirrors
// them to decide what to show. These tests fail if the two copies drift.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, ORDER_TRANSITIONS } from "./orders.js";
import { PERMISSION_CODES } from "./permissions.js";
import { NOTIFICATION_EVENTS } from "./templates.js";

const dir = join(__dirname, "../../supabase/migrations");
const sql = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n");

const block = (start: string) => {
  const from = sql.indexOf(start);
  expect(from, `missing "${start}" in migrations`).toBeGreaterThan(-1);
  return sql.slice(from, sql.indexOf(";", from));
};

describe("database ↔ domain parity", () => {
  it("permission catalog", () => {
    const seeded = [...block("insert into public.permissions").matchAll(/\('([a-z_.]+)',/g)].map((m) => m[1]);
    expect([...seeded].sort()).toEqual([...PERMISSION_CODES].sort());
  });

  it("order transitions", () => {
    const pairs = [...block("insert into app.order_transitions").matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map(
      (m) => `${m[1]}>${m[2]}`,
    );
    const domain = ORDER_STATUSES.flatMap((from) => ORDER_TRANSITIONS[from].map((to) => `${from}>${to}`));
    expect(pairs.sort()).toEqual(domain.sort());
  });

  it("order statuses", () => {
    const check = block("status               text not null default 'created' check");
    for (const s of ORDER_STATUSES) expect(check).toContain(`'${s}'`);
  });

  it("notification events", () => {
    const check = block("event      text not null check (event in (");
    for (const e of NOTIFICATION_EVENTS) expect(check).toContain(`'${e}'`);
  });
});
