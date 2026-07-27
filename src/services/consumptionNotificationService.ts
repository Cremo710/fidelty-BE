import { databaseService } from "./databaseService.js";
import { emailService } from "./emailService.js";
import { userRepository } from "../repositories/userRepository.js";

export type NotificationChannel = "expo-push" | "email" | "none";

export interface NotifyBarResult {
  delivered: boolean;
  channel: NotificationChannel;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

class ConsumptionNotificationService {
  async notifyBarOfNewRequest(input: {
    barId: string;
    barName: string;
    barOwnerUserId: string;
    requesterName: string;
    amount: number;
    pointsPreview: number;
    requestId: string;
  }): Promise<NotifyBarResult> {
    try {
      // 1. Tenta invio via Expo Push
      const pushResult = await this.trySendExpoPush(input);
      if (pushResult.delivered) return pushResult;

      // 2. Fallback email: recupera l'email del titolare
      const owner = await userRepository.findById(input.barOwnerUserId);
      if (owner?.email) {
        return await this.trySendFallbackEmail({ ...input, recipientEmail: owner.email, recipientName: owner.name });
      }

      return { delivered: false, channel: "none" };
    } catch {
      // La notifica non deve mai bloccare la richiesta
      return { delivered: false, channel: "none" };
    }
  }

  private async trySendExpoPush(input: {
    barOwnerUserId: string;
    barName: string;
    requesterName: string;
    amount: number;
    pointsPreview: number;
    requestId: string;
    barId: string;
  }): Promise<NotifyBarResult> {
    try {
      const pool = databaseService.getPool();
      const tokenResult = await pool.query<{ token: string }>(
        "SELECT token FROM device_push_tokens WHERE user_id = $1",
        [input.barOwnerUserId],
      );

      if (tokenResult.rows.length === 0) {
        return { delivered: false, channel: "none" };
      }

      const messages = tokenResult.rows.map((row) => ({
        to: row.token,
        title: `Nuova richiesta — ${input.barName}`,
        body: `${input.requesterName} · € ${input.amount.toFixed(2)} · ${input.pointsPreview} pt`,
        data: {
          requestId: input.requestId,
          barId: input.barId,
          type: "new_consumption_request",
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
        console.warn(`⚠️ Expo Push non-OK: ${response.status}`);
        return { delivered: false, channel: "none" };
      }

      const json = (await response.json()) as { data?: Array<{ status: string }> };
      const allOk = json.data?.every((r) => r.status === "ok") ?? false;

      console.log(`🔔 Expo Push inviato a ${tokenResult.rows.length} device(s) per richiesta ${input.requestId}`);
      return { delivered: allOk, channel: "expo-push" };
    } catch (err) {
      console.warn("⚠️ Expo Push fallito:", (err as Error).message);
      return { delivered: false, channel: "none" };
    }
  }

  private async trySendFallbackEmail(input: {
    recipientEmail: string;
    recipientName?: string | null;
    barName: string;
    requesterName: string;
    amount: number;
    pointsPreview: number;
    requestId: string;
  }): Promise<NotifyBarResult> {
    try {
      const result = await emailService.sendNewConsumptionRequestEmail(input);
      return { delivered: result.sent, channel: "email" };
    } catch (err) {
      console.warn("⚠️ Email notifica consumazione fallita:", (err as Error).message);
      return { delivered: false, channel: "none" };
    }
  }
}

export const consumptionNotificationService = new ConsumptionNotificationService();
