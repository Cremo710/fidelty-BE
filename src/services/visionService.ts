import vision from "@google-cloud/vision";

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS || "{}");

const client = new vision.ImageAnnotatorClient({
  credentials,
});

/**
 * Estrae il testo da un'immagine usando Google Cloud Vision OCR.
 * @param imageBuffer - Buffer dell'immagine
 * @returns Il testo estratto dall'immagine
 */
export async function extractTextFromImage(
  imageBuffer: Buffer
): Promise<string> {
  const [result] = await client.textDetection({
    image: { content: imageBuffer.toString("base64") },
  });

  const fullText =
    result.fullTextAnnotation?.text ??
    result.textAnnotations?.[0]?.description ??
    "";

  return fullText;
}
