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
  const result = await uploadOptimizedImage(bufferFile, filename, folder);
  return result.secure_url;
}

/**
 * Ottimizza e carica un'immagine su Cloudinary ritornando anche il public_id
 */
export async function uploadOptimizedImage(
  bufferFile: Buffer,
  filename: string,
  folder: string = "fidelty/bars",
  deliveryType: "upload" | "authenticated" = "upload"
): Promise<{ secure_url: string; public_id: string }> {
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
    const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
      const timestamp = Date.now();
      const safeName = filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: `${timestamp}-${safeName}`,
          resource_type: "image",
          type: deliveryType,
          overwrite: false,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result as { secure_url: string; public_id: string });
        }
      );
      uploadStream.end(optimizedBuffer);
    });

    console.log(`✅ Immagine caricata su Cloudinary: ${result.secure_url}`);
    return result;
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
          type: "authenticated",
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

/**
 * Estrae il public_id Cloudinary da una secure_url standard.
 * Esempio:
 * https://res.cloudinary.com/<cloud>/image/upload/v123/folder/file.jpg -> folder/file
 */
export function extractCloudinaryPublicIdFromUrl(imageUrl: string): string | null {
  return parseCloudinaryUrl(imageUrl)?.publicId ?? null;
}

interface ParsedCloudinaryUrl {
  resourceType: "image" | "raw";
  deliveryType: string;
  publicId: string;
  format: string | null;
}

function parseCloudinaryUrl(imageUrl: string): ParsedCloudinaryUrl | null {
  if (!imageUrl || typeof imageUrl !== "string") return null;

  try {
    const { pathname } = new URL(imageUrl);
    const match = pathname.match(/\/(image|raw)\/(upload|authenticated)\/(.+)$/);
    if (!match) return null;

    const assetPath = match[3]
      .replace(/^s--[^/]+--\//, "")
      .replace(/^v\d+\//, "")
      .replace(/^\/+/, "");
    if (!assetPath) return null;

    const resourceType = match[1] as "image" | "raw";
    const extMatch = assetPath.match(/\.([a-zA-Z0-9]+)$/);
    return {
      resourceType,
      deliveryType: match[2],
      publicId: resourceType === "image" ? assetPath.replace(/\.[a-zA-Z0-9]+$/, "") : assetPath,
      format: extMatch ? extMatch[1] : null,
    };
  } catch {
    return null;
  }
}

/**
 * Converte l'URL di una risorsa Cloudinary privata ("authenticated") in un URL di
 * download firmato a scadenza. Le risorse pubbliche (legacy) vengono restituite invariate.
 */
export function getSignedCloudinaryUrl(storedUrl: string | null | undefined, ttlSeconds = 300): string | null {
  if (!storedUrl) return null;
  const parsed = parseCloudinaryUrl(storedUrl);
  if (!parsed || parsed.deliveryType !== "authenticated") return storedUrl;

  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const publicId = parsed.resourceType === "raw" && parsed.format
    ? parsed.publicId.replace(/\.[a-zA-Z0-9]+$/, "")
    : parsed.publicId;

  return cloudinary.utils.private_download_url(publicId, parsed.format ?? "", {
    resource_type: parsed.resourceType,
    type: "authenticated",
    expires_at: expiresAt,
  });
}

/**
 * Cancella una risorsa Cloudinary a partire da image URL.
 */
export async function deleteCloudinaryImageByUrl(imageUrl: string): Promise<boolean> {
  const parsed = parseCloudinaryUrl(imageUrl);
  if (!parsed) return false;

  try {
    const result = await cloudinary.uploader.destroy(parsed.publicId, {
      resource_type: parsed.resourceType,
      type: parsed.deliveryType,
    });
    const status = (result as { result?: string })?.result;
    return status === "ok" || status === "not found";
  } catch (error) {
    console.warn("⚠️ Errore cancellazione immagine Cloudinary:", parsed.publicId, error);
    return false;
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
