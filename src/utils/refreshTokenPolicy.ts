import { createHash } from "crypto";

/** I refresh token non vengono salvati in chiaro: nel database c'è solo lo SHA-256. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Finestra in cui un token appena ruotato viene ancora accettato: copre la risposta di
 * refresh persa per un problema di rete, dopo la quale il client riprova con il token vecchio.
 */
export const REFRESH_ROTATION_GRACE_MS = 60_000;

export interface StoredRefreshToken {
  revoked: boolean;
  rotated_at: Date | string | null;
}

export type RefreshDecision =
  | { action: "accept" }
  | { action: "reject"; code: "REVOKED_REFRESH_TOKEN" }
  | { action: "reject_and_revoke_family"; code: "REFRESH_TOKEN_REUSED" };

/**
 * Decide cosa fare di un refresh token presentato dal client.
 * - token attivo → accept
 * - token già ruotato, entro la finestra di tolleranza e con la famiglia ancora attiva → accept
 * - token già ruotato fuori finestra → riuso: probabile furto, si revoca l'intera famiglia
 * - token revocato da logout o da revoca globale → reject
 */
export function decideRefresh(
  stored: StoredRefreshToken,
  options: { now: number; familyHasActiveToken: boolean; graceMs?: number },
): RefreshDecision {
  if (!stored.revoked) {
    return { action: "accept" };
  }
  if (stored.rotated_at == null) {
    return { action: "reject", code: "REVOKED_REFRESH_TOKEN" };
  }
  const rotatedAt = new Date(stored.rotated_at).getTime();
  const graceMs = options.graceMs ?? REFRESH_ROTATION_GRACE_MS;
  if (options.familyHasActiveToken && options.now - rotatedAt <= graceMs) {
    return { action: "accept" };
  }
  return { action: "reject_and_revoke_family", code: "REFRESH_TOKEN_REUSED" };
}
