import type { FastifyReply, FastifyRequest } from "fastify";
import { emailService } from "../services/emailService.js";
import { barTeamService } from "../services/barTeamService.js";
import { barTeamNotificationService } from "../services/barTeamNotificationService.js";

function sendServiceError(reply: FastifyReply, result: { status: number; code: string }) {
  const messages: Record<string, string> = {
    STAFF_MANAGEMENT_FORBIDDEN: "Non hai i permessi per gestire il team.",
    INVALID_EMAIL: "Inserisci un indirizzo email valido.",
    ROLE_ASSIGNMENT_FORBIDDEN: "Non puoi assegnare questo ruolo.",
    TEAM_MEMBER_EXISTS: "L'utente è già membro o ha un invito in attesa.",
    BAR_NOT_FOUND: "Attività non trovata.",
    INVITATION_NOT_FOUND: "Invito non trovato o già utilizzato.",
    INVITATION_EXPIRED: "L'invito è scaduto.",
    INVITATION_EMAIL_MISMATCH: "Accedi con l'indirizzo email a cui è stato inviato l'invito.",
    TEAM_MEMBER_NOT_FOUND: "Membro del team non trovato.",
    MANAGER_PROTECTED: "Il Manager dell'attività non può essere modificato o rimosso.",
    SELF_ROLE_CHANGE_FORBIDDEN: "Non puoi modificare il tuo ruolo. Puoi lasciare il team.",
    CO_MANAGER_PROTECTED: "Solo il Manager può gestire un Co-Manager.",
    MANAGER_CANNOT_LEAVE_OR_NOT_MEMBER: "Il Manager non può lasciare l'attività.",
  };
  return reply.status(result.status).send({
    success: false,
    error: messages[result.code] ?? "Operazione sul team non riuscita.",
    code: result.code,
  });
}

export class BarTeamController {
  async getAccess(request: FastifyRequest, reply: FastifyReply) {
    const userId = request.userId;
    if (!userId) return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });

    const rawBarId = request.headers["x-bar-id"];
    const selectedBarId = Array.isArray(rawBarId) ? rawBarId[0] : rawBarId;
    const bars = await barTeamService.listAccessibleBars(userId);
    if (bars.length === 0) {
      return reply.status(404).send({ success: false, error: "Nessuna attività associata all'utente", code: "BAR_NOT_FOUND" });
    }
    if (!selectedBarId && bars.length > 1) {
      return reply.status(200).send({
        success: true,
        data: { bars: bars.map(({ id, name }) => ({ id, name })), requiresSelection: true },
      });
    }
    const access = await barTeamService.getAccess(userId, String(selectedBarId ?? bars[0].id));
    if (!access) return reply.status(404).send({ success: false, error: "Attività non trovata", code: "BAR_NOT_FOUND" });
    return reply.status(200).send({ success: true, data: { ...access, bars: bars.map(({ id, name }) => ({ id, name })) } });
  }

  async getTeam(request: FastifyRequest, reply: FastifyReply) {
    if (!request.selectedBarId) {
      return reply.status(400).send({ success: false, error: "Seleziona un'attività", code: "BAR_ID_REQUIRED" });
    }
    const members = await barTeamService.listTeam(request.selectedBarId, request.userId!);
    return reply.status(200).send({ success: true, data: members });
  }

  async getReceivedInvitations(request: FastifyRequest, reply: FastifyReply) {
    if (!request.userEmail) {
      return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
    }
    const invitations = await barTeamService.listReceivedInvitations(request.userEmail);
    return reply.status(200).send({ success: true, data: invitations });
  }

  async invite(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as { email?: unknown; role?: unknown } | undefined;
    if (typeof body?.email !== "string" || !["co_manager", "waiter"].includes(String(body.role))) {
      return reply.status(400).send({ success: false, error: "Email e ruolo validi sono obbligatori.", code: "VALIDATION_ERROR" });
    }
    const userId = request.userId!;
    const result = await barTeamService.createInvitation({
      barId: request.selectedBarId!,
      actorUserId: userId,
      actorRole: request.barRole!,
      email: body.email,
      role: body.role as "co_manager" | "waiter",
    });
    if (result.status !== 201) return sendServiceError(reply, result);

    let delivery: Awaited<ReturnType<typeof emailService.sendPlainTextEmail>>;
    try {
      delivery = await emailService.sendPlainTextEmail({
        recipientEmail: result.email,
        subject: `Invito a gestire ${result.invitation.barName} su Fidelty`,
        text: `Sei stato invitato a collaborare con ${result.invitation.barName} su Fidelty.\n\nAccedi o crea un account con questo indirizzo email e accetta l'invito dalla sezione Team dell'app o della dashboard entro 7 giorni.`,
      });
    } catch {
      await barTeamService.updateMember({
        barId: request.selectedBarId!,
        memberId: result.invitation.id,
        actorUserId: userId,
        actorRole: request.barRole!,
        remove: true,
      });
      return reply.status(502).send({
        success: false,
        error: "Non è stato possibile inviare l'invito via email. L'invito è stato annullato.",
        code: "INVITATION_EMAIL_SEND_FAILED",
      });
    }
    await barTeamNotificationService.notifyInvite({
      recipientEmail: result.email,
      invitationId: result.invitation.id,
      barId: request.selectedBarId!,
      barName: result.invitation.barName,
      inviterName: result.invitation.inviterName,
    });
    return reply.status(201).send({
      success: true,
      data: { id: result.invitation.id, emailSent: delivery.sent },
      message: delivery.sent
        ? "Invito inviato."
        : "Invito creato, ma l'email non è stata inviata. Verifica la configurazione email.",
    });
  }

  async acceptInvitation(request: FastifyRequest, reply: FastifyReply) {
    const { invitationId } = request.params as { invitationId: string };
    if (!request.userId || !request.userEmail) {
      return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
    }
    const result = await barTeamService.acceptInvitation(invitationId, request.userId, request.userEmail);
    if (result.status !== 200) return sendServiceError(reply, result);
    return reply.status(200).send({ success: true, message: "Invito accettato." });
  }

  async updateMember(request: FastifyRequest, reply: FastifyReply) {
    const { memberId } = request.params as { memberId: string };
    const body = request.body as { role?: unknown } | undefined;
    if (body?.role !== "co_manager" && body?.role !== "waiter") {
      return reply.status(400).send({ success: false, error: "Ruolo non valido.", code: "INVALID_ROLE" });
    }
    const result = await barTeamService.updateMember({
      barId: request.selectedBarId!,
      memberId,
      actorUserId: request.userId!,
      actorRole: request.barRole!,
      role: body?.role as "co_manager" | "waiter" | undefined,
    });
    if (result.status !== 200) return sendServiceError(reply, result);
    return reply.status(200).send({ success: true, message: "Ruolo aggiornato." });
  }

  async removeMember(request: FastifyRequest, reply: FastifyReply) {
    const { memberId } = request.params as { memberId: string };
    const result = await barTeamService.updateMember({
      barId: request.selectedBarId!,
      memberId,
      actorUserId: request.userId!,
      actorRole: request.barRole!,
      remove: true,
    });
    if (result.status !== 200) return sendServiceError(reply, result);
    return reply.status(200).send({ success: true, message: "Accesso rimosso." });
  }

  async leaveTeam(request: FastifyRequest, reply: FastifyReply) {
    if (!request.userId || !request.selectedBarId) {
      return reply.status(400).send({ success: false, error: "Seleziona un'attività.", code: "BAR_ID_REQUIRED" });
    }
    const result = await barTeamService.leaveTeam(request.selectedBarId, request.userId);
    if (result.status !== 200) return sendServiceError(reply, result);
    return reply.status(200).send({ success: true, message: "Hai lasciato il team." });
  }
}

export const barTeamController = new BarTeamController();
