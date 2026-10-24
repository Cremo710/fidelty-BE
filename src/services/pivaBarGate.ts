export type BarLookup<T extends { id: string }> = (piva: string) => Promise<T | null>;

export type PivaBarGateResult<T extends { id: string }> =
  | { blocked: false; bar: T }
  | {
      blocked: true;
      status: 404 | 422;
      code: "PIVA_NOT_READABLE" | "BAR_NOT_FOUND_BY_PIVA";
      error: string;
    };

// Decide se una P.IVA letta dall'OCR permette di proseguire verso un bar noto
export async function evaluatePivaBarGate<T extends { id: string }>(
  extractedVatNumber: string | null,
  findByPiva: BarLookup<T>,
): Promise<PivaBarGateResult<T>> {
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

  return { blocked: false, bar };
}
