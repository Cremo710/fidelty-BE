export interface PointsAllocation {
  userId: string;
  pointsAllocated: number;
}

export function splitPointsEqually(points: number, userIds: string[]): PointsAllocation[] {
  if (!Number.isInteger(points) || points < 0 || userIds.length === 0) {
    throw new Error("INVALID_POINTS_ALLOCATION");
  }
  if (new Set(userIds).size !== userIds.length) {
    throw new Error("DUPLICATE_POINTS_ALLOCATION_USER");
  }

  const basePoints = Math.floor(points / userIds.length);
  const remainder = points % userIds.length;

  return userIds.map((userId, index) => ({
    userId,
    pointsAllocated: basePoints + (index < remainder ? 1 : 0),
  }));
}
