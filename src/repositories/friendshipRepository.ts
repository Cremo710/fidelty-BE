import type { PoolClient } from "pg";
import { ulid } from "ulid";
import { databaseService } from "../services/databaseService.js";

type Queryable = Pick<PoolClient, "query">;

export interface FriendListItem {
  id: string;
  publicId: string;
  name: string;
  profileImage: string | null;
  friendsSince: Date;
}

export interface FriendshipRequestItem {
  id: string;
  status: "pending" | "accepted" | "rejected" | "cancelled";
  createdAt: Date;
  respondedAt: Date | null;
  requester: {
    id: string;
    publicId: string;
    name: string;
    profileImage: string | null;
  };
  recipient: {
    id: string;
    publicId: string;
    name: string;
    profileImage: string | null;
  };
}

export class FriendshipRepository {
  private normalizePair(userA: string, userB: string) {
    return userA < userB
      ? { lowUserId: userA, highUserId: userB }
      : { lowUserId: userB, highUserId: userA };
  }

  async hasAcceptedFriendship(userA: string, userB: string): Promise<boolean> {
    const result = await databaseService.getPool().query(
      `
        SELECT 1
        FROM friendships
        WHERE (user_id = $1 AND friend_id = $2)
           OR (user_id = $2 AND friend_id = $1)
        LIMIT 1
      `,
      [userA, userB],
    );

    return result.rows.length > 0;
  }

  async getPendingRequestBetween(userA: string, userB: string): Promise<any | null> {
    const { lowUserId, highUserId } = this.normalizePair(userA, userB);
    const result = await databaseService.getPool().query(
      `
        SELECT *
        FROM friendship_requests
        WHERE pair_low_user_id = $1
          AND pair_high_user_id = $2
          AND status = 'pending'
        LIMIT 1
      `,
      [lowUserId, highUserId],
    );

    return result.rows[0] || null;
  }

  async createRequest(requesterId: string, recipientId: string): Promise<any> {
    const { lowUserId, highUserId } = this.normalizePair(requesterId, recipientId);
    const result = await databaseService.getPool().query(
      `
        INSERT INTO friendship_requests (
          id,
          requester_id,
          recipient_id,
          pair_low_user_id,
          pair_high_user_id,
          status,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP)
        RETURNING *
      `,
      [ulid(), requesterId, recipientId, lowUserId, highUserId],
    );

    return result.rows[0];
  }

  async createBidirectionalFriendship(client: Queryable, userA: string, userB: string): Promise<void> {
    await client.query(
      `
        INSERT INTO friendships (user_id, friend_id)
        VALUES ($1, $2), ($2, $1)
        ON CONFLICT DO NOTHING
      `,
      [userA, userB],
    );
  }

  async acceptRequest(requestId: string, recipientUserId: string): Promise<FriendshipRequestItem | null> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");

      const requestResult = await client.query(
        `
          SELECT *
          FROM friendship_requests
          WHERE id = $1
            AND recipient_id = $2
            AND status = 'pending'
          FOR UPDATE
        `,
        [requestId, recipientUserId],
      );

      const requestRow = requestResult.rows[0];
      if (!requestRow) {
        await client.query("ROLLBACK");
        return null;
      }

      await this.createBidirectionalFriendship(client, requestRow.requester_id, requestRow.recipient_id);

      await client.query(
        `
          UPDATE friendship_requests
          SET status = 'accepted', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `,
        [requestId],
      );

      await client.query("COMMIT");
      return this.getRequestById(requestId);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectRequest(requestId: string, recipientUserId: string): Promise<FriendshipRequestItem | null> {
    const result = await databaseService.getPool().query(
      `
        UPDATE friendship_requests
        SET status = 'rejected', responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND recipient_id = $2
          AND status = 'pending'
        RETURNING id
      `,
      [requestId, recipientUserId],
    );

    if (!result.rows[0]) {
      return null;
    }

    return this.getRequestById(requestId);
  }

  async listFriends(userId: string): Promise<FriendListItem[]> {
    const result = await databaseService.getPool().query(
      `
        SELECT
          u.id,
          u.public_id AS "publicId",
          u.name,
          u.profile_image AS "profileImage",
          f.created_at AS "friendsSince"
        FROM friendships f
        JOIN utenti u ON u.id = f.friend_id
        WHERE f.user_id = $1
        ORDER BY f.created_at DESC, u.name ASC
      `,
      [userId],
    );

    return result.rows;
  }

  async listIncomingRequests(userId: string): Promise<FriendshipRequestItem[]> {
    return this.listRequests(
      `fr.recipient_id = $1 AND fr.status = 'pending'`,
      [userId],
    );
  }

  async listOutgoingRequests(userId: string): Promise<FriendshipRequestItem[]> {
    return this.listRequests(
      `fr.requester_id = $1 AND fr.status = 'pending'`,
      [userId],
    );
  }

  async removeBidirectionalFriendship(userId: string, friendUserId: string): Promise<void> {
    const client = await databaseService.getPool().connect();

    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2`, [userId, friendUserId]);
      await client.query(`DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2`, [friendUserId, userId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async getRequestById(requestId: string): Promise<FriendshipRequestItem | null> {
    const rows = await this.listRequests(`fr.id = $1`, [requestId]);
    return rows[0] || null;
  }

  private async listRequests(whereClause: string, params: unknown[]): Promise<FriendshipRequestItem[]> {
    const result = await databaseService.getPool().query(
      `
        SELECT
          fr.id,
          fr.status,
          fr.created_at AS "createdAt",
          fr.responded_at AS "respondedAt",
          requester.id AS requester_id,
          requester.public_id AS requester_public_id,
          requester.name AS requester_name,
          requester.profile_image AS requester_profile_image,
          recipient.id AS recipient_id,
          recipient.public_id AS recipient_public_id,
          recipient.name AS recipient_name,
          recipient.profile_image AS recipient_profile_image
        FROM friendship_requests fr
        JOIN utenti requester ON requester.id = fr.requester_id
        JOIN utenti recipient ON recipient.id = fr.recipient_id
        WHERE ${whereClause}
        ORDER BY fr.created_at DESC
      `,
      params,
    );

    return result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      respondedAt: row.respondedAt,
      requester: {
        id: row.requester_id,
        publicId: row.requester_public_id,
        name: row.requester_name,
        profileImage: row.requester_profile_image,
      },
      recipient: {
        id: row.recipient_id,
        publicId: row.recipient_public_id,
        name: row.recipient_name,
        profileImage: row.recipient_profile_image,
      },
    }));
  }
}

export const friendshipRepository = new FriendshipRepository();