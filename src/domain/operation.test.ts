import { describe, expect, it } from "vitest";
import { operation } from "./operation.js";

describe("operation model", () => {
  it("features per model", () => {
    expect(operation("walk_in")).toMatchObject({ delivery: false, counter: true, hybrid: false, defaultFulfillment: "walk_in" });
    expect(operation("delivery")).toMatchObject({ delivery: true, counter: false, hybrid: false, defaultFulfillment: "delivery" });
    expect(operation("hybrid")).toMatchObject({ delivery: true, counter: true, hybrid: true, defaultFulfillment: "walk_in" });
    expect(operation(undefined).model).toBe("hybrid");
  });
});
