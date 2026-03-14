import { databaseService } from "../services/databaseService.js";
import type { DayHours, TimeRange } from "../validators/openingHoursValidator.js";

export interface OpeningHoursDTO {
  id: number;
  bar_id: string;
  day_of_week: number;
  is_closed: boolean;
  time_ranges: TimeRange[];
  created_at: Date;
  updated_at: Date;
}

export class OpeningHoursRepository {
  /**
   * Salva (upsert) gli orari di apertura per un bar.
   * Ogni giorno viene inserito o aggiornato atomicamente.
   */
  async setOpeningHours(barId: string, hours: DayHours[]): Promise<void> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      for (const day of hours) {
        await client.query(
          `
          INSERT INTO opening_hours (bar_id, day_of_week, is_closed, time_ranges, updated_at)
          VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
          ON CONFLICT (bar_id, day_of_week) DO UPDATE SET
            is_closed = EXCLUDED.is_closed,
            time_ranges = EXCLUDED.time_ranges,
            updated_at = CURRENT_TIMESTAMP
          `,
          [barId, day.dayOfWeek, day.isClosed, JSON.stringify(day.timeRanges)]
        );
      }

      await client.query("COMMIT");
      console.log(`✅ Orari aggiornati per bar ${barId}`);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Errore durante il salvataggio degli orari:", error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Recupera gli orari di apertura di un bar ordinati per giorno
   */
  async getOpeningHours(barId: string): Promise<OpeningHoursDTO[]> {
    try {
      const result = await databaseService.getPool().query(
        "SELECT * FROM opening_hours WHERE bar_id = $1 ORDER BY day_of_week ASC",
        [barId]
      );
      return result.rows || [];
    } catch (error) {
      console.error("❌ Errore durante il recupero degli orari:", error);
      throw error;
    }
  }

  /**
   * Recupera gli orari di un giorno specifico
   */
  async getHoursForDay(barId: string, dayOfWeek: number): Promise<OpeningHoursDTO | null> {
    try {
      const result = await databaseService.getPool().query(
        "SELECT * FROM opening_hours WHERE bar_id = $1 AND day_of_week = $2 LIMIT 1",
        [barId, dayOfWeek]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error("❌ Errore durante il recupero degli orari per giorno:", error);
      throw error;
    }
  }
}

export const openingHoursRepository = new OpeningHoursRepository();
