import { describe, expect, it } from "vitest";
import { BAR_ROLE_PERMISSIONS, hasBarPermission } from "../utils/barPermissions.js";
import { canInviteRole, getTeamMutationDenial } from "../utils/barTeamPolicy.js";

describe("bar team role permissions", () => {
  it("grants co-manager the manager set except owner-only permissions", () => {
    const ownerOnly = ["business.delete", "fraud.config"] as const;
    for (const permission of BAR_ROLE_PERMISSIONS.manager) {
      expect(hasBarPermission("manager", permission)).toBe(true);
      expect(hasBarPermission("co_manager", permission)).toBe(!ownerOnly.includes(permission as typeof ownerOnly[number]));
    }
    expect(BAR_ROLE_PERMISSIONS.co_manager.every((permission) => hasBarPermission("manager", permission))).toBe(true);
  });

  it("keeps bar deletion and anti-fraud config away from co-managers and waiters", () => {
    for (const role of ["co_manager", "waiter"] as const) {
      expect(hasBarPermission(role, "business.delete")).toBe(false);
      expect(hasBarPermission(role, "fraud.config")).toBe(false);
    }
  });

  it("limits waiters to allowed operations and team viewing", () => {
    expect(BAR_ROLE_PERMISSIONS.waiter).toEqual(["offers.validate", "consumptions.manage", "staff.view"]);
    expect(hasBarPermission("waiter", "offers.edit")).toBe(false);
    expect(hasBarPermission("waiter", "business.edit")).toBe(false);
    expect(hasBarPermission("waiter", "stats.view")).toBe(false);
    expect(hasBarPermission("waiter", "staff.view")).toBe(true);
    expect(hasBarPermission("waiter", "staff.manage")).toBe(false);
  });

  it("reserves manual point credits to manager and co-manager", () => {
    expect(hasBarPermission("manager", "points.credit_manual")).toBe(true);
    expect(hasBarPermission("co_manager", "points.credit_manual")).toBe(true);
    expect(hasBarPermission("waiter", "points.credit_manual")).toBe(false);
    // Il cameriere continua ad approvare e rifiutare le richieste dei clienti
    expect(hasBarPermission("waiter", "consumptions.manage")).toBe(true);
  });

  it("protects the manager and blocks self-promotion and co-manager administration", () => {
    expect(getTeamMutationDenial({
      actorRole: "co_manager",
      actorUserId: "co-manager",
      targetRole: "manager",
      targetUserId: "manager",
    })).toBe("MANAGER_PROTECTED");
    expect(getTeamMutationDenial({
      actorRole: "waiter",
      actorUserId: "waiter",
      targetRole: "waiter",
      targetUserId: "waiter",
      newRole: "co_manager",
    })).toBe("STAFF_MANAGEMENT_FORBIDDEN");
    expect(getTeamMutationDenial({
      actorRole: "co_manager",
      actorUserId: "co-manager",
      targetRole: "co_manager",
      targetUserId: "co-manager",
      newRole: "waiter",
    })).toBe("SELF_ROLE_CHANGE_FORBIDDEN");
    expect(getTeamMutationDenial({
      actorRole: "co_manager",
      actorUserId: "co-manager",
      targetRole: "co_manager",
      targetUserId: "other-co-manager",
    })).toBe("CO_MANAGER_PROTECTED");
    expect(canInviteRole("co_manager", "co_manager")).toBe(false);
    expect(canInviteRole("manager", "co_manager")).toBe(true);
    expect(canInviteRole("waiter", "waiter")).toBe(false);
    expect(getTeamMutationDenial({
      actorRole: "waiter",
      actorUserId: "waiter",
      targetRole: "waiter",
      targetUserId: "another-waiter",
      newRole: "waiter",
    })).toBe("STAFF_MANAGEMENT_FORBIDDEN");
  });
});
