import { describe, expect, it } from "vitest";
import { addDays, bucketLabel, change, csvMoney, daysBetween, matchPreset, presetRange, previousRange, toCsv, validRange } from "./range";

describe("analytics ranges", () => {
  const today = "2026-03-15";
  it("presets", () => {
    expect(presetRange("today", today)).toEqual({ from: today, to: today });
    expect(presetRange("7d", today)).toEqual({ from: "2026-03-09", to: today });
    expect(presetRange("month", today)).toEqual({ from: "2026-03-01", to: today });
    expect(presetRange("last_month", today)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("last_month", "2026-01-10")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("year", today)).toEqual({ from: "2026-01-01", to: today });
    expect(matchPreset({ from: "2026-03-09", to: today }, today)).toBe("7d");
    expect(matchPreset({ from: "2026-03-02", to: today }, today)).toBe("custom");
  });

  it("previous period has the same length (same rule as the database)", () => {
    const r = { from: "2026-03-01", to: "2026-03-10" };
    expect(previousRange(r)).toEqual({ from: "2026-02-19", to: "2026-02-28" });
    expect(daysBetween(r.from, r.to)).toBe(10);
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("change and validation", () => {
    expect(change(150, 100)).toBeCloseTo(0.5);
    expect(change(50, 100)).toBeCloseTo(-0.5);
    expect(change(10, 0)).toBeNull();
    expect(change(0, 0)).toBe(0);
    expect(validRange({ from: "2026-03-10", to: "2026-03-01" })).toMatch(/anterior/);
    expect(validRange({ from: "2020-01-01", to: "2026-03-01" })).toMatch(/3 años/);
    expect(validRange({ from: "2026-03-01", to: "2026-03-10" })).toBeNull();
  });

  it("labels", () => {
    expect(bucketLabel("2026-03-02", "week")).toMatch(/^Sem\. 2/);
    expect(bucketLabel("2026-03-01", "month")).toMatch(/mar/);
  });

  it("csv escapes and neutralises formulas", () => {
    const csv = toCsv(["a", "b"], [["Pérez, Ana", 'dijo "hola"'], ["=HYPERLINK()", 12.5], [null, undefined]]);
    expect(csv.split("\r\n")).toEqual(["a,b", '"Pérez, Ana","dijo ""hola"""', "'=HYPERLINK(),12.5", ","]);
    expect(csvMoney(123450)).toBe("1234.50");
  });
});
