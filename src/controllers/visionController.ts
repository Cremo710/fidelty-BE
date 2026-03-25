import type { FastifyRequest, FastifyReply } from "fastify";
import { extractTextFromImage } from "../services/visionService.js";
import { isImageFile } from "../utils/imageUpload.js";

class VisionController {
  async extractText(request: FastifyRequest, reply: FastifyReply) {
    try {
      const data = await request.file();

      if (!data) {
        return reply.status(400).send({
          success: false,
          error: "Nessun file caricato",
          code: "MISSING_FILE",
        });
      }

      if (!isImageFile(data.mimetype)) {
        return reply.status(400).send({
          success: false,
          error: "Formato file non supportato. Usa PNG, JPEG o WebP.",
          code: "INVALID_FILE_TYPE",
        });
      }

      const buffer = await data.toBuffer();

      const text = await extractTextFromImage(buffer);

      return reply.status(200).send({
        success: true,
        text,
      });
    } catch (error) {
      console.error("❌ Errore nell'estrazione del testo:", error);
      return reply.status(500).send({
        success: false,
        error: "Errore nell'elaborazione dell'immagine",
        code: "VISION_ERROR",
      });
    }
  }
}

export const visionController = new VisionController();
