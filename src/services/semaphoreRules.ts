import type { BarConfigDTO } from "../repositories/barConfigRepository.js";
import type { SemaphoreStatus, SignalFlag } from "./semaphoreService.js";

// Regole pure del semaforo: nessun accesso a DB, testabili in isolamento.

export interface DailyCapPlatform {
  maxPointsPerUserPerDay: number;
  maxPointsPerBarPerDay: number;
}

export interface YoungAccountPlatform {
  youngAccountMinDays: number;
  youngAccountMinRequests: number;
  youngAccountMaxAmount: number;
}

export function checkDailyPointsCap(
  userDailyPoints: number,
  barDailyPoints: number,
  pointsPreview: number,
  platform: DailyCapPlatform,
): SignalFlag | null {
  if (userDailyPoints + pointsPreview > platform.maxPointsPerUserPerDay) {
    return {
      code: "DAILY_POINTS_CAP",
      severity: "review",
      reason: `Tetto punti giornaliero utente raggiunto (${userDailyPoints} pt oggi, limite ${platform.maxPointsPerUserPerDay} pt).`,
    };
  }
  if (barDailyPoints + pointsPreview > platform.maxPointsPerBarPerDay) {
    return {
      code: "DAILY_POINTS_CAP",
      severity: "review",
      reason: `Tetto punti giornaliero del bar raggiunto (${barDailyPoints} pt oggi, limite ${platform.maxPointsPerBarPerDay} pt).`,
    };
  }
  return null;
}

export function checkCapExceeded(amount: number, barConfig: Pick<BarConfigDTO, "capEnabled" | "capAmount">): SignalFlag | null {
  if (barConfig.capEnabled && amount > barConfig.capAmount) {
    return {
      code: "CAP_EXCEEDED",
      severity: "review",
      reason: `Importo (${amount.toFixed(2)} €) supera il limite configurato dal bar (${barConfig.capAmount.toFixed(2)} €).`,
    };
  }
  return null;
}

export function checkAnomaly(amount: number, avgAmount: number | null, multiplier: number): SignalFlag | null {
  if (avgAmount !== null && avgAmount > 0 && amount > avgAmount * multiplier) {
    return {
      code: "ANOMALY",
      severity: "review",
      reason: `Importo (${amount.toFixed(2)} €) supera ${multiplier}× la media storica del cliente (${avgAmount.toFixed(2)} €).`,
    };
  }
  return null;
}

export function checkYoungAccount(
  amount: number,
  accountAgeDays: number,
  approvedRequestCount: number,
  platform: YoungAccountPlatform,
): SignalFlag | null {
  const isYoung =
    accountAgeDays < platform.youngAccountMinDays ||
    approvedRequestCount < platform.youngAccountMinRequests;

  if (isYoung && amount > platform.youngAccountMaxAmount) {
    return {
      code: "YOUNG_ACCOUNT",
      severity: "review",
      reason: `Account giovane (${accountAgeDays} giorni, ${approvedRequestCount} consumazioni) con importo elevato (${amount.toFixed(2)} €).`,
    };
  }
  return null;
}

export function checkMockLocation(isMockedLocation: boolean | undefined, rejectEnabled: boolean): SignalFlag | null {
  if (isMockedLocation && rejectEnabled) {
    return {
      code: "MOCK_LOCATION",
      severity: "reject",
      reason: "Posizione simulata rilevata. La richiesta non può essere accettata.",
    };
  }
  return null;
}

// Una P.IVA non letta (null) non è un mismatch: è un caso di OCR_LOW_CONFIDENCE
export function checkPivaMismatch(ocrVatNumber: string | null | undefined, barPiva: string | null | undefined): SignalFlag | null {
  if (ocrVatNumber === null || ocrVatNumber === undefined || barPiva === null || barPiva === undefined) {
    return null;
  }
  const cleanOcr = ocrVatNumber.replace(/\D/g, "");
  const cleanBar = barPiva.replace(/\D/g, "");
  if (cleanOcr && cleanBar && cleanOcr !== cleanBar) {
    return {
      code: "PIVA_MISMATCH",
      severity: "reject",
      reason: `La P.IVA sullo scontrino (${cleanOcr}) non corrisponde a quella del bar.`,
    };
  }
  return null;
}

export function checkDateMismatch(ocrReceiptDate: string | null | undefined, todayRome: string): SignalFlag | null {
  if (ocrReceiptDate && ocrReceiptDate !== todayRome) {
    return {
      code: "DATE_MISMATCH",
      severity: "review",
      reason: `Data sullo scontrino (${ocrReceiptDate}) non corrisponde a oggi (${todayRome}).`,
    };
  }
  return null;
}

export function checkOcrLowConfidence(
  hasOcrSession: boolean | undefined,
  fields: { amount: boolean; vatNumber: boolean; docId?: boolean } | null | undefined,
): SignalFlag | null {
  if (hasOcrSession !== true || !fields) return null;
  const missing: string[] = [];
  if (!fields.amount) missing.push("importo");
  if (!fields.vatNumber) missing.push("P.IVA");
  if (fields.docId === false) missing.push("numero documento");
  if (missing.length === 0) return null;
  return {
    code: "OCR_LOW_CONFIDENCE",
    severity: "review",
    reason: `OCR non ha rilevato: ${missing.join(", ")}. Richiede verifica del barista.`,
  };
}

export function aggregateStatus(signals: SignalFlag[]): SemaphoreStatus {
  if (signals.some((s) => s.severity === "reject")) return "red";
  return signals.length === 0 ? "green" : "yellow";
}
