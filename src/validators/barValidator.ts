import { z } from "zod";
import { isValidItalianVat } from "../utils/vat.js";

// Stringa vuota -> null per i campi opzionali
const emptyToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

const optionalHttpUrl =  (max: number, label: string) =>
  z.preprocess(
    emptyToNull,
    z
      .string()
      .trim()
      .max(max, `${label} non può superare ${max} caratteri`)
      .regex(/^https?:\/\/\S+$/i, `${label} deve iniziare con http:// o https://`)
      .nullable()
      .optional(),
  );

const contactFields = {
  contactEmail: z.preprocess(
    emptyToNull,
    z
      .string()
      .trim()
      .max(255, "Email non può superare 255 caratteri")
      .email("Email di contatto non valida")
      .nullable()
      .optional(),
  ),
  phone: z.preprocess(
    emptyToNull,
    z
      .string()
      .trim()
      .regex(/^[\d\s\+\-\(\)]{6,20}$/, "Numero di telefono non valido")
      .nullable()
      .optional(),
  ),
  instagram: optionalHttpUrl(255, "Instagram"),
  facebook: optionalHttpUrl(255, "Facebook"),
  tiktok: optionalHttpUrl(255, "TikTok"),
  website: optionalHttpUrl(500, "Sito web"),
};

// Schema di validazione per la registrazione del bar
export const barRegistrationSchema = z.object({
  piva: z
    .string()
    .trim()
    .regex(/^\d{11}$/, "Partita IVA deve contenere esattamente 11 cifre numeriche")
    .refine(isValidItalianVat, "Partita IVA non valida (cifra di controllo errata)"),
  barName: z
    .string()
    .min(2, "Nome del bar deve avere almeno 2 caratteri")
    .max(255, "Nome del bar non può superare 255 caratteri")
    .trim(),
  businessName: z
    .string()
    .min(2, "Ragione sociale deve avere almeno 2 caratteri")
    .max(255, "Ragione sociale non può superare 255 caratteri")
    .trim(),
  address: z
    .string()
    .min(5, "Indirizzo deve avere almeno 5 caratteri")
    .max(500, "Indirizzo non può superare 500 caratteri")
    .trim(),
  ...contactFields,
  coverImageUrl: z
    .string()
    .url("URL immagine non valido")
    .optional()
    .nullable(),
});

// Schema per la configurazione della card del bar (Step 2)
export const cardConfigSchema = z.object({
  cardColor: z.preprocess(
    (value) => {
      if (value === "" || value === "null" || value === "undefined" || value === undefined) {
        return null;
      }
      return value;
    },
    z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, "Colore non valido (formato HEX richiesto)")
      .nullable()
  ).optional(),
  cardUseCover: z
    .boolean()
    .optional(),
});

// Type derivato dallo schema
export type BarRegistrationInput = z.infer<typeof barRegistrationSchema>;
export type CardConfigInput = z.infer<typeof cardConfigSchema>;

// Funzione helper per validare la registrazione
export function validateBarRegistrationInput(data: unknown) {
  try {
    return { success: true, data: barRegistrationSchema.parse(data) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        errors: error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      };
    }
    return { success: false, errors: [{ field: "unknown", message: String(error) }] };
  }
}

// Schema di validazione per l'aggiornamento del bar (campi modificabili)
export const barUpdateSchema = z.object({
  barName: z
    .string()
    .min(2, "Nome del bar deve avere almeno 2 caratteri")
    .max(255, "Nome del bar non può superare 255 caratteri")
    .trim()
    .optional(),
  address: z
    .string()
    .min(5, "Indirizzo deve avere almeno 5 caratteri")
    .max(500, "Indirizzo non può superare 500 caratteri")
    .trim()
    .optional(),
  ...contactFields,
});

export type BarUpdateInput = z.infer<typeof barUpdateSchema>;

// Funzione helper per validare l'aggiornamento del bar
export function validateBarUpdateInput(data: unknown) {
  try {
    return { success: true, data: barUpdateSchema.parse(data) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        errors: error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      };
    }
    return { success: false, errors: [{ field: "unknown", message: String(error) }] };
  }
}

// Funzione helper per validare la configurazione card
export function validateCardConfigInput(data: unknown) {
  try {
    return { success: true, data: cardConfigSchema.parse(data) };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        errors: error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      };
    }
    return { success: false, errors: [{ field: "unknown", message: String(error) }] };
  }
}
