import { describe, expect, it } from "vitest";
import { parseManualCreditAmount, parseManualCreditNote } from "../utils/manualCreditInput.js";

describe("parseManualCreditAmount", () => {
  it("accetta importi in euro con al massimo due decimali", () => {
    expect(parseManualCreditAmount(12)).toBe(12);
    expect(parseManualCreditAmount(12.5)).toBe(12.5);
    expect(parseManualCreditAmount(0.1 + 0.2)).toBe(0.3);
    expect(parseManualCreditAmount("12")).toBe(12);
    expect(parseManualCreditAmount("12,50")).toBe(12.5);
    expect(parseManualCreditAmount(" 7.05 ")).toBe(7.05);
  });

  it("rifiuta testo sporco, notazione esponenziale e troppi decimali", () => {
    expect(parseManualCreditAmount("12abc")).toBeNull();
    expect(parseManualCreditAmount("1e2")).toBeNull();
    expect(parseManualCreditAmount("12.505")).toBeNull();
    expect(parseManualCreditAmount(12.505)).toBeNull();
    expect(parseManualCreditAmount("1.000,00")).toBeNull();
    expect(parseManualCreditAmount("")).toBeNull();
  });

  it("rifiuta zero, negativi, valori non finiti e tipi sbagliati", () => {
    expect(parseManualCreditAmount(0)).toBeNull();
    expect(parseManualCreditAmount("0,00")).toBeNull();
    expect(parseManualCreditAmount(-5)).toBeNull();
    expect(parseManualCreditAmount("-5")).toBeNull();
    expect(parseManualCreditAmount(Number.NaN)).toBeNull();
    expect(parseManualCreditAmount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseManualCreditAmount(null)).toBeNull();
    expect(parseManualCreditAmount(undefined)).toBeNull();
    expect(parseManualCreditAmount({ amount: 5 })).toBeNull();
  });
});

describe("parseManualCreditNote", () => {
  it("accetta nota assente o vuota come null", () => {
    expect(parseManualCreditNote(undefined)).toEqual({ ok: true, note: null });
    expect(parseManualCreditNote(null)).toEqual({ ok: true, note: null });
    expect(parseManualCreditNote("   ")).toEqual({ ok: true, note: null });
  });

  it("accetta una stringa fino a 200 caratteri", () => {
    expect(parseManualCreditNote(" caffè offerto ")).toEqual({ ok: true, note: "caffè offerto" });
    expect(parseManualCreditNote("x".repeat(200))).toEqual({ ok: true, note: "x".repeat(200) });
  });

  it("rifiuta note troppo lunghe o non testuali", () => {
    expect(parseManualCreditNote("x".repeat(201))).toEqual({ ok: false });
    expect(parseManualCreditNote(42)).toEqual({ ok: false });
    expect(parseManualCreditNote({ text: "a" })).toEqual({ ok: false });
  });
});
