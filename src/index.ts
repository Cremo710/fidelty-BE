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

  // ==================== BAR ENDPOINTS ====================

  // Bar registration endpoint (protected route)
  app.post("/api/bar/registration", { onRequest: [authenticateToken] }, async (request, reply) => {
    return barController.register(request, reply);
  });

  // Get bar profile (protected route)
  app.get("/api/bar/profile", { onRequest: [authenticateToken] }, async (request, reply) => {
    return barController.getBarByUser(request, reply);
  });

  // Public endpoint: list bars with coordinates for map preview
  app.get("/api/bars", async (request, reply) => {
    return barController.listBars(request, reply);
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

