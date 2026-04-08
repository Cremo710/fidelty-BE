import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { config } from "dotenv";
import multipart from "@fastify/multipart";
import { databaseService } from "./services/databaseService.js";
import { authController } from "./controllers/authController.js";
import { receiptsController } from "./controllers/receiptsController.js";
import { barController } from "./controllers/barController.js";
import { loyaltyCardRepository } from "./repositories/loyaltyCardRepository.js";
import { userRepository } from "./repositories/userRepository.js";
import { offerController } from "./controllers/offerController.js";
import { openingHoursController } from "./controllers/openingHoursController.js";
import { visionController } from "./controllers/visionController.js";
import { friendsController } from "./controllers/friendsController.js";
import { businessRequestController } from "./controllers/businessRequestController.js";
import { authenticateToken } from "./middleware/authenticateToken.js";
import pg from "pg";

const { Client } = pg;

// ==================== CONFIGURATION ====================

// Load environment variables
config();

type ServerConfig = {
  port: number;
  host: string;
  nodeEnv: "development" | "production" | "test";
};

const CONFIG: ServerConfig = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || "0.0.0.0",
  nodeEnv: (process.env.NODE_ENV as ServerConfig["nodeEnv"]) || "development",
};

// Create Fastify server
async function createServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: CONFIG.nodeEnv === "development" ? "info" : "warn",
      // Formattazione di base per lo sviluppo
      ...(CONFIG.nodeEnv === "development" && {
        transport: {
          target: "pino-pretty",
          options: {
            translateTime: "HH:MM:ss Z",
            ignore: "pid,hostname",
          },
        },
      }),
    },
    disableRequestLogging: CONFIG.nodeEnv === "production",
  });

  // Plugins
  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow all in development, restrict in production
      if (CONFIG.nodeEnv === "development" || !origin) {
        return cb(null, true);
      }

      // Add your production domains here
      const allowedOrigins = [
        /^https?:\/\/localhost(:\d+)?$/, // Localhost with any port
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/, // 127.0.0.1 with any port
        // Add your production domain here, e.g.:
        // /^https?:\/\/yourdomain\.com$/,
      ].map((re) => new RegExp(re));

      if (allowedOrigins.some((re) => re.test(origin))) {
        return cb(null, true);
      }

      cb(new Error("Not allowed by CORS"), false);
    },
    credentials: true,
  });

  // Register multipart plugin for file uploads
  await app.register(multipart, {
    limits: {
      fileSize: 500 * 1024 * 1024, // 500MB limit (verrà compresso se > 20MB)
    },
  });

  // Rate limiting implementato manualmente nei controller tramite contatori

  // Root endpoint
  app.get("/", async () => ({
    message: "Benvenuto nel server di Loyalty Bar",
    status: "online",
    environment: CONFIG.nodeEnv,
  }));

  // Database connection test
  testDatabaseConnection();

  // ==================== AUTH ENDPOINTS ====================

  // User registration endpoint
  app.post("/api/auth/register", async (request, reply) => {
    return authController.register(request, reply);
  });

  // User login endpoint
  app.post("/api/auth/login", async (request, reply) => {
    return authController.login(request, reply);
  });

  // User logout endpoint
  app.post("/api/auth/logout", { onRequest: [authenticateToken] }, async (request, reply) => {
    return authController.logout(request, reply);
  });

  // Refresh access token endpoint (uses refresh token from body)
  app.post("/api/auth/refresh", async (request, reply) => {
    return authController.refreshToken(request, reply);
  });

  // Get user profile (protected route)
  app.get("/api/auth/profile", { onRequest: [authenticateToken] }, async (request, reply) => {
    return authController.getProfile(request, reply);
  });

  // Upload/update profile photo (protected route)
  app.patch("/api/auth/profile-photo", { onRequest: [authenticateToken] }, async (request, reply) => {
    return authController.uploadProfilePhoto(request, reply);
  });

  // ==================== USER SEARCH ENDPOINTS ====================

  // Search user by public_id (protected route)
  app.get("/api/users/search", { onRequest: [authenticateToken] }, async (request, reply) => {
    return authController.searchByPublicId(request, reply);
  });

  // ==================== BAR ENDPOINTS ====================

  // Bar registration endpoint (protected route)
  app.post("/api/bar/registration", { onRequest: [authenticateToken] }, async (request, reply) => {
    return barController.register(request, reply);
  });

  // Complete bar registration - atomic, no partial data (protected route)
  app.post("/api/bar/complete-registration", { onRequest: [authenticateToken] }, async (request, reply) => {
    return barController.completeRegistration(request, reply);
  });

  // Get bar profile (protected route)
  app.get("/api/bar/profile", { onRequest: [authenticateToken] }, async (request, reply) => {
    return barController.getBarByUser(request, reply);
  });

  // Update bar profile (protected route) - only editable fields
  app.patch("/api/bar/profile", { onRequest: [authenticateToken] }, async (request, reply) => {
    return barController.updateProfile(request, reply);
  });

  // Delete bar profile/subscription (protected route)
  app.delete("/api/bar/profile", { onRequest: [authenticateToken] }, async (request, reply) => {
    return barController.deleteProfile(request, reply);
  });

  // Public endpoint: list bars with coordinates for map preview
  app.get("/api/bars", async (request, reply) => {
    return barController.listBars(request, reply);
  });

  // Public endpoint: get offers for a specific bar
  app.get("/api/bars/:barId/offers", async (request, reply) => {
    return offerController.listOffersByBarId(request, reply);
  });

  // Public endpoint: get opening hours for a specific bar
  app.get("/api/bars/:barId/opening-hours", async (request, reply) => {
    return openingHoursController.getOpeningHoursByBarId(request, reply);
  });

  // ==================== BAR CARD CONFIG ENDPOINTS ====================

  // Update bar card configuration (Step 2 onboarding)
  app.patch("/api/bar/card-config", { onRequest: [authenticateToken] }, async (request, reply) => {
    return barController.updateCardConfig(request, reply);
  });

  // ==================== OFFERS ENDPOINTS ====================

  // Create a new offer
  app.post("/api/bar/offers", { onRequest: [authenticateToken] }, async (request, reply) => {
    return offerController.createOffer(request, reply);
  });

  // List offers for the authenticated bar owner
  app.get("/api/bar/offers", { onRequest: [authenticateToken] }, async (request, reply) => {
    return offerController.listOffers(request, reply);
  });

  // Update an offer
  app.put("/api/bar/offers/:id", { onRequest: [authenticateToken] }, async (request, reply) => {
    return offerController.updateOffer(request, reply);
  });

  // Delete an offer
  app.delete("/api/bar/offers/:id", { onRequest: [authenticateToken] }, async (request, reply) => {
    return offerController.deleteOffer(request, reply);
  });

  // ==================== OPENING HOURS ENDPOINTS ====================

  // Set opening hours (upsert)
  app.post("/api/bar/opening-hours", { onRequest: [authenticateToken] }, async (request, reply) => {
    return openingHoursController.setOpeningHours(request, reply);
  });

  // Get opening hours
  app.get("/api/bar/opening-hours", { onRequest: [authenticateToken] }, async (request, reply) => {
    return openingHoursController.getOpeningHours(request, reply);
  });

  // ==================== RECEIPT ENDPOINTS ====================

  // Receipt processing endpoint (OCR processing via Taggun)
  app.post("/api/receipts/process", async (request, reply) => {
    return receiptsController.processReceipt(request, reply);
  });

  // Receipt confirm endpoint (save to database)
  app.post("/api/receipts/confirm", { onRequest: [authenticateToken] }, async (request, reply) => {
    return receiptsController.confirmReceipt(request, reply);
  });

  // Loyalty cards endpoint for authenticated user
  app.get("/api/receipts/my-cards", { onRequest: [authenticateToken] }, async (request, reply) => {
    return receiptsController.getMyLoyaltyCards(request, reply);
  });

  // Delete a receipt and recalculate loyalty card (protected)
  app.delete("/api/receipts/:id", { onRequest: [authenticateToken] }, async (request, reply) => {
    return receiptsController.deleteReceipt(request, reply);
  });

  // Recalculate all loyalty cards from receipts (protected, admin utility)
  app.post("/api/receipts/recalculate-cards", { onRequest: [authenticateToken] }, async (request, reply) => {
    return receiptsController.recalculateCards(request, reply);
  });

  // ==================== FRIENDS ENDPOINTS ====================

  // Add a friend by public_id
  app.post("/api/friends/add", { onRequest: [authenticateToken] }, async (request, reply) => {
    return friendsController.addFriend(request, reply);
  });

  // Get friends list
  app.get("/api/friends", { onRequest: [authenticateToken] }, async (request, reply) => {
    return friendsController.getFriends(request, reply);
  });

  // Remove a friend
  app.delete("/api/friends/:publicId", { onRequest: [authenticateToken] }, async (request, reply) => {
    return friendsController.removeFriend(request, reply);
  });

  // ==================== BUSINESS REQUESTS ENDPOINTS ====================

  // Create a new business request (with optional document upload)
  app.post("/api/business-requests", { onRequest: [authenticateToken] }, async (request, reply) => {
    return businessRequestController.create(request, reply);
  });

  // Get the authenticated user's latest business request
  app.get("/api/business-requests/my", { onRequest: [authenticateToken] }, async (request, reply) => {
    return businessRequestController.getMyRequest(request, reply);
  });

  // List all business requests (admin)
  app.get("/api/business-requests", { onRequest: [authenticateToken] }, async (request, reply) => {
    return businessRequestController.listAll(request, reply);
  });

  // Approve or reject a business request (admin)
  app.patch("/api/business-requests/:id", { onRequest: [authenticateToken] }, async (request, reply) => {
    return businessRequestController.updateStatus(request, reply);
  });

  // ==================== VISION / OCR ENDPOINTS ====================

  // Extract text from image via Google Cloud Vision
  app.post("/api/vision/extract-text", { onRequest: [authenticateToken] }, async (request, reply) => {
    return visionController.extractText(request, reply);
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    app.log.info("SIGTERM signal received: closing HTTP server");
    await app.close();
    process.exit(0);
  });

  return app;
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Test database connection
 */
function testDatabaseConnection(): void {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  client
    .connect()
    .then(() => {
      console.log("✅ Connessione al database OK");
      return client.query("SELECT NOW()");
    })
    .then((res: any) => {
      console.log(`📅 Database time: ${res.rows[0].now}`);
      client.end();
    })
    .catch((err: any) => {
      console.error("❌ Errore di connessione al database:", err.message);
      if (!process.env.DATABASE_URL) {
        console.error("⚠️  DATABASE_URL non definita");
      }
    });
}

/**
 * Setup request/response logging and error handling
 */
function setupHooks(app: FastifyInstance): void {
  if (CONFIG.nodeEnv === "development") {
    app.addHook("onRequest", async (request) => {
      console.log(`📥 ${request.method} ${request.url}`);
    });
  }

  app.addHook("onError", (request, reply, error) => {
    console.error(`❌ [${request.method} ${request.url}] ${error.message}`);
  });
}

/**
 * Start the Fastify server
 */
async function startServer(): Promise<FastifyInstance> {
  try {
    console.log("🚀 Avvio server...");

    // Create server instance
    const app = await createServer();
    console.log("✅ Server creato");

    // Initialize database
    await databaseService.initializeTables();
    console.log("✅ Database inizializzato");

    // Backfill loyalty_cards dagli scontrini esistenti (idempotente, sicuro ad ogni avvio)
    try {
      await loyaltyCardRepository.backfillFromReceipts();
    } catch (err) {
      console.warn("⚠️ Backfill loyalty_cards fallito (non bloccante):", err);
    }

    // Backfill public_id per utenti che non ne hanno uno (idempotente)
    try {
      await userRepository.backfillPublicIds();
    } catch (err) {
      console.warn("⚠️ Backfill public_id fallito (non bloccante):", err);
    }

    // Setup hooks
    setupHooks(app);

    // Start listening
    const address = await app.listen({
      port: CONFIG.port,
      host: CONFIG.host,
    });

    console.log(`\n✨ Server pronto!`);
    console.log(`🌐 ${address}`);
    console.log(`🔧 Ambiente: ${CONFIG.nodeEnv}\n`);

    return app;
  } catch (err: any) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === "EADDRINUSE") {
      console.error(`❌ Porta ${CONFIG.port} già in uso`);
    } else {
      console.error("❌ Errore durante l'avvio:", error.message);
    }

    process.exit(1);
  }
}

// ==================== EXPORTS ====================

export { createServer, startServer, CONFIG };

// ==================== STARTUP ====================

// Start server if this file is executed directly
const isMain =
  import.meta.url.endsWith("index.ts") ||
  import.meta.url.endsWith("index.js") ||
  (process.argv[1] && (process.argv[1].endsWith("index.ts") || process.argv[1].endsWith("index.js")));

if (isMain) {
  startServer().catch((err) => {
    console.error("❌ Errore critico:", err.message);
    process.exit(1);
  });
}

