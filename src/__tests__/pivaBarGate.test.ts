import { describe, it, expect } from "vitest";

// ─── Gate P.IVA -> Bar (uploadReceiptForOcr) ───────────────────────────────
// Estrae la stessa decisione logica del controller in forma pura,
// per test unitari senza DB.

type BarLookup = (piva: string) => Promise<{ id: string } | null>;

type GateResult =
  | { blocked: false; barId: string }
  | { blocked: true; status: number; code: "PIVA_NOT_READABLE" | "BAR_NOT_FOUND_BY_PIVA"; error: string };

async function evaluatePivaBarGate(
  extractedVatNumber: string | null,
  findByPiva: BarLookup,
): Promise<GateResult> {
  if (!extractedVatNumber) {
    return {
      blocked: true,
      status: 422,
      code: "PIVA_NOT_READABLE",
      error: "Partita IVA non leggibile sullo scontrino",
    };
  }

  const bar = await findByPiva(extractedVatNumber);
  if (!bar) {
    return {
      blocked: true,
      status: 404,
      code: "BAR_NOT_FOUND_BY_PIVA",
      error: "Bar non riconosciuto, impossibile accreditare i punti",
    };
  }

  return { blocked: false, barId: bar.id };
}

describe("P.IVA -> Bar gate", () => {
  it("procede quando la P.IVA è valida e il Bar esiste", async () => {
    const findByPiva: BarLookup = async (piva) =>
      piva === "12345678901" ? { id: "bar-1" } : null;

    const result = await evaluatePivaBarGate("12345678901", findByPiva);

    expect(result.blocked).toBe(false);
    expect((result as { barId: string }).barId).toBe("bar-1");
  });

  it("blocca con BAR_NOT_FOUND_BY_PIVA quando la P.IVA è valida ma nessun Bar corrisponde", async () => {
    const findByPiva: BarLookup = async () => null;

    const result = await evaluatePivaBarGate("99999999999", findByPiva);

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.code).toBe("BAR_NOT_FOUND_BY_PIVA");
      expect(result.status).toBe(404);
    }
  });

  it("blocca con PIVA_NOT_READABLE quando l'OCR non estrae alcuna P.IVA", async () => {
    const findByPiva: BarLookup = async () => {
      throw new Error("Non deve essere chiamata quando la P.IVA è assente");
    };

    const result = await evaluatePivaBarGate(null, findByPiva);

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.code).toBe("PIVA_NOT_READABLE");
      expect(result.status).toBe(422);
    }
  });
});
