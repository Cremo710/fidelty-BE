import { describe, expect, it } from "vitest";
import { renderPlainTextEmail } from "../services/emailService.js";

describe("renderPlainTextEmail", () => {
  it("uses the Fidelty email layout and escapes subject and body content", () => {
    const html = renderPlainTextEmail("Invito <bar>", "Ciao & benvenuto\n<non markup>");

    expect(html).toContain('bgcolor="#15102A"');
    expect(html).toContain("logo-white.png");
    expect(html).toContain("fidelty.app");
    expect(html).toContain("<h1");
    expect(html).toContain("Invito &lt;bar&gt;");
    expect(html).toContain("Ciao &amp; benvenuto\n&lt;non markup&gt;");
    expect(html).not.toContain("<non markup>");
  });
});
