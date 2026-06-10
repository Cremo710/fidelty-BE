import { databaseService } from "../services/databaseService.js";

export interface BarConfigDTO {
  barId: string;
  gpsRadiusMeters: number;
  autoCreditEnabled: boolean;
  capEnabled: boolean;
  capAmount: number;
  anomalyEnabled: boolean;
  youngAccountEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DEFAULTS: Omit<BarConfigDTO, "barId" | "createdAt" | "updatedAt"> = {
  gpsRadiusMeters: 100,
  autoCreditEnabled: true,
  capEnabled: false,
  capAmount: 100,
  anomalyEnabled: false,
  youngAccountEnabled: false,
};

function mapRow(row: any): BarConfigDTO {
  return {
    barId: row.bar_id,
    gpsRadiusMeters: Number(row.gps_radius_meters),
    autoCreditEnabled: Boolean(row.auto_credit_enabled),
    capEnabled: Boolean(row.cap_enabled),
    capAmount: Number(row.cap_amount),
    anomalyEnabled: Boolean(row.anomaly_enabled),
    youngAccountEnabled: Boolean(row.young_account_enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BarConfigRepository {
  /** Returns stored config for a bar, falling back to defaults if not found. */
  async getByBarId(barId: string): Promise<BarConfigDTO> {
    const result = await databaseService
      .getPool()
      .query("SELECT * FROM bar_config WHERE bar_id = $1", [barId]);

    if (result.rows.length === 0) {
      const now = new Date();
      return { barId, ...DEFAULTS, createdAt: now, updatedAt: now };
    }

    return mapRow(result.rows[0]);
  }

  async upsert(
    barId: string,
    patch: Partial<Omit<BarConfigDTO, "barId" | "createdAt" | "updatedAt">>,
  ): Promise<BarConfigDTO> {
    const query = `
      INSERT INTO bar_config (
        bar_id,
        gps_radius_meters, auto_credit_enabled,
        cap_enabled, cap_amount,
        anomaly_enabled, young_account_enabled,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      ON CONFLICT (bar_id) DO UPDATE SET
        gps_radius_meters     = COALESCE($2, bar_config.gps_radius_meters),
        auto_credit_enabled   = COALESCE($3, bar_config.auto_credit_enabled),
        cap_enabled           = COALESCE($4, bar_config.cap_enabled),
        cap_amount            = COALESCE($5, bar_config.cap_amount),
        anomaly_enabled       = COALESCE($6, bar_config.anomaly_enabled),
        young_account_enabled = COALESCE($7, bar_config.young_account_enabled),
        updated_at            = CURRENT_TIMESTAMP
      RETURNING *
    `;

    const current = await this.getByBarId(barId);
    const values = [
      barId,
      patch.gpsRadiusMeters    ?? current.gpsRadiusMeters,
      patch.autoCreditEnabled  ?? current.autoCreditEnabled,
      patch.capEnabled         ?? current.capEnabled,
      patch.capAmount          ?? current.capAmount,
      patch.anomalyEnabled     ?? current.anomalyEnabled,
      patch.youngAccountEnabled ?? current.youngAccountEnabled,
    ];

    const result = await databaseService.getPool().query(query, values);
    return mapRow(result.rows[0]);
  }
}

export const barConfigRepository = new BarConfigRepository();
