import { z } from "zod";

// Schema di validazione per la registrazione del bar
export const barRegistrationSchema = z.object({
  piva: z
    .string()
    .regex(/^\d{11}$/, "Partita IVA deve contenere esattamente 11 cifre numeriche")
    .trim(),
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
  coverImageUrl: z
    .string()
    .url("URL immagine non valido")
    .optional()
    .nullable(),
});

// Type derivato dallo schema
export type BarRegistrationInput = z.infer<typeof barRegistrationSchema>;

// Funzione helper per validare
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
