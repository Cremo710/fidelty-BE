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
}

const HARDCODED_DEFAULTS: PlatformConfig = {
  rateLimitPerUserPerBarPerDay: 15,
  pointsPerEuro: 100,
  anomalyMultiplier: 3.0,
  youngAccountMinDays: 7,
  youngAccountMinRequests: 3,
  youngAccountMaxAmount: 40,
  consumptionDetailBonusPoints: 100,
  consumptionDetailTolerancePct: 20,
};

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
        rateLimitPerUserPerBarPerDay:  Number(map.get("rate_limit_per_user_per_bar_per_day"))  || HARDCODED_DEFAULTS.rateLimitPerUserPerBarPerDay,
        pointsPerEuro:                 Number(map.get("points_per_euro"))                       || HARDCODED_DEFAULTS.pointsPerEuro,
        anomalyMultiplier:             Number(map.get("anomaly_multiplier"))                    || HARDCODED_DEFAULTS.anomalyMultiplier,
        youngAccountMinDays:           Number(map.get("young_account_min_days"))                || HARDCODED_DEFAULTS.youngAccountMinDays,
        youngAccountMinRequests:       Number(map.get("young_account_min_requests"))            || HARDCODED_DEFAULTS.youngAccountMinRequests,
        youngAccountMaxAmount:         Number(map.get("young_account_max_amount"))              || HARDCODED_DEFAULTS.youngAccountMaxAmount,
        consumptionDetailBonusPoints:  Number(map.get("consumption_detail_bonus_points"))       || HARDCODED_DEFAULTS.consumptionDetailBonusPoints,
        consumptionDetailTolerancePct: Number(map.get("consumption_detail_tolerance_pct"))      || HARDCODED_DEFAULTS.consumptionDetailTolerancePct,
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
