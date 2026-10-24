import type { FastifyReply, FastifyRequest } from "fastify";

export function isAdmin(userId?: string): boolean {
  const ids = (process.env.ADMIN_USER_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return !!userId && ids.includes(userId);
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!isAdmin(request.userId)) {
    return reply.status(403).send({ success: false, error: "Accesso negato", code: "FORBIDDEN" });
  }
}
