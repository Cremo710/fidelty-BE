export type SocialPlatform = "instagram" | "facebook" | "tiktok";

const PROFILE_URL: Record<SocialPlatform, (handle: string) => string> = {
  instagram: (handle) => `https://instagram.com/${handle}`,
  facebook: (handle) => `https://facebook.com/${handle}`,
  tiktok: (handle) => `https://www.tiktok.com/@${handle}`,
};

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// Nome utente dei social: lettere, cifre, punto, trattino, underscore
const HANDLE = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Rende un link inserito a mano accettabile come URL, senza cambiare quelli già completi:
 * - "www.miobar.it" → "https://www.miobar.it"
 * - per i social, "@miobar" (o "miobar", senza punti) → link al profilo
 * - stringa vuota → null
 * Non valida: il risultato passa comunque dal controllo http(s):// dello schema.
 */
export function normalizeLink(value: unknown, platform?: SocialPlatform): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (HAS_SCHEME.test(trimmed)) return trimmed;

  if (platform) {
    // "@nome" è sempre un nome utente; "nome" senza punti anche (un dominio ha sempre un punto)
    const isAtHandle = trimmed.startsWith("@");
    const handle = isAtHandle ? trimmed.slice(1) : trimmed;
    if (HANDLE.test(handle) && (isAtHandle || !handle.includes("."))) {
      return PROFILE_URL[platform](handle);
    }
  }

  return `https://${trimmed.replace(/^\/+/, "")}`;
}
