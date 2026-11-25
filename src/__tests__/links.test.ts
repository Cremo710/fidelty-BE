import { describe, expect, it } from "vitest";
import { normalizeLink } from "../utils/links.js";
import { barUpdateSchema as barProfileUpdateSchema } from "../validators/barValidator.js";

describe("normalizeLink", () => {
  it("lascia invariati i link già completi", () => {
    expect(normalizeLink("https://www.miobar.it")).toBe("https://www.miobar.it");
    expect(normalizeLink("http://miobar.it/menu")).toBe("http://miobar.it/menu");
    expect(normalizeLink("HTTPS://MioBar.it")).toBe("HTTPS://MioBar.it");
  });

  it("aggiunge https:// ai siti scritti senza schema", () => {
    expect(normalizeLink("www.miobar.it")).toBe("https://www.miobar.it");
    expect(normalizeLink("  miobar.it/menu  ")).toBe("https://miobar.it/menu");
  });

  it("trasforma il nome utente dei social nel link al profilo", () => {
    expect(normalizeLink("@miobar", "instagram")).toBe("https://instagram.com/miobar");
    expect(normalizeLink("@mio.bar", "instagram")).toBe("https://instagram.com/mio.bar");
    expect(normalizeLink("miobar", "facebook")).toBe("https://facebook.com/miobar");
    expect(normalizeLink("@miobar", "tiktok")).toBe("https://www.tiktok.com/@miobar");
  });

  it("per i social tratta come sito un valore con dominio", () => {
    expect(normalizeLink("instagram.com/miobar", "instagram")).toBe("https://instagram.com/miobar");
  });

  it("stringa vuota → null, altri tipi invariati", () => {
    expect(normalizeLink("   ")).toBeNull();
    expect(normalizeLink(null)).toBeNull();
    expect(normalizeLink(undefined)).toBeUndefined();
  });
});

describe("campi link del profilo bar", () => {
  it("accetta e normalizza sito e social scritti a mano", () => {
    const result = barProfileUpdateSchema.safeParse({ website: "www.miobar.it", instagram: "@miobar" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.website).toBe("https://www.miobar.it");
      expect(result.data.instagram).toBe("https://instagram.com/miobar");
    }
  });

  it("rifiuta un valore che non è un link e dice quale campo correggere", () => {
    const result = barProfileUpdateSchema.safeParse({ website: "il mio sito" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0]?.message).toMatch(/Sito web/);
    }
  });
});
