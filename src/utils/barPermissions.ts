export type BarTeamRole = "manager" | "co_manager" | "waiter";
export type BarPermission =
  | "offers.validate"
  | "consumptions.manage"
  // Accredito di punti senza scontrino né richiesta del cliente: solo titolare e co-titolare
  | "points.credit_manual"
  | "offers.edit"
  | "business.edit"
  | "business.delete"
  | "fraud.config"
  | "stats.view"
  | "staff.view"
  | "staff.manage";

export const BAR_ROLE_PERMISSIONS: Record<BarTeamRole, readonly BarPermission[]> = {
  // Solo il manager (titolare) può eliminare l'attività e modificare le regole antifrode
  manager: [
    "offers.validate",
    "consumptions.manage",
    "points.credit_manual",
    "offers.edit",
    "business.edit",
    "business.delete",
    "fraud.config",
    "stats.view",
    "staff.view",
    "staff.manage",
  ],
  co_manager: [
    "offers.validate",
    "consumptions.manage",
    "points.credit_manual",
    "offers.edit",
    "business.edit",
    "stats.view",
    "staff.view",
    "staff.manage",
  ],
  // Il cameriere approva e rifiuta le richieste dei clienti, ma non crea punti da solo
  waiter: ["offers.validate", "consumptions.manage", "staff.view"],
};

export function hasBarPermission(role: BarTeamRole, permission: BarPermission): boolean {
  return BAR_ROLE_PERMISSIONS[role].includes(permission);
}
