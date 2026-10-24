import { databaseService } from "../services/databaseService.js";

export interface ExpoPushTicket {
  status: string;
  message?: string;
  details?: { error?: string };
}

/** Elimina i token che Expo segnala come DeviceNotRegistered (i ticket sono nello stesso ordine dei messaggi). */
export async function pruneUnregisteredTokens(tokens: string[], tickets: ExpoPushTicket[]): Promise<void> {
  const dead = tokens.filter((_, index) => tickets[index]?.details?.error === "DeviceNotRegistered");
  if (dead.length === 0) return;

  try {
    await databaseService.getPool().query(
      "DELETE FROM device_push_tokens WHERE token = ANY($1::text[])",
      [dead],
    );
    console.log(`🧹 Rimossi ${dead.length} push token non più registrati`);
  } catch (error) {
    console.warn("Pulizia push token fallita:", error instanceof Error ? error.message : error);
  }
}
