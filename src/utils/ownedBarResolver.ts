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