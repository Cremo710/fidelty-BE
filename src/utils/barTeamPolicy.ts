import type { BarTeamRole } from "./barPermissions.js";

export type BarTeamPolicyError =
  | "STAFF_MANAGEMENT_FORBIDDEN"
  | "MANAGER_PROTECTED"
  | "SELF_ROLE_CHANGE_FORBIDDEN"
  | "CO_MANAGER_PROTECTED"
  | "ROLE_ASSIGNMENT_FORBIDDEN";

export function getTeamMutationDenial(input: {
  actorRole: BarTeamRole;
  actorUserId: string;
  targetRole: BarTeamRole;
  targetUserId: string | null;
  newRole?: "co_manager" | "waiter";
}): BarTeamPolicyError | null {
  if (input.actorRole === "waiter") return "STAFF_MANAGEMENT_FORBIDDEN";
  if (input.targetRole === "manager") return "MANAGER_PROTECTED";
  if (input.targetUserId && input.targetUserId === input.actorUserId) {
    return "SELF_ROLE_CHANGE_FORBIDDEN";
  }
  if (input.targetRole === "co_manager" && input.actorRole !== "manager") {
    return "CO_MANAGER_PROTECTED";
  }
  if (input.newRole === "co_manager" && input.actorRole !== "manager") {
    return "ROLE_ASSIGNMENT_FORBIDDEN";
  }
  return null;
}

export function canInviteRole(actorRole: BarTeamRole, requestedRole: "co_manager" | "waiter") {
  return actorRole !== "waiter" && (requestedRole !== "co_manager" || actorRole === "manager");
}
