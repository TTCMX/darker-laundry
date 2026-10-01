// The database enforces permissions and order transitions; the UI mirrors
// them to decide what to show. These tests fail if the two copies drift.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, ORDER_TRANSITIONS } from "./orders.js";
import { PERMISSION_CODES } from "./permissions.js";
import { READ_ONLY_EXTRA, allowedReadOnly } from "./plan.js";
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
    // Every migration that adds permissions (the catalog grows over time).
    const blocks = sql.split("insert into public.permissions").slice(1).map((b) => b.slice(0, b.indexOf(";")));
    const seeded = blocks.flatMap((b) => [...b.matchAll(/\('([a-z_.]+)',/g)].map((m) => m[1]));
    expect([...seeded].sort()).toEqual([...PERMISSION_CODES].sort());
  });

  it("permissions allowed in read-only mode (trial over)", () => {
    const fn = block("create or replace function app.allowed_read_only");
    expect(fn).toContain("like '%.view'");
    const extra = [...(/in \(([^)]*)\)/.exec(fn)?.[1] ?? "").matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);
    expect(extra.sort()).toEqual([...READ_ONLY_EXTRA].sort());
    expect(PERMISSION_CODES.filter(allowedReadOnly)).toContain("reports.view");
    expect(allowedReadOnly("orders.create")).toBe(false);
  });

  it("order transitions", () => {
    // Every migration that adds transitions.
    const inserts = sql.split("insert into app.order_transitions").slice(1).map((b) => b.slice(0, b.indexOf(";"))).join("\n");
    const pairs = [...inserts.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map(
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
