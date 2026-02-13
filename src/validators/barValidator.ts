import { z } from "zod";

// Schema di validazione per la registrazione del bar
export const barRegistrationSchema = z.object({
  iva: z
    .string()
    .min(11, "IVA deve avere almeno 11 caratteri")
    .max(20, "IVA non può superare 20 caratteri")
    .trim(),
  merchantName: z
    .string()
    .min(2, "Nome commerciale deve avere almeno 2 caratteri")
    .max(255, "Nome commerciale non può superare 255 caratteri")
    .trim(),
  name: z
    .string()
    .min(2, "Nome del locale deve avere almeno 2 caratteri")
    .max(255, "Nome del locale non può superare 255 caratteri")
    .trim(),
  address: z
    .string()
    .min(5, "Indirizzo deve avere almeno 5 caratteri")
    .max(500, "Indirizzo non può superare 500 caratteri")
    .trim(),
  image: z
    .string()
    .url("Image deve essere un URL valido")
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
