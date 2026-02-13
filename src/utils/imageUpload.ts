import sharp from "sharp";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Salva e ottimizza un'immagine PNG
 * @param bufferFile - Buffer del file immagine
 * @param filename - Nome del file
 * @returns URL dell'immagine salvata
 */
export async function saveAndOptimizeImage(
  bufferFile: Buffer,
  filename: string
): Promise<string> {
  try {
    // In produzione usare cloud storage (S3, Cloudinary, Firebase, ecc)
    // Per development usare filesystem locale

    const uploadDir = path.join(__dirname, "../../uploads/bars");

    // Crea directory se non esiste
    try {
      await fs.mkdir(uploadDir, { recursive: true });
    } catch (err) {
      console.warn("Cartella upload già esiste");
    }

    // Ottimizzare immagine con sharp
    const optimizedBuffer = await sharp(bufferFile)
      .resize(1200, 675, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ quality: 80 })
      .toBuffer();

    // Generare nome file univoco
    const timestamp = Date.now();
    const uniqueFilename = `${timestamp}-${filename}`;
    const filepath = path.join(uploadDir, uniqueFilename);

    // Salvare file
    await fs.writeFile(filepath, optimizedBuffer);

    console.log(`✅ Immagine salvata: ${uniqueFilename}`);

    // Ritornare URL accessibile
    // In development: /uploads/bars/filename
    // In production: URL cloud storage (S3, ecc)
    const imageUrl = `/uploads/bars/${uniqueFilename}`;

    return imageUrl;
  } catch (error) {
    console.error("❌ Errore nel salvataggio dell'immagine:", error);
    throw new Error("Impossibile salvare l'immagine");
  }
}

/**
 * Valida il tipo MIME del file
 * @param mimeType - MIME type del file
 * @returns true se PNG, false altrimenti
 */
export function isPngFile(mimeType: string | undefined): boolean {
  return mimeType === "image/png";
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
