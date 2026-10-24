import { describe, it, expect } from "vitest";
import { evaluatePivaBarGate } from "../services/pivaBarGate.js";

describe("evaluatePivaBarGate", () => {
  it("procede quando la P.IVA è valida e il bar esiste", async () => {
    const result = await evaluatePivaBarGate("12345678901", async (piva) =>
      piva === "12345678901" ? { id: "bar-1" } : null,
    );
    expect(result.blocked).toBe(false);
    if (!result.blocked) expect(result.bar.id).toBe("bar-1");
  });

  it("blocca con BAR_NOT_FOUND_BY_PIVA se nessun bar corrisponde", async () => {
    const result = await evaluatePivaBarGate("99999999999", async () => null);
    expect(result).toMatchObject({ blocked: true, status: 404, code: "BAR_NOT_FOUND_BY_PIVA" });
  });

  it("blocca con PIVA_NOT_READABLE senza interrogare il database", async () => {
    const result = await evaluatePivaBarGate(null, async () => {
      throw new Error("non deve essere chiamata");
    });
    expect(result).toMatchObject({ blocked: true, status: 422, code: "PIVA_NOT_READABLE" });
  });
});
