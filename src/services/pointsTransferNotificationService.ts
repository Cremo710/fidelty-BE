import { databaseService } from "./databaseService.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

class PointsTransferNotificationService {
  async notifyRecipient(input: {
    recipientUserId: string;
    senderName: string;
    pointsAmount: number;
    transferId: string;
    barId: string;
  }): Promise<void> {
    try {
      const tokenResult = await databaseService.getPool().query<{ token: string }>(
        "SELECT token FROM device_push_tokens WHERE user_id = $1",
        [input.recipientUserId],
      );

      if (tokenResult.rows.length === 0) return;

      const messages = tokenResult.rows.map(({ token }) => ({
        to: token,
        title: "Hai ricevuto punti",
        body: `${input.senderName} ti ha inviato ${input.pointsAmount} punti.`,
        data: {
          type: "points_transfer",
          transferId: input.transferId,
          barId: input.barId,
          pointsAmount: input.pointsAmount,
        },
        sound: "default",
      }));

      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(8_000),
      });

      if (!response.ok) {
        console.warn(`Expo Push trasferimento non-OK: ${response.status}`);
        return;
      }

      const result = await response.json() as { data?: Array<{ status: string; message?: string }> };
      const tickets = result.data || [];
      tickets.forEach((ticket) => {
        if (ticket.status !== "ok") {
          console.warn("Expo Push trasferimento rifiutata:", ticket.message || "errore sconosciuto");
        }
      });
    } catch (error) {
      console.warn("Expo Push trasferimento fallita:", error instanceof Error ? error.message : error);
    }
  }
}

export const pointsTransferNotificationService = new PointsTransferNotificationService();