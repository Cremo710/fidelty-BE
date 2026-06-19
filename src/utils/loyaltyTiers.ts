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
 * Usa i punti TOTALI della carta (totalPoints), non quelli disponibili,
 * perché il livello è un traguardo storico.
 */
export function getTierIndexFromPoints(points: number): number {
  let index = 0;
  for (let i = 0; i < LOYALTY_TIERS.length; i++) {
    if (points >= LOYALTY_TIERS[i].minPoints) index = i;
  }
  return index;
}
