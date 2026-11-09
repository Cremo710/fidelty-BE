import { describe, expect, it, vi } from "vitest";
import { generatePublicId, generateUniquePublicId } from "../utils/publicId.js";

describe("public id generation", () => {
  it("uses the existing FU-XXXXX format and alphanumeric alphabet", () => {
    const publicId = generatePublicId();
    expect(publicId).toHaveLength(8);
    expect(publicId).toMatch(/^FU-[A-Z0-9]{5}$/);
  });

  it("retries candidates already present in the database", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [] });
    const candidateGenerator = vi
      .fn()
      .mockReturnValueOnce("FU-AAAAA")
      .mockReturnValueOnce("FU-BBBBB");

    await expect(
      generateUniquePublicId({ query }, candidateGenerator),
    ).resolves.toBe("FU-BBBBB");
    expect(query).toHaveBeenCalledTimes(2);
    expect(candidateGenerator).toHaveBeenCalledTimes(2);
  });
});
