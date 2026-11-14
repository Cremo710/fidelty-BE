import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ulid } from "ulid";

const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)("integrazione team bar (database di test)", () => {
  let databaseService: typeof import("../services/databaseService.js").databaseService;
  let barTeamService: typeof import("../services/barTeamService.js").barTeamService;
  let loyaltyCardRepository: typeof import("../repositories/loyaltyCardRepository.js").loyaltyCardRepository;
  let requireBarPermission: typeof import("../utils/barPermissionGuard.js").requireBarPermission;
  const userIds: string[] = [];
  const barIds: string[] = [];
  let managerId: string;
  let managerEmail: string;
  let waiterId: string;
  let waiterEmail: string;
  let barId: string;
  let otherBarId: string;

  async function createUser(overrideEmail?: string) {
    const id = ulid();
    const email = overrideEmail ?? `team-${id.toLowerCase()}@example.test`;
    await databaseService.getPool().query(
      `INSERT INTO utenti (id, name, email, password, is_email_verified)
       VALUES ($1, 'Team test', $2, 'test-hash', TRUE)`,
      [id, email],
    );
    userIds.push(id);
    return { id, email };
  }

  async function createBar(owner: { id: string; email: string }) {
    const id = ulid();
    await databaseService.getPool().query(
      `INSERT INTO bars (id, user_id, iva, merchant_name, name, address)
       VALUES ($1, $2, $3, 'Test', 'Test bar', 'Via Test 1')`,
      [id, owner.id, id.slice(-11)],
    );
    await databaseService.getPool().query(
      `INSERT INTO bar_team_members (id, bar_id, user_id, email, role, status, accepted_at)
       VALUES ($1, $1, $2, $3, 'manager', 'active', CURRENT_TIMESTAMP)`,
      [id, owner.id, owner.email],
    );
    barIds.push(id);
    return id;
  }

  beforeAll(async () => {
    if (!/test/i.test(testUrl as string)) {
      throw new Error("TEST_DATABASE_URL deve puntare a un database il cui nome/URL contiene 'test'");
    }
    process.env.DATABASE_URL = testUrl;
    ({ databaseService } = await import("../services/databaseService.js"));
    ({ barTeamService } = await import("../services/barTeamService.js"));
    ({ loyaltyCardRepository } = await import("../repositories/loyaltyCardRepository.js"));
    ({ requireBarPermission } = await import("../utils/barPermissionGuard.js"));
    await databaseService.initializeTables();
    const manager = await createUser();
    const waiter = await createUser();
    managerId = manager.id;
    managerEmail = manager.email;
    waiterId = waiter.id;
    waiterEmail = waiter.email;
    barId = await createBar(manager);
    const otherManager = await createUser();
    otherBarId = await createBar(otherManager);
  });

  afterAll(async () => {
    if (!databaseService) return;
    for (const id of barIds) {
      await databaseService.getPool().query("DELETE FROM bars WHERE id = $1", [id]);
    }
    for (const id of userIds) {
      await databaseService.getPool().query("DELETE FROM utenti WHERE id = $1", [id]);
    }
    await databaseService.closePool();
  });

  it("enforces role access, invitations, protections, duplicates, expiry, revocation and race safety", async () => {
    const unlockedCards = await Promise.all([
      loyaltyCardRepository.ensureCardExists(managerId, barId),
      loyaltyCardRepository.ensureCardExists(managerId, barId),
    ]);
    expect(unlockedCards.filter(({ created }) => created)).toHaveLength(1);
    expect(new Set(unlockedCards.map(({ id }) => id)).size).toBe(1);
    const unlockedCard = await loyaltyCardRepository.findByUserAndBar(managerId, barId);
    expect(unlockedCard).toMatchObject({ points: 0, receipts_count: 0, lifetime_points: 0 });
    await databaseService.getPool().query(
      "UPDATE loyalty_cards SET points = 45, lifetime_points = 45, receipts_count = 2 WHERE user_id = $1 AND bar_id = $2",
      [managerId, barId],
    );
    expect(await loyaltyCardRepository.ensureCardExists(managerId, barId)).toMatchObject({
      id: unlockedCard?.id,
      created: false,
    });
    expect(await loyaltyCardRepository.findByUserAndBar(managerId, barId)).toMatchObject({
      points: 45,
      receipts_count: 2,
      lifetime_points: 45,
    });

    const permissionGuard = async (userId: string, selectedBarId: string, permission: Parameters<typeof requireBarPermission>[0]) => {
      let statusCode = 200;
      const reply = {
        status(code: number) { statusCode = code; return this; },
        send() { return this; },
      } as unknown as FastifyReply;
      const request = {
        userId,
        headers: { "x-bar-id": selectedBarId },
        params: {},
      } as unknown as FastifyRequest;
      await requireBarPermission(permission)(request, reply);
      return statusCode;
    };

    const invitation = await barTeamService.createInvitation({
      barId, actorUserId: managerId, actorRole: "manager", email: waiterEmail, role: "waiter",
    });
    expect(invitation.status).toBe(201);
    if (invitation.status !== 201) return;
    const receivedInvitations = await barTeamService.listReceivedInvitations(waiterEmail);
    expect(receivedInvitations).toContainEqual(expect.objectContaining({
      id: invitation.invitation.id,
      barId,
      barName: "Test bar",
      invitedByName: "Team test",
    }));
    expect(receivedInvitations.find(({ id }) => id === invitation.invitation.id)).toHaveProperty("createdAt");
    expect((await barTeamService.createInvitation({
      barId, actorUserId: managerId, actorRole: "manager", email: waiterEmail, role: "waiter",
    })).code).toBe("TEAM_MEMBER_EXISTS");

    const createdConcurrentInvitations = await Promise.all([
      barTeamService.createInvitation({
        barId, actorUserId: managerId, actorRole: "manager", email: "race@example.test", role: "waiter",
      }),
      barTeamService.createInvitation({
        barId, actorUserId: managerId, actorRole: "manager", email: "race@example.test", role: "waiter",
      }),
    ]);
    expect(createdConcurrentInvitations.map((result) => result.status).sort()).toEqual([201, 409]);

    const unregisteredEmail = `new-${ulid().toLowerCase()}@example.test`;
    const pendingForNewUser = await barTeamService.createInvitation({
      barId, actorUserId: managerId, actorRole: "manager", email: unregisteredEmail, role: "waiter",
    });
    expect(pendingForNewUser.status).toBe(201);
    if (pendingForNewUser.status !== 201) return;
    expect((await barTeamService.listTeam(barId)).some((member) => member.email === unregisteredEmail && member.status === "pending"))
      .toBe(true);
    const newUser = await createUser(unregisteredEmail);
    expect((await barTeamService.acceptInvitation(pendingForNewUser.invitation.id, newUser.id, unregisteredEmail)).status)
      .toBe(200);
    expect((await barTeamService.leaveTeam(barId, newUser.id)).status).toBe(200);
    expect(await barTeamService.getAccess(newUser.id, barId)).toBeNull();
    expect((await barTeamService.leaveTeam(barId, managerId)).code)
      .toBe("MANAGER_CANNOT_LEAVE_OR_NOT_MEMBER");

    expect((await barTeamService.acceptInvitation(invitation.invitation.id, waiterId, waiterEmail)).status).toBe(200);
    const waiterAccess = await barTeamService.getAccess(waiterId, barId);
    expect(waiterAccess?.permissions).toEqual(["offers.validate", "consumptions.manage"]);
    for (const permission of [
      "offers.validate", "consumptions.manage", "offers.edit", "business.edit", "stats.view", "staff.manage",
    ] as const) {
      expect(await permissionGuard(waiterId, barId, permission)).toBe(
        permission === "offers.validate" || permission === "consumptions.manage" ? 200 : 403,
      );
    }
    expect(await permissionGuard(waiterId, otherBarId, "consumptions.manage")).toBe(404);
    for (const permission of [
      "offers.validate", "consumptions.manage", "offers.edit", "business.edit", "stats.view", "staff.manage",
    ] as const) {
      expect(await permissionGuard(managerId, barId, permission)).toBe(200);
    }

    const activeWaiter = (await barTeamService.listTeam(barId)).find((member) => member.email === waiterEmail);
    expect(activeWaiter).toBeDefined();
    if (!activeWaiter) return;
    expect((await barTeamService.updateMember({
      barId, memberId: activeWaiter.id, actorUserId: managerId, actorRole: "manager", role: "co_manager",
    })).status).toBe(200);
    expect((await barTeamService.getAccess(waiterId, barId))?.permissions).toHaveLength(6);
    for (const permission of [
      "offers.validate", "consumptions.manage", "offers.edit", "business.edit", "stats.view", "staff.manage",
    ] as const) {
      expect(await permissionGuard(waiterId, barId, permission)).toBe(200);
    }

    const secondCoManagerEmail = `co-${ulid().toLowerCase()}@example.test`;
    const secondCoManagerInvitation = await barTeamService.createInvitation({
      barId, actorUserId: managerId, actorRole: "manager", email: secondCoManagerEmail, role: "co_manager",
    });
    expect(secondCoManagerInvitation.status).toBe(201);
    if (secondCoManagerInvitation.status !== 201) return;
    const secondCoManager = await createUser(secondCoManagerEmail);
    expect((await barTeamService.acceptInvitation(
      secondCoManagerInvitation.invitation.id,
      secondCoManager.id,
      secondCoManagerEmail,
    )).status).toBe(200);
    const secondCoManagerMember = (await barTeamService.listTeam(barId))
      .find((member) => member.email === secondCoManagerEmail);
    expect(secondCoManagerMember).toBeDefined();
    if (secondCoManagerMember) {
      expect((await barTeamService.updateMember({
        barId,
        memberId: secondCoManagerMember.id,
        actorUserId: waiterId,
        actorRole: "co_manager",
        remove: true,
      })).code).toBe("CO_MANAGER_PROTECTED");
    }

    const managerMember = (await barTeamService.listTeam(barId)).find((member) => member.role === "manager");
    expect(managerMember).toBeDefined();
    if (managerMember) {
      expect((await barTeamService.updateMember({
        barId, memberId: managerMember.id, actorUserId: waiterId, actorRole: "co_manager", remove: true,
      })).code).toBe("MANAGER_PROTECTED");
    }
    expect((await barTeamService.updateMember({
      barId, memberId: activeWaiter.id, actorUserId: waiterId, actorRole: "co_manager", role: "waiter",
    })).code).toBe("SELF_ROLE_CHANGE_FORBIDDEN");
    expect((await barTeamService.createInvitation({
      barId, actorUserId: waiterId, actorRole: "co_manager", email: "co@example.test", role: "co_manager",
    })).code).toBe("ROLE_ASSIGNMENT_FORBIDDEN");

    const expiringInvite = await barTeamService.createInvitation({
      barId, actorUserId: managerId, actorRole: "manager", email: "expired@example.test", role: "waiter",
    });
    expect(expiringInvite.status).toBe(201);
    if (expiringInvite.status === 201) {
      await databaseService.getPool().query(
        "UPDATE bar_team_members SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = $1",
        [expiringInvite.invitation.id],
      );
      expect((await barTeamService.acceptInvitation(expiringInvite.invitation.id, waiterId, "expired@example.test")).code)
        .toBe("INVITATION_EXPIRED");
    }

    const revocableInvite = await barTeamService.createInvitation({
      barId, actorUserId: managerId, actorRole: "manager", email: "revoke@example.test", role: "waiter",
    });
    expect(revocableInvite.status).toBe(201);
    if (revocableInvite.status === 201) {
      expect((await barTeamService.updateMember({
        barId, memberId: revocableInvite.invitation.id, actorUserId: managerId, actorRole: "manager", remove: true,
      })).status).toBe(200);
    }

    expect((await barTeamService.updateMember({
      barId, memberId: activeWaiter.id, actorUserId: managerId, actorRole: "manager", remove: true,
    })).status).toBe(200);
    expect(await barTeamService.getAccess(waiterId, barId)).toBeNull();
    expect(await permissionGuard(waiterId, barId, "consumptions.manage")).toBe(404);
  });
});
