import { databaseService } from "./databaseService.js";
import { pruneUnregisteredTokens, type ExpoPushTicket } from "../utils/expoPush.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_MESSAGE_LIMIT = 100;

class OfferNotificationService {
  async notifyCustomersOfNewOffer(input: {
    barId: string;
    barOwnerUserId: string;
    barName: string;
    offerId: string;
    offerTitle: string;
  }): Promise<void> {
    try {
      const result = await databaseService.getPool().query<{ token: string }>(
        `SELECT DISTINCT dpt.token
         FROM consumption_requests cr
         JOIN device_push_tokens dpt ON dpt.user_id = cr.requester_user_id
         WHERE cr.bar_id = $1
           AND cr.requester_user_id <> $2
           AND cr.status IN ('credited', 'approved')`,
        [input.barId, input.barOwnerUserId],
      );

      const tokens = result.rows.map(({ token }) => token);
      if (tokens.length === 0) return;

      const messages = tokens.map((token) => ({
        to: token,
        title: `Nuova offerta da ${input.barName}`,
        body: input.offerTitle,
        data: {
          type: "new_bar_offer",
          offerId: input.offerId,
          barId: input.barId,
        },
        sound: "default",
      }));

      for (let offset = 0; offset < messages.length; offset += EXPO_MESSAGE_LIMIT) {
        const batch = messages.slice(offset, offset + EXPO_MESSAGE_LIMIT);
        try {
          const response = await fetch(EXPO_PUSH_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(batch),
            signal: AbortSignal.timeout(8_000),
          });

          if (!response.ok) {
            console.warn(`Expo Push nuova offerta non-OK: ${response.status}`);
            continue;
          }

          const payload = await response.json() as { data?: ExpoPushTicket[] };
          await pruneUnregisteredTokens(batch.map((m) => m.to), payload.data || []);
          (payload.data || []).forEach((ticket) => {
            if (ticket.status !== "ok") {
              console.warn("Expo Push nuova offerta rifiutata:", ticket.message || "errore sconosciuto");
            }
          });
        } catch (error) {
          console.warn("Expo Push nuova offerta fallita:", error instanceof Error ? error.message : error);
        }
      }

      console.log(`🔔 Push nuova offerta inviata a ${tokens.length} dispositivo/i`);
    } catch (error) {
      console.warn("Notifica nuova offerta non inviata:", error instanceof Error ? error.message : error);
    }
  }
}

export const offerNotificationService = new OfferNotificationService();