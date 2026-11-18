import { FastifyRequest, FastifyReply } from "fastify";
import { databaseService } from "../services/databaseService.js";
import { userRepository } from "../repositories/userRepository.js";
import { friendshipRepository } from "../repositories/friendshipRepository.js";

class FriendsController {
  /**
   * POST /api/friends/add
   * Body: { publicId: string }
   * Creates a pending friendship request, or accepts a mirrored pending one.
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

      const alreadyFriends = await friendshipRepository.hasAcceptedFriendship(userId, target.id);
      if (alreadyFriends) {
        return reply.status(409).send({ success: false, error: "Siete già amici", code: "ALREADY_FRIENDS" });
      }

      const existingPending = await friendshipRepository.getPendingRequestBetween(userId, target.id);
      if (existingPending) {
        if (existingPending.requester_id === userId) {
          return reply.status(409).send({ success: false, error: "Richiesta già inviata", code: "REQUEST_ALREADY_PENDING" });
        }

        const accepted = await friendshipRepository.acceptRequest(existingPending.id, userId);
        return reply.status(200).send({
          success: true,
          message: "Richiesta accettata automaticamente",
          data: {
            flow: "auto-accepted",
            request: accepted,
          },
        });
      }

      const createdRequest = await friendshipRepository.createRequest(userId, target.id);

      return reply.status(200).send({
        success: true,
        message: "Richiesta amicizia inviata",
        data: {
          flow: "request-created",
          requestId: createdRequest.id,
          friendId: target.id,
          publicId: target.public_id,
          name: target.name,
        },
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

      await friendshipRepository.removeBidirectionalFriendship(userId, target.id);

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

      const friends = await friendshipRepository.listFriends(userId);

      const cardsByUser = await Promise.all(
        friends.map(async (friend) => {
          const cards = await databaseService.getUserLoyaltyCards(friend.id);
          return {
            friendId: friend.id,
            cardsCount: cards.length,
            totalAvailablePoints: cards.reduce((sum, card) => sum + (card.availablePoints || 0), 0),
          };
        }),
      );

      const cardsMap = new Map(cardsByUser.map((item) => [item.friendId, item]));

      return reply.status(200).send({
        success: true,
        data: friends.map((friend) => ({
          ...friend,
          cardsCount: cardsMap.get(friend.id)?.cardsCount || 0,
          totalAvailablePoints: cardsMap.get(friend.id)?.totalAvailablePoints || 0,
        })),
      });
    } catch (error) {
      console.error("❌ Errore getFriends:", error);
      return reply.status(500).send({ success: false, error: "Errore interno", code: "FRIENDS_ERROR" });
    }
  }

  async getRequests(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const [incoming, outgoing] = await Promise.all([
        friendshipRepository.listIncomingRequests(userId),
        friendshipRepository.listOutgoingRequests(userId),
      ]);

      return reply.status(200).send({ success: true, data: { incoming, outgoing } });
    } catch (error) {
      console.error("❌ Errore getRequests:", error);
      return reply.status(500).send({ success: false, error: "Errore interno", code: "FRIENDS_ERROR" });
    }
  }

  async acceptRequest(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const { requestId } = request.params as { requestId?: string };
      if (!requestId) {
        return reply.status(400).send({ success: false, error: "requestId obbligatorio", code: "MISSING_REQUEST_ID" });
      }

      const accepted = await friendshipRepository.acceptRequest(requestId, userId);
      if (!accepted) {
        return reply.status(404).send({ success: false, error: "Richiesta non trovata", code: "REQUEST_NOT_FOUND" });
      }

      return reply.status(200).send({ success: true, message: "Richiesta accettata", data: accepted });
    } catch (error) {
      console.error("❌ Errore acceptRequest:", error);
      return reply.status(500).send({ success: false, error: "Errore interno", code: "FRIENDS_ERROR" });
    }
  }

  async rejectRequest(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request as any).userId;
      if (!userId) {
        return reply.status(401).send({ success: false, error: "Non autenticato", code: "UNAUTHORIZED" });
      }

      const { requestId } = request.params as { requestId?: string };
      if (!requestId) {
        return reply.status(400).send({ success: false, error: "requestId obbligatorio", code: "MISSING_REQUEST_ID" });
      }

      const rejected = await friendshipRepository.rejectRequest(requestId, userId);
      if (!rejected) {
        return reply.status(404).send({ success: false, error: "Richiesta non trovata", code: "REQUEST_NOT_FOUND" });
      }

      return reply.status(200).send({ success: true, message: "Richiesta rifiutata", data: rejected });
    } catch (error) {
      console.error("❌ Errore rejectRequest:", error);
      return reply.status(500).send({ success: false, error: "Errore interno", code: "FRIENDS_ERROR" });
    }
  }

  async getFriendProfile(request: FastifyRequest, reply: FastifyReply) {
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

      const isFriend = await friendshipRepository.hasAcceptedFriendship(userId, target.id);
      if (!isFriend) {
        return reply.status(403).send({ success: false, error: "Profilo visibile solo agli amici", code: "FRIENDSHIP_REQUIRED" });
      }

      const cards = await databaseService.getUserLoyaltyCards(target.id);
      return reply.status(200).send({
        success: true,
        data: {
          id: target.id,
          publicId: target.public_id,
          name: target.name,
          profileImage: target.profile_image ?? null,
          createdAt: target.created_at,
          stats: {
            cardsCount: cards.length,
            totalAvailablePoints: cards.reduce((sum, card) => sum + (card.availablePoints || 0), 0),
            totalFrozenPoints: cards.reduce((sum, card) => sum + (card.frozenPoints || 0), 0),
          },
          bars: cards.slice(0, 5).map((card) => ({
            barId: card.barId,
            barName: card.barName,
            availablePoints: card.availablePoints,
          })),
        },
      });
    } catch (error) {
      console.error("❌ Errore getFriendProfile:", error);
      return reply.status(500).send({ success: false, error: "Errore interno", code: "FRIENDS_ERROR" });
    }
  }

}

export const friendsController = new FriendsController();
