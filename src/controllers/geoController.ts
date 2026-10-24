import type { FastifyReply, FastifyRequest } from "fastify";

const PLACES_BASE = "https://maps.googleapis.com/maps/api";

function getApiKey(): string | null {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_GEOCODE_API_KEY || null;
}

function cleanSessionToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : undefined;
}

export class GeoController {
  async autocomplete(request: FastifyRequest, reply: FastifyReply) {
    const apiKey = getApiKey();
    const { input, sessionToken } = request.query as { input?: string; sessionToken?: string };
    const query = (input || "").trim();

    if (!apiKey) {
      return reply.status(503).send({ success: false, error: "Servizio indirizzi non disponibile", code: "GEO_UNAVAILABLE" });
    }
    if (query.length < 3 || query.length > 200) {
      return reply.send({ success: true, data: [] });
    }

    const params = new URLSearchParams({
      input: query,
      types: "address",
      components: "country:it",
      language: "it",
      key: apiKey,
    });
    const token = cleanSessionToken(sessionToken);
    if (token) params.set("sessiontoken", token);

    try {
      const response = await fetch(`${PLACES_BASE}/place/autocomplete/json?${params.toString()}`);
      const payload = (await response.json()) as any;
      if (payload.status !== "OK" && payload.status !== "ZERO_RESULTS") {
        console.warn("⚠️ Places autocomplete:", payload.status);
        return reply.status(502).send({ success: false, error: "Errore servizio indirizzi", code: "GEO_ERROR" });
      }

      return reply.send({
        success: true,
        data: (payload.predictions || []).map((p: any) => ({
          placeId: p.place_id,
          description: p.description,
          mainText: p.structured_formatting?.main_text || p.description,
          secondaryText: p.structured_formatting?.secondary_text || "",
        })),
      });
    } catch (error) {
      console.error("❌ Errore autocomplete indirizzi:", error);
      return reply.status(502).send({ success: false, error: "Errore servizio indirizzi", code: "GEO_ERROR" });
    }
  }

  async placeDetails(request: FastifyRequest, reply: FastifyReply) {
    const apiKey = getApiKey();
    const { placeId, sessionToken } = request.query as { placeId?: string; sessionToken?: string };

    if (!apiKey) {
      return reply.status(503).send({ success: false, error: "Servizio indirizzi non disponibile", code: "GEO_UNAVAILABLE" });
    }
    if (!placeId || !/^[A-Za-z0-9_-]{10,300}$/.test(placeId)) {
      return reply.status(400).send({ success: false, error: "placeId non valido", code: "VALIDATION_ERROR" });
    }

    const params = new URLSearchParams({
      place_id: placeId,
      fields: "formatted_address,geometry/location",
      language: "it",
      key: apiKey,
    });
    const token = cleanSessionToken(sessionToken);
    if (token) params.set("sessiontoken", token);

    try {
      const response = await fetch(`${PLACES_BASE}/place/details/json?${params.toString()}`);
      const payload = (await response.json()) as any;
      if (payload.status !== "OK" || !payload.result) {
        return reply.status(404).send({ success: false, error: "Indirizzo non trovato", code: "GEO_NOT_FOUND" });
      }

      return reply.send({
        success: true,
        data: {
          placeId,
          address: payload.result.formatted_address,
          latitude: Number(payload.result.geometry?.location?.lat ?? NaN),
          longitude: Number(payload.result.geometry?.location?.lng ?? NaN),
        },
      });
    } catch (error) {
      console.error("❌ Errore dettagli indirizzo:", error);
      return reply.status(502).send({ success: false, error: "Errore servizio indirizzi", code: "GEO_ERROR" });
    }
  }

  async geocode(request: FastifyRequest, reply: FastifyReply) {
    const apiKey = getApiKey();
    const { address } = request.query as { address?: string };
    const query = (address || "").trim();

    if (!apiKey) {
      return reply.status(503).send({ success: false, error: "Servizio indirizzi non disponibile", code: "GEO_UNAVAILABLE" });
    }
    if (query.length < 3 || query.length > 300) {
      return reply.status(400).send({ success: false, error: "Indirizzo non valido", code: "VALIDATION_ERROR" });
    }

    try {
      const params = new URLSearchParams({ address: query, key: apiKey });
      const response = await fetch(`${PLACES_BASE}/geocode/json?${params.toString()}`);
      const payload = (await response.json()) as any;
      const location = payload.results?.[0]?.geometry?.location;
      if (payload.status !== "OK" || !location) {
        return reply.status(404).send({ success: false, error: "Indirizzo non trovato", code: "GEO_NOT_FOUND" });
      }

      return reply.send({
        success: true,
        data: { latitude: Number(location.lat), longitude: Number(location.lng) },
      });
    } catch (error) {
      console.error("❌ Errore geocoding:", error);
      return reply.status(502).send({ success: false, error: "Errore servizio indirizzi", code: "GEO_ERROR" });
    }
  }
}

export const geoController = new GeoController();
