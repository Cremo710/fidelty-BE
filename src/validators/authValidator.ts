import { z } from "zod";

// Schema di validazione per la registrazione
export const registerSchema = z.object({
  name: z
    .string()
    .min(2, "Nome deve avere almeno 2 caratteri")
    .max(255, "Nome non può superare 255 caratteri")
    .trim(),
  email: z
    .string()
    .email("Email non valida")
    .toLowerCase()
    .trim(),
  password: z
    .string()
    .min(8, "Password deve avere almeno 8 caratteri")
    .regex(/[A-Z]/, "Password deve contenere almeno una maiuscola")
    .regex(/[0-9]/, "Password deve contenere almeno un numero")
    .regex(/[a-z]/, "Password deve contenere almeno una minuscola"),
});

// Schema di validazione per il login
export const loginSchema = z.object({
  email: z
    .string()
    .email("Email non valida")
    .toLowerCase()
    .trim(),
  password: z
    .string()
    .min(1, "Password è obbligatoria"),
});

// Schema di validazione per refresh token
export const refreshSchema = z.object({
  refreshToken: z
    .string()
    .min(1, "Refresh token obbligatorio"),
});

// Types derivati dagli schema
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;

// Funzione helper per validare
export function validateRegisterInput(data: unknown) {
  try {
    return { success: true, data: registerSchema.parse(data) };
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

export function validateLoginInput(data: unknown) {
  try {
    return { success: true, data: loginSchema.parse(data) };
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

export function validateRefreshInput(data: unknown) {
  try {
    return { success: true, data: refreshSchema.parse(data) };
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
