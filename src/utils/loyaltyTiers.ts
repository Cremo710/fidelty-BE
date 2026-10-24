export const LOYALTY_TIERS = [
  { id: 'bronzo',   minPoints: 0      },
  { id: 'argento',  minPoints: 5000   },
  { id: 'oro',      minPoints: 15000  },
  { id: 'diamante', minPoints: 50000  },
  { id: 'vip',      minPoints: 100000 },
] as const;

export const MAX_TIER_INDEX = LOYALTY_TIERS.length - 1;

/**
 * Restituisce l'indice del tier più alto la cui minPoints è <= points.
 * Usa i punti guadagnati in totale (lifetime_points), non il saldo,
 * perché il livello è un traguardo storico che non scende con riscatti e trasferimenti.
 */
export function getTierIndexFromPoints(points: number): number {
  let index = 0;
  for (let i = 0; i < LOYALTY_TIERS.length; i++) {
    if (points >= LOYALTY_TIERS[i].minPoints) index = i;
  }
  return index;
}

/** Livello attuale, prossimo livello e punti mancanti, calcolati sui punti guadagnati in totale. */
export function getTierProgress(lifetimePoints: number) {
  const levelIndex = getTierIndexFromPoints(lifetimePoints);
  const next = levelIndex < MAX_TIER_INDEX ? LOYALTY_TIERS[levelIndex + 1] : null;
  return {
    level: levelIndex,
    levelId: LOYALTY_TIERS[levelIndex].id,
    currentMinPoints: LOYALTY_TIERS[levelIndex].minPoints,
    nextLevel: next ? levelIndex + 1 : null,
    nextLevelId: next ? next.id : null,
    nextMinPoints: next ? next.minPoints : null,
    pointsToNextLevel: next ? Math.max(next.minPoints - lifetimePoints, 0) : 0,
  };
}
