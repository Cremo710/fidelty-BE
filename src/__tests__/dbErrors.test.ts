import { describe, expect, it } from "vitest";
import { isDbPoolTimeout } from "../utils/dbErrors.js";

describe("isDbPoolTimeout", () => {
  it("riconosce il pool esaurito (pg-pool)", () => {
    expect(isDbPoolTimeout(new Error("timeout exceeded when trying to connect"))).toBe(true);
  });

  it("riconosce il timeout di connessione al database (pg-pool)", () => {
    expect(isDbPoolTimeout(new Error("Connection terminated due to connection timeout"))).toBe(true);
  });

  it("non scambia altri errori per un pool esaurito", () => {
    expect(isDbPoolTimeout(new Error("duplicate key value violates unique constraint"))).toBe(false);
    expect(isDbPoolTimeout(new Error("Connection terminated unexpectedly"))).toBe(false);
    expect(isDbPoolTimeout("timeout exceeded when trying to connect")).toBe(false);
    expect(isDbPoolTimeout(null)).toBe(false);
  });
});
