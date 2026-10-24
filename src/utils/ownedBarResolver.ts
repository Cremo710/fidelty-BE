import { FastifyRequest } from "fastify";
import { barRepository, type BarDTO } from "../repositories/barRepository.js";

export async function resolveOwnedBarForRequest(request: FastifyRequest): Promise<BarDTO | null> {
  const userId = (request as any).userId;
  if (!userId) {
    return null;
  }

  const rawBarId = request.headers["x-bar-id"];
  const barId = Array.isArray(rawBarId) ? rawBarId[0] : rawBarId;

  if (barId) {
    const selectedBar = await barRepository.findById(String(barId));
    if (!selectedBar || selectedBar.user_id !== userId) {
      return null;
    }

    return selectedBar;
  }

  return barRepository.findByUserId(userId);
}

/**
 * Per azioni distruttive: true se l'utente ha più bar e non ha indicato quale con X-Bar-Id.
 */
export async function isBarSelectionMissing(request: FastifyRequest): Promise<boolean> {
  const userId = (request as any).userId;
  if (!userId || request.headers["x-bar-id"]) {
    return false;
  }

  const ownedBars = await barRepository.findAllByUserId(userId);
  return ownedBars.length > 1;
}