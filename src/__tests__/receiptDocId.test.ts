import { describe, expect, it } from "vitest";
import { extractDocId } from "../services/visionOcrService.js";

describe("extractDocId", () => {
  it("extracts the document code from the receipt OCR example", () => {
    const result = extractDocId(`DOCUMENTO COMMERCIALE
DOC.2449-0085
RT 1BMPX050938`);
    expect(result).toMatchObject({ value: "2449-0085", rule: "document_label" });
  });

  it.each([
    ["DOC.2449-0085", "2449-0085"],
    ["DOC. 2449-0085", "2449-0085"],
    ["DOC 2449-0085", "2449-0085"],
    ["DOC.2449/0085", "2449-0085"],
    ["DOC N. 2449-0085", "2449-0085"],
    ["DOC. N° 2449-0085", "2449-0085"],
    ["DOCUMENTO N. 2449-0085", "2449-0085"],
    ["DOCUMENTO NR 2449-0085", "2449-0085"],
    ["NUM. DOC. 2449-0085", "2449-0085"],
    ["NUMERO DOCUMENTO: 2449-0085", "2449-0085"],
    ["SCONTRINO N. 2449-0085", "2449-0085"],
    ["SCONTRINO FISCALE N° 0085", "0085"],
    ["N. 2449-0085", "2449-0085"],
    ["NR. 0085", "0085"],
    ["DOC\n2449.0085", "2449-0085"],
    ["DOC\n2449 0085", "2449-0085"],
    ["D0C, 2449-O085", "2449-0085"],
    ["DOC. 2I49-OO85", "2149-0085"],
    ["DOCUMENTO\nN° 2449-S085", "2449-5085"],
  ])("normalizes %s", (text, value) => {
    expect(extractDocId(text)?.value).toBe(value);
  });

  it.each([
    "Scontrino privo del numero",
    "P.IVA 03739970139",
    "RT 1BMPX050938",
    "M.268810",
    "Op.1",
    "06/11/26 23:51",
    "CAP 22100",
    "Telefono 0311234567",
    "Importo 5.00",
  ])("does not mistake unrelated receipt data for a document code: %s", (text) => {
    expect(extractDocId(text)).toBeNull();
  });

  it("returns null rather than guessing between similarly ranked document codes", () => {
    expect(extractDocId("DOC. 2449-0085\nDOC. 1234-5678")).toBeNull();
  });
});
