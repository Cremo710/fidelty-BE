import type { FastifyReply, FastifyRequest } from "fastify";
import { barTeamService } from "../services/barTeamService.js";
import { hasBarPermission, type BarPermission } from "./barPermissions.js";

declare module "fastify" {
  interface FastifyRequest {
    selectedBarId?: string;
    barRole?: import("./barPermissions.js").BarTeamRole;
  }
}

export function requireBarPermission(permission: BarPermission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) {
      return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
    }
    const rawBarId = request.headers["x-bar-id"];
    const headerBarId = Array.isArray(rawBarId) ? rawBarId[0] : rawBarId;
    const params = request.params as { barId?: string } | undefined;
    const requestedBarId = params?.barId ?? headerBarId;
    if (params?.barId && headerBarId && params.barId !== headerBarId) {
      return reply.status(403).send({ success: false, error: "Attività non autorizzata", code: "BAR_PERMISSION_DENIED" });
    }
    const bars = requestedBarId ? undefined : await barTeamService.listAccessibleBars(userId);
    if (!requestedBarId && bars && bars.length !== 1) {
      return reply.status(bars.length ? 400 : 404).send({
        success: false,
        error: bars.length ? "Seleziona un'attività" : "Attività non trovata",
        code: bars.length ? "BAR_ID_REQUIRED" : "BAR_NOT_FOUND",
      });
    }
    const access = await barTeamService.getAccess(userId, String(requestedBarId ?? bars?.[0]?.id));
    if (!access) {
      return reply.status(404).send({ success: false, error: "Attività non trovata", code: "BAR_NOT_FOUND" });
    }
    if (!hasBarPermission(access.role, permission)) {
      return reply.status(403).send({ success: false, error: "Non hai i permessi per questa operazione", code: "BAR_PERMISSION_DENIED" });
    }
    request.selectedBarId = access.barId;
    request.barRole = access.role;
  };
}
