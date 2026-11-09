import { describe, expect, it } from "vitest";
import { summarizeBody } from "../utils/socialAuthDiagnostics.js";

describe("summarizeBody", () => {
  it("reports nested field types and string lengths without string values", () => {
    const token = "fake-identity-token-secret";
    const email = "private.person@example.com";
    const summary = summarizeBody({
      provider: "apple",
      identityToken: token,
      email,
      fullName: {
        givenName: "Private First Name",
        familyName: null,
      },
    });

    expect(summary).toEqual([
      { path: "provider", type: "string", length: 5 },
      { path: "identityToken", type: "string", length: token.length },
      { path: "email", type: "string", length: email.length },
      { path: "fullName", type: "object" },
      {
        path: "fullName.givenName",
        type: "string",
        length: "Private First Name".length,
      },
      { path: "fullName.familyName", type: "null" },
    ]);

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain("Private First Name");
    expect(serialized).not.toContain("apple");
  });
});
