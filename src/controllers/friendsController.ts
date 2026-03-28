import { FastifyRequest, FastifyReply } from "fastify";
import { databaseService } from "../services/databaseService.js";
import { userRepository } from "../repositories/userRepository.js";

class FriendsController {
  /**
   * POST /api/friends/add
   * Body: { publicId: string }
   * Creates a bidirectional friendship.
   */
  async addFriend(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const { publicId } = request.body as { publicId?: string };
      if (!publicId || typeof publicId !== "string") {
        return reply.status(400).send({ success: false, error: "publicId obbligatorio", code: "MISSING_PUBLIC_ID" });
      }

      // Find target user
      const target = await userRepository.findByPublicId(publicId.trim().toUpperCase());
      if (!target) {
        return reply.status(404).send({ success: false, error: "Utente non trovato", code: "USER_NOT_FOUND" });
      }

      // Prevent adding yourself
      if (target.id === userId) {
        return reply.status(400).send({ success: false, error: "Non puoi aggiungere te stesso", code: "SELF_ADD" });
      }

      // Insert bidirectional friendship (ignore duplicates)
      const pool = (databaseService as any).pool;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [userId, target.id],
        );
        await client.query(
          `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [target.id, userId],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return reply.status(200).send({
        success: true,
        message: "Amicizia aggiunta con successo",
        data: { friendId: target.id, publicId: target.public_id, name: target.name },
      });
    } catch (error) {
      console.error("❌ Errore addFriend:", error);
      return reply.status(500).send({ success: false, error: "Errore interno", code: "FRIENDS_ERROR" });
    }
  }

  /**
   * DELETE /api/friends/:publicId
   * Removes a bidirectional friendship.
   */
  async removeFriend(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const { publicId } = request.params as { publicId?: string };
      if (!publicId) {
        return reply.status(400).send({ success: false, error: "publicId obbligatorio", code: "MISSING_PUBLIC_ID" });
      }

      const target = await userRepository.findByPublicId(publicId.trim().toUpperCase());
      if (!target) {
        return reply.status(404).send({ success: false, error: "Utente non trovato", code: "USER_NOT_FOUND" });
      }

      const pool = (databaseService as any).pool;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2`, [userId, target.id]);
        await client.query(`DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2`, [target.id, userId]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return reply.status(200).send({ success: true, message: "Amicizia rimossa" });
    } catch (error) {
      console.error("❌ Errore removeFriend:", error);
      return reply.status(500).send({ success: false, error: "Errore interno", code: "FRIENDS_ERROR" });
    }
  }

  /**
   * GET /api/friends
   * Returns the authenticated user's friends list.
   */
  async getFriends(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const pool = (databaseService as any).pool;
      const result = await pool.query(
        `SELECT u.id, u.public_id AS "publicId", u.name, u.profile_image AS "profileImage"
         FROM friendships f
         JOIN utenti u ON u.id = f.friend_id
         WHERE f.user_id = $1
         ORDER BY f.created_at DESC`,
        [userId],
      );

      return reply.status(200).send({ success: true, data: result.rows });
    } catch (error) {
      console.error("❌ Errore getFriends:", error);
      return reply.status(500).send({ success: false, error: "Errore interno", code: "FRIENDS_ERROR" });
    }
  }
}

export const friendsController = new FriendsController();
