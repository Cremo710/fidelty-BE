import { z } from "zod";

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const timeRangeSchema = z.object({
  open: z.string().regex(timeRegex, "Orario di apertura non valido (formato HH:MM)"),
  close: z.string().regex(timeRegex, "Orario di chiusura non valido (formato HH:MM)"),
});

export const dayHoursSchema = z.object({
  dayOfWeek: z
    .number()
    .int()
    .min(0, "Giorno della settimana non valido")
    .max(6, "Giorno della settimana non valido"),
  isClosed: z.boolean().default(false),
  timeRanges: z.array(timeRangeSchema).max(5, "Massimo 5 fasce orarie per giorno").default([]),
});

export const setOpeningHoursSchema = z.object({
  hours: z
    .array(dayHoursSchema)
    .max(7, "Non ci possono essere più di 7 giorni"),
});

export type TimeRange = z.infer<typeof timeRangeSchema>;
export type DayHours = z.infer<typeof dayHoursSchema>;
export type SetOpeningHoursInput = z.infer<typeof setOpeningHoursSchema>;

export function validateSetOpeningHoursInput(data: unknown) {
  try {
    return { success: true, data: setOpeningHoursSchema.parse(data) };
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
