import { databaseService } from "../services/databaseService.js";

export interface PlatformConfig {
  rateLimitPerUserPerBarPerDay: number;
  pointsPerEuro: number;
  anomalyMultiplier: number;
  youngAccountMinDays: number;
  youngAccountMinRequests: number;
  youngAccountMaxAmount: number;
  consumptionDetailBonusPoints: number;
  consumptionDetailTolerancePct: number;
  // Fase 0 — tetti punti giornalieri
  maxPointsPerUserPerDay: number;  // TODO da tarare: ~60 € di consumazioni
  maxPointsPerBarPerDay: number;   // TODO da tarare col titolare
  // Feature flags
  mockLocationReject: boolean;
}

const HARDCODED_DEFAULTS: PlatformConfig = {
  rateLimitPerUserPerBarPerDay: 4,
  pointsPerEuro: 100,
  anomalyMultiplier: 3.0,
  youngAccountMinDays: 7,
  youngAccountMinRequests: 3,
  youngAccountMaxAmount: 40,
  consumptionDetailBonusPoints: 100,
  consumptionDetailTolerancePct: 20,
  maxPointsPerUserPerDay: 6000,
  maxPointsPerBarPerDay: 200000,
  mockLocationReject: true,
};

/** Accetta anche 0; usa il default solo se il valore è assente o non numerico. */
function numberOr(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class PlatformConfigRepository {
  private cache: PlatformConfig | null = null;
  private cacheExpiresAt = 0;
  private readonly TTL_MS = 60_000; // 1 minute

  async get(): Promise<PlatformConfig> {
    if (this.cache && Date.now() < this.cacheExpiresAt) {
      return this.cache;
    }

    try {
      const result = await databaseService.getPool().query("SELECT key, value FROM platform_config");

      const map = new Map<string, any>();
      for (const row of result.rows) {
        map.set(row.key, row.value);
      }

      const config: PlatformConfig = {
        rateLimitPerUserPerBarPerDay:  numberOr(map.get("rate_limit_per_user_per_bar_per_day"), HARDCODED_DEFAULTS.rateLimitPerUserPerBarPerDay),
        pointsPerEuro:                 numberOr(map.get("points_per_euro"), HARDCODED_DEFAULTS.pointsPerEuro),
        anomalyMultiplier:             numberOr(map.get("anomaly_multiplier"), HARDCODED_DEFAULTS.anomalyMultiplier),
        youngAccountMinDays:           numberOr(map.get("young_account_min_days"), HARDCODED_DEFAULTS.youngAccountMinDays),
        youngAccountMinRequests:       numberOr(map.get("young_account_min_requests"), HARDCODED_DEFAULTS.youngAccountMinRequests),
        youngAccountMaxAmount:         numberOr(map.get("young_account_max_amount"), HARDCODED_DEFAULTS.youngAccountMaxAmount),
        consumptionDetailBonusPoints:  numberOr(map.get("consumption_detail_bonus_points"), HARDCODED_DEFAULTS.consumptionDetailBonusPoints),
        consumptionDetailTolerancePct: numberOr(map.get("consumption_detail_tolerance_pct"), HARDCODED_DEFAULTS.consumptionDetailTolerancePct),
        maxPointsPerUserPerDay:        numberOr(map.get("max_points_per_user_per_day"), HARDCODED_DEFAULTS.maxPointsPerUserPerDay),
        maxPointsPerBarPerDay:         numberOr(map.get("max_points_per_bar_per_day"), HARDCODED_DEFAULTS.maxPointsPerBarPerDay),
        mockLocationReject:             map.has("mock_location_reject") ? Boolean(map.get("mock_location_reject")) : HARDCODED_DEFAULTS.mockLocationReject,
      };

      this.cache = config;
      this.cacheExpiresAt = Date.now() + this.TTL_MS;
      return config;
    } catch {
      // If platform_config table doesn't exist yet (pre-migration), return defaults
      return HARDCODED_DEFAULTS;
    }
  }
}

export const platformConfigRepository = new PlatformConfigRepository();
