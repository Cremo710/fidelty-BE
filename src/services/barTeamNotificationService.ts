import { databaseService } from "./databaseService.js";
import { pruneUnregisteredTokens, type ExpoPushTicket } from "../utils/expoPush.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_MESSAGE_LIMIT = 100;

class BarTeamNotificationService {
  async notifyInvite(input: {
    recipientEmail: string;
    invitationId: string;
    barId: string;
    barName: string;
    inviterName: string;
  }): Promise<void> {
    try {
      const result = await databaseService.getPool().query<{ token: string }>(
        `SELECT DISTINCT dpt.token
         FROM utenti u
         JOIN device_push_tokens dpt ON dpt.user_id = u.id
         WHERE lower(u.email) = lower($1)`,
        [input.recipientEmail],
      );
      const tokens = result.rows.map(({ token }) => token);
      if (tokens.length === 0) return;

      const messages = tokens.map((token) => ({
        to: token,
        title: `${input.inviterName} ti ha invitato nel team`,
        body: `Invito a collaborare con ${input.barName}`,
        data: {
          type: "bar_team_invitation",
          invitationId: input.invitationId,
          barId: input.barId,
        },
        sound: "default",
      }));

      for (let offset = 0; offset < messages.length; offset += EXPO_MESSAGE_LIMIT) {
        const batch = messages.slice(offset, offset + EXPO_MESSAGE_LIMIT);
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
          console.warn(`Expo Push invito team non-OK: ${response.status}`);
          continue;
        }

        const payload = await response.json() as { data?: ExpoPushTicket[] };
        await pruneUnregisteredTokens(batch.map(({ to }) => to), payload.data || []);
        (payload.data || []).forEach((ticket) => {
          if (ticket.status !== "ok") {
            console.warn("Expo Push invito team rifiutata:", ticket.message || "errore sconosciuto");
          }
        });
      }

      console.log(`🔔 Push invito team inviata a ${tokens.length} dispositivo/i`);
    } catch (error) {
      console.warn("Notifica push invito team non inviata:", error instanceof Error ? error.message : error);
    }
  }
}

export const barTeamNotificationService = new BarTeamNotificationService();
