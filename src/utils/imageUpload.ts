import sharp from "sharp";
import { v2 as cloudinary } from "cloudinary";

// Configura Cloudinary dai env vars
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ACCEPTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

/**
 * Ottimizza e carica un'immagine su Cloudinary
 * @param bufferFile - Buffer del file immagine
 * @param filename - Nome del file (usato per generare il public_id)
 * @param folder - Cartella Cloudinary (default: "fidelty/bars")
 * @returns URL sicura dell'immagine su Cloudinary
 */
export async function saveAndOptimizeImage(
  bufferFile: Buffer,
  filename: string,
  folder: string = "fidelty/bars"
): Promise<string> {
  try {
    // Ottimizza con sharp prima di caricare
    const optimizedBuffer = await sharp(bufferFile)
      .resize(1200, 675, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ quality: 80 })
      .toBuffer();

    // Upload su Cloudinary
    const result = await new Promise<{ secure_url: string }>((resolve, reject) => {
      const timestamp = Date.now();
      const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: `${timestamp}-${safeName}`,
          resource_type: "image",
          overwrite: false,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result as { secure_url: string });
        }
      );
      uploadStream.end(optimizedBuffer);
    });

    console.log(`✅ Immagine caricata su Cloudinary: ${result.secure_url}`);
    return result.secure_url;
  } catch (error) {
    console.error("❌ Errore nel caricamento dell'immagine su Cloudinary:", error);
    throw new Error("Impossibile caricare l'immagine");
  }
}

/**
 * Carica un documento (immagine o PDF) su Cloudinary senza ottimizzazione sharp
 */
export async function uploadDocument(
  bufferFile: Buffer,
  filename: string,
  mimeType: string,
  folder: string = "fidelty/business_docs"
): Promise<{ secure_url: string; public_id: string }> {
  try {
    const resourceType = mimeType === "application/pdf" ? "raw" as const : "image" as const;

    const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
      const timestamp = Date.now();
      const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: `${timestamp}-${safeName}`,
          resource_type: resourceType,
          overwrite: false,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result as { secure_url: string; public_id: string });
        }
      );
      uploadStream.end(bufferFile);
    });

    console.log(`✅ Documento caricato su Cloudinary: ${result.secure_url}`);
    return result;
  } catch (error) {
    console.error("❌ Errore nel caricamento del documento su Cloudinary:", error);
    throw new Error("Impossibile caricare il documento");
  }
}

const ACCEPTED_DOC_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/pdf",
]);

/**
 * Valida il tipo MIME per documenti (immagini + PDF)
 */
export function isDocumentFile(mimeType: string | undefined): boolean {
  return !!mimeType && ACCEPTED_DOC_MIME_TYPES.has(mimeType);
}

/**
 * Valida il tipo MIME del file (accetta PNG, JPEG, WebP)
 */
export function isImageFile(mimeType: string | undefined): boolean {
  return !!mimeType && ACCEPTED_MIME_TYPES.has(mimeType);
}

/** @deprecated Usa isImageFile */
export function isPngFile(mimeType: string | undefined): boolean {
  return isImageFile(mimeType);
}

/**
 * Valida la dimensione del file
 * @param fileSize - Dimensione in byte
 * @param maxSizeMB - Dimensione massima in MB
 * @returns true se valido, false altrimenti
 */
export function isFileSizeValid(fileSize: number, maxSizeMB: number = 5): boolean {
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  return fileSize <= maxSizeBytes;
}
