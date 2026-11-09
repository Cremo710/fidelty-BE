export type BarTeamRole = "manager" | "co_manager" | "waiter";
export type BarPermission =
  | "offers.validate"
  | "consumptions.manage"
  | "offers.edit"
  | "business.edit"
  | "stats.view"
  | "staff.view"
  | "staff.manage";

export const BAR_ROLE_PERMISSIONS: Record<BarTeamRole, readonly BarPermission[]> = {
  manager: [
    "offers.validate",
    "consumptions.manage",
    "offers.edit",
    "business.edit",
    "stats.view",
    "staff.view",
    "staff.manage",
  ],
  co_manager: [
    "offers.validate",
    "consumptions.manage",
    "offers.edit",
    "business.edit",
    "stats.view",
    "staff.view",
    "staff.manage",
  ],
  waiter: ["offers.validate", "consumptions.manage", "staff.view"],
};

export function hasBarPermission(role: BarTeamRole, permission: BarPermission): boolean {
  return BAR_ROLE_PERMISSIONS[role].includes(permission);
}
