import { describe, expect, it } from "vitest";
import { splitPointsEqually } from "../utils/pointsAllocation.js";

describe("splitPointsEqually", () => {
  it("divides receipt points evenly and assigns the remainder in participant order", () => {
    expect(splitPointsEqually(10, ["owner", "friend-a", "friend-b"])).toEqual([
      { userId: "owner", pointsAllocated: 4 },
      { userId: "friend-a", pointsAllocated: 3 },
      { userId: "friend-b", pointsAllocated: 3 },
    ]);
  });

  it("preserves all points when some participants receive zero", () => {
    expect(splitPointsEqually(1, ["owner", "friend"])).toEqual([
      { userId: "owner", pointsAllocated: 1 },
      { userId: "friend", pointsAllocated: 0 },
    ]);
  });

  it.each([
    [-1, ["owner"]],
    [1.5, ["owner"]],
    [1, []],
    [1, ["owner", "owner"]],
  ])("rejects invalid allocations", (points, userIds) => {
    expect(() => splitPointsEqually(points, userIds)).toThrow();
  });
});
