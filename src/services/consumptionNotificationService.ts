export class ConsumptionNotificationService {
  async notifyBarOfNewRequest(input: {
    barId: string;
    barName: string;
    requesterName: string;
    amount: number;
    pointsPreview: number;
    requestId: string;
  }): Promise<{ delivered: boolean; channel: string }> {
    console.log(
      "🔔 Nuova richiesta consumazione pronta per notifica push:",
      JSON.stringify(input)
    );

    // Hook pronto per una futura integrazione con Expo Push / FCM / APNs.
    return {
      delivered: false,
      channel: "push-not-configured",
    };
  }
}

export const consumptionNotificationService = new ConsumptionNotificationService();