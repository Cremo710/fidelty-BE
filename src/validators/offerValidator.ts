import { z } from "zod";

export const createOfferSchema = z.object({
  title: z
    .string()
    .min(2, "Titolo deve avere almeno 2 caratteri")
    .max(255, "Titolo non può superare 255 caratteri")
    .trim(),
  description: z
    .string()
    .max(1000, "Descrizione non può superare 1000 caratteri")
    .trim()
    .optional()
    .nullable(),
  conditions: z
    .string()
    .max(500, "Condizioni non possono superare 500 caratteri")
    .trim()
    .optional()
    .nullable(),
  pointsRequired: z
    .number()
    .int("Il numero di punti deve essere intero")
    .min(0, "I punti richiesti non possono essere negativi")
    .max(100000, "I punti richiesti non possono superare 100000"),
  validFrom: z
    .string()
    .datetime({ message: "Data di inizio non valida" })
    .optional()
    .nullable(),
  validUntil: z
    .string()
    .datetime({ message: "Data di fine non valida" })
    .optional()
    .nullable(),
  icon: z
    .string()
    .max(50, "Nome icona non può superare 50 caratteri")
    .optional()
    .nullable(),
  isActive: z
    .boolean()
    .optional()
    .default(true),
  requiredLoyaltyLevel: z
    .number()
    .int("Il livello deve essere un intero")
    .min(0, "Il livello non può essere negativo")
    .max(4, "Livello non valido")
    .optional()
    .default(0),
});

export const updateOfferSchema = createOfferSchema.partial();

export type CreateOfferInput = z.infer<typeof createOfferSchema>;
export type UpdateOfferInput = z.infer<typeof updateOfferSchema>;

export function validateCreateOfferInput(data: unknown) {
  try {
    return { success: true, data: createOfferSchema.parse(data) };
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

export function validateUpdateOfferInput(data: unknown) {
  try {
    return { success: true, data: updateOfferSchema.parse(data) };
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
