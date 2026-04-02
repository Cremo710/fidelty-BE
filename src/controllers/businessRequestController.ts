import { FastifyRequest, FastifyReply } from "fastify";
import { businessRequestRepository } from "../repositories/businessRequestRepository.js";
import { barRepository } from "../repositories/barRepository.js";
import { uploadDocument, isDocumentFile, isFileSizeValid } from "../utils/imageUpload.js";

export class BusinessRequestController {
  /**
   * POST /api/business-requests
   * Crea una nuova richiesta di registrazione bar
   */
  async create(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato" });
      }

      // Controlla se l'utente ha già un bar
      const existingBar = await barRepository.findByUserId(userId);
      if (existingBar) {
        return reply.status(400).send({
          success: false,
          error: "Hai già un bar registrato",
          code: "BAR_EXISTS",
        });
      }

      // Controlla se ha già una richiesta pending
      const hasPending = await businessRequestRepository.hasPendingRequest(userId);
      if (hasPending) {
        return reply.status(400).send({
          success: false,
          error: "Hai già una richiesta in attesa di approvazione",
          code: "REQUEST_PENDING",
        });
      }

      // Parse multipart form data
      const data: any = {};
      let docBuffer: Buffer | null = null;
      let docMimeType: string | null = null;
      let docFileName: string | null = null;

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === "field") {
          data[part.fieldname] = (part.value as string).trim();
        } else if (part.type === "file" && part.fieldname === "document") {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk as Buffer);
          }
          docBuffer = Buffer.concat(chunks);
          docMimeType = part.mimetype;
          docFileName = part.filename;
        }
      }

      // Validazione campi obbligatori
      if (!data.businessName || !data.barName || !data.address || !data.vatNumber) {
        return reply.status(400).send({
          success: false,
          error: "Ragione sociale, nome bar, indirizzo e P.IVA sono obbligatori",
        });
      }

      // Validazione P.IVA
      if (!/^\d{11}$/.test(data.vatNumber.replace(/\s/g, ""))) {
        return reply.status(400).send({
          success: false,
          error: "Partita IVA non valida (deve contenere 11 cifre)",
        });
      }

      // Upload documento se presente
      let documentUrl: string | null = null;
      let documentPublicId: string | null = null;

      if (docBuffer && docMimeType && docFileName) {
        if (!isDocumentFile(docMimeType)) {
          return reply.status(400).send({
            success: false,
            error: "Formato documento non supportato. Usa PNG, JPEG, WebP o PDF.",
          });
        }
        if (!isFileSizeValid(docBuffer.length, 10)) {
          return reply.status(400).send({
            success: false,
            error: "Il documento è troppo grande (max 10MB)",
          });
        }

        const uploadResult = await uploadDocument(docBuffer, docFileName, docMimeType);
        documentUrl = uploadResult.secure_url;
        documentPublicId = uploadResult.public_id;
      }

      const businessRequest = await businessRequestRepository.create({
        userId,
        businessName: data.businessName,
        barName: data.barName,
        address: data.address,
        vatNumber: data.vatNumber,
        contactEmail: data.contactEmail || null,
        phone: data.phone || null,
        documentUrl,
        documentPublicId,
      });

      return reply.status(201).send({
        success: true,
        data: businessRequest,
      });
    } catch (error: any) {
      console.error("❌ Errore creazione business request:", error);
      return reply.status(500).send({
        success: false,
        error: "Errore durante la creazione della richiesta",
      });
    }
  }

  /**
   * GET /api/business-requests/my
   * Recupera la richiesta dell'utente corrente
   */
  async getMyRequest(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato" });
      }

      const businessRequest = await businessRequestRepository.findByUserId(userId);

      return reply.send({
        success: true,
        data: businessRequest,
      });
    } catch (error: any) {
      console.error("❌ Errore recupero business request:", error);
      return reply.status(500).send({
        success: false,
        error: "Errore durante il recupero della richiesta",
      });
    }
  }

  /**
   * GET /api/business-requests
   * Lista tutte le richieste (admin)
   */
  async listAll(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato" });
      }

      const { status } = request.query as { status?: string };
      const requests = await businessRequestRepository.listAll(status);

      return reply.send({
        success: true,
        data: requests,
      });
    } catch (error: any) {
      console.error("❌ Errore lista business requests:", error);
      return reply.status(500).send({
        success: false,
        error: "Errore durante il recupero delle richieste",
      });
    }
  }

  /**
   * PATCH /api/business-requests/:id
   * Approva o rifiuta una richiesta (admin)
   */
  async updateStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato" });
      }

      const { id } = request.params as { id: string };
      const { status, rejectionReason } = request.body as {
        status: "approved" | "rejected";
        rejectionReason?: string;
      };

      if (!status || !["approved", "rejected"].includes(status)) {
        return reply.status(400).send({
          success: false,
          error: "Stato non valido. Usa 'approved' o 'rejected'.",
        });
      }

      if (status === "rejected" && !rejectionReason) {
        return reply.status(400).send({
          success: false,
          error: "Il motivo del rifiuto è obbligatorio",
        });
      }

      const existing = await businessRequestRepository.findById(id);
      if (!existing) {
        return reply.status(404).send({
          success: false,
          error: "Richiesta non trovata",
        });
      }

      if (existing.status !== "pending") {
        return reply.status(400).send({
          success: false,
          error: "Questa richiesta è già stata elaborata",
        });
      }

      const updated = await businessRequestRepository.updateStatus(id, status, rejectionReason);

      return reply.send({
        success: true,
        data: updated,
      });
    } catch (error: any) {
      console.error("❌ Errore aggiornamento status business request:", error);
      return reply.status(500).send({
        success: false,
        error: "Errore durante l'aggiornamento della richiesta",
      });
    }
  }
}

export const businessRequestController = new BusinessRequestController();
