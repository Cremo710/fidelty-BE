import { randomInt } from "node:crypto";

export const PUBLIC_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PUBLIC_ID_PREFIX = "FU-";
const PUBLIC_ID_RANDOM_LENGTH = 5;
export const PUBLIC_ID_MAX_ATTEMPTS = 10;

export type PublicIdQueryable = {
  query: (
    sql: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

export function generatePublicId(): string {
  let publicId = PUBLIC_ID_PREFIX;
  for (let index = 0; index < PUBLIC_ID_RANDOM_LENGTH; index++) {
    publicId += PUBLIC_ID_ALPHABET[randomInt(PUBLIC_ID_ALPHABET.length)];
  }
  return publicId;
}

export async function generateUniquePublicId(
  queryable: PublicIdQueryable,
  candidateGenerator: () => string = generatePublicId,
): Promise<string> {
  for (let attempt = 0; attempt < PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
    const candidate = candidateGenerator();
    const existing = await queryable.query(
      "SELECT 1 FROM utenti WHERE public_id = $1 LIMIT 1",
      [candidate],
    );
    if (existing.rows.length === 0) return candidate;
  }

  throw new Error(
    `Impossibile generare un public_id unico dopo ${PUBLIC_ID_MAX_ATTEMPTS} tentativi`,
  );
}
