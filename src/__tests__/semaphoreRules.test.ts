import { describe, it, expect } from "vitest";
import {
  aggregateStatus,
  checkAnomaly,
  checkCapExceeded,
  checkDailyPointsCap,
  checkDateMismatch,
  checkMockLocation,
  checkOcrLowConfidence,
  checkPivaMismatch,
  checkYoungAccount,
} from "../services/semaphoreRules.js";

describe("checkDailyPointsCap", () => {
  const platform = { maxPointsPerUserPerDay: 6000, maxPointsPerBarPerDay: 50000 };

  it("nessun segnale sotto i tetti", () => {
    expect(checkDailyPointsCap(1000, 1000, 500, platform)).toBeNull();
  });

  it("segnala il tetto utente, che ha precedenza su quello del bar", () => {
    const s = checkDailyPointsCap(5800, 49900, 500, platform);
    expect(s?.code).toBe("DAILY_POINTS_CAP");
    expect(s?.reason).toContain("utente");
  });

  it("segnala il tetto del bar", () => {
    const s = checkDailyPointsCap(0, 49900, 500, platform);
    expect(s?.reason).toContain("bar");
  });

  it("il valore esattamente uguale al tetto è consentito", () => {
    expect(checkDailyPointsCap(5500, 0, 500, platform)).toBeNull();
  });
});

describe("checkCapExceeded", () => {
  it("ignora il cap se disabilitato", () => {
    expect(checkCapExceeded(100, { capEnabled: false, capAmount: 30 })).toBeNull();
  });
  it("segnala importi sopra il cap", () => {
    expect(checkCapExceeded(30.01, { capEnabled: true, capAmount: 30 })?.severity).toBe("review");
  });
  it("accetta l'importo pari al cap", () => {
    expect(checkCapExceeded(30, { capEnabled: true, capAmount: 30 })).toBeNull();
  });
});

describe("checkAnomaly", () => {
  it("non segnala senza storico", () => {
    expect(checkAnomaly(100, null, 3)).toBeNull();
    expect(checkAnomaly(100, 0, 3)).toBeNull();
  });
  it("segnala sopra media × moltiplicatore", () => {
    expect(checkAnomaly(31, 10, 3)?.code).toBe("ANOMALY");
  });
  it("non segnala entro la soglia", () => {
    expect(checkAnomaly(30, 10, 3)).toBeNull();
  });
});

describe("checkYoungAccount", () => {
  const platform = { youngAccountMinDays: 7, youngAccountMinRequests: 3, youngAccountMaxAmount: 15 };

  it("segnala account giovane con importo alto", () => {
    expect(checkYoungAccount(20, 1, 0, platform)?.code).toBe("YOUNG_ACCOUNT");
  });
  it("segnala anche se vecchio ma con poche richieste", () => {
    expect(checkYoungAccount(20, 100, 1, platform)?.code).toBe("YOUNG_ACCOUNT");
  });
  it("non segnala importi bassi", () => {
    expect(checkYoungAccount(10, 1, 0, platform)).toBeNull();
  });
  it("non segnala account maturi", () => {
    expect(checkYoungAccount(50, 30, 10, platform)).toBeNull();
  });
});

describe("checkMockLocation", () => {
  it("rifiuta solo se la posizione è simulata e il rifiuto è attivo", () => {
    expect(checkMockLocation(true, true)?.severity).toBe("reject");
    expect(checkMockLocation(true, false)).toBeNull();
    expect(checkMockLocation(false, true)).toBeNull();
    expect(checkMockLocation(undefined, true)).toBeNull();
  });
});

describe("checkPivaMismatch", () => {
  it("rifiuta P.IVA diverse", () => {
    expect(checkPivaMismatch("12345678901", "10987654321")?.code).toBe("PIVA_MISMATCH");
  });
  it("ignora la formattazione", () => {
    expect(checkPivaMismatch("IT 12345678901", "12345678901")).toBeNull();
  });
  it("una P.IVA non letta non è un mismatch", () => {
    expect(checkPivaMismatch(null, "12345678901")).toBeNull();
    expect(checkPivaMismatch(undefined, "12345678901")).toBeNull();
  });
});

describe("checkDateMismatch", () => {
  it("segnala una data diversa da oggi", () => {
    expect(checkDateMismatch("2026-01-01", "2026-01-02")?.severity).toBe("review");
  });
  it("accetta la data di oggi o assente", () => {
    expect(checkDateMismatch("2026-01-02", "2026-01-02")).toBeNull();
    expect(checkDateMismatch(null, "2026-01-02")).toBeNull();
  });
});

describe("checkOcrLowConfidence", () => {
  it("nessun segnale senza sessione OCR", () => {
    expect(checkOcrLowConfidence(false, { amount: false, vatNumber: false })).toBeNull();
  });
  it("elenca i campi mancanti", () => {
    const s = checkOcrLowConfidence(true, { amount: true, vatNumber: false, docId: false });
    expect(s?.reason).toContain("P.IVA");
    expect(s?.reason).toContain("numero documento");
    expect(s?.reason).not.toContain("importo");
  });
  it("tutti i campi presenti → nessun segnale", () => {
    expect(checkOcrLowConfidence(true, { amount: true, vatNumber: true, docId: true })).toBeNull();
  });
});

describe("aggregateStatus", () => {
  const review = { code: "ANOMALY", severity: "review", reason: "x" } as const;
  const reject = { code: "DUPLICATE", severity: "reject", reason: "x" } as const;

  it("verde senza segnali", () => expect(aggregateStatus([])).toBe("green"));
  it("giallo con soli segnali review", () => expect(aggregateStatus([review])).toBe("yellow"));
  it("rosso se c'è almeno un reject", () => expect(aggregateStatus([review, reject])).toBe("red"));
});
