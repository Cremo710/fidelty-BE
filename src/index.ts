// 1. Log iniziale per confermare l'avvio
console.log("🔍 1. Inizio esecuzione script");

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { config } from "dotenv";
import multipart from "@fastify/multipart";
import { databaseService } from "./services/databaseService.js";
import pg from "pg";
const { Client } = pg;

// Load environment variables
try {
  config();
  console.log("✅ .env caricato correttamente");
} catch (error) {
  console.error("❌ Errore nel caricamento del file .env:", error);
}

// Types
type ServerConfig = {
  port: number;
  host: string;
  nodeEnv: "development" | "production" | "test";
};

// Configuration
const CONFIG: ServerConfig = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || "0.0.0.0",
  nodeEnv: (process.env.NODE_ENV as ServerConfig["nodeEnv"]) || "development",
};

// Verifica che le dipendenze siano caricate correttamente
// async function checkDependencies() {
//   try {
//     // La sintassi corretta ora usa 'with' al posto di 'assert'
//     await import("fastify/package.json", { with: { type: "json" } });
//     await import("@fastify/cors/package.json", { with: { type: "json" } });
//     await import("dotenv/package.json", { with: { type: "json" } });
//     console.log("✅ Dipendenze verificate");
//   } catch (error) {
//     console.error("❌ Errore durante la verifica delle dipendenze:", error);
//     // process.exit(1); // Valuta se bloccare davvero il server per questo
//   }
// }

// Esegui la verifica delle dipendenze
// await checkDependencies();

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

  // Health check endpoint
  // app.get('/api/health', async () => ({
  //   status: 'ok',
  //   timestamp: new Date().toISOString(),
  //   uptime: process.uptime(),
  //   environment: CONFIG.nodeEnv,
  // }));

  // Example endpoint
  // app.get('/api/hello', async () => ({
  //   message: 'Hello from Loyalty Bar API',
  //   timestamp: new Date().toISOString(),
  //   environment: CONFIG.nodeEnv,
  // }));

  // Database setup

  // Configura il database (la stringa la prende da Render)
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  client
    .connect()
    .then(() => {
      console.log("✅ Connessione al database stabilita con successo!");

      // Test rapido: chiediamo al database l'ora attuale
      return client.query("SELECT NOW()");
    })
    .then((res: any) => {
      console.log("⏱️ Risposta dal DB (Ora server):", res.rows[0].now);
    })
    .catch((err: any) => {
      console.error("❌ Errore critico di connessione al database:");
      console.error("Dettaglio:", err.message);

      // Suggerimento utile nei log
      if (!process.env.DATABASE_URL) {
        console.error(
          "👉 ATTENZIONE: La variabile DATABASE_URL non è definita su Render!",
        );
      }
    });

  // User registration endpoint
  app.post("/api/auth/register", async (request, reply) => {
    try {
      console.log("👤 Ricevuta richiesta di registrazione utente");

      const body = request.body as any;

      if (!body || !body.email || !body.password || !body.name) {
        return reply.status(400).send({
          success: false,
          error: "Email, password e name sono obbligatori",
          code: "MISSING_FIELDS",
        });
      }

      console.log(`🔐 Tentativo di salvataggio utente: ${body.email}`);

      try {
        const userId = await databaseService.saveUser({
          name: body.name,
          email: body.email,
          password: body.password, // NOTE: password salvata in chiaro per ora
        });

        return reply.status(201).send({
          success: true,
          message: "Utente registrato con successo",
          data: {
            id: userId,
            email: body.email,
            name: body.name,
          },
        });
      } catch (dbError: any) {
        console.error("❌ Errore DB durante la registrazione:", dbError.message || dbError);

        // Handle unique violation (Postgres error code 23505) if needed
        if (dbError && dbError.code === "23505") {
          return reply.status(409).send({
            success: false,
            error: "Email già registrata",
            code: "EMAIL_EXISTS",
          });
        }

        return reply.status(500).send({
          success: false,
          error: dbError instanceof Error ? dbError.message : "Errore durante il salvataggio",
          code: "REGISTRATION_ERROR",
        });
      }
    } catch (error) {
      console.error("❌ Errore durante la registrazione dell'utente:", error);

      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";

      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "REGISTRATION_ERROR",
      });
    }
  });

  // User login endpoint
  app.post("/api/auth/login", async (request, reply) => {
    try {
      console.log("🔑 Ricevuta richiesta di login");

      const body = request.body as any;

      if (!body || !body.email || !body.password) {
        return reply.status(400).send({
          success: false,
          error: "Email e password sono obbligatori",
          code: "MISSING_FIELDS",
        });
      }

      const user = await databaseService.getUserByEmail(body.email);

      if (!user) {
        return reply.status(404).send({
          success: false,
          error: "Utente non trovato",
          code: "USER_NOT_FOUND",
        });
      }

      // Nota: password salvata in chiaro per ora
      if (user.password !== body.password) {
        return reply.status(401).send({
          success: false,
          error: "Credenziali non valide",
          code: "INVALID_CREDENTIALS",
        });
      }

      return reply.status(200).send({
        success: true,
        message: "Login avvenuto con successo",
        data: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      });
    } catch (error) {
      console.error("❌ Errore durante il login:", error);
      const errorMessage = error instanceof Error ? error.message : "Errore sconosciuto";
      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "LOGIN_ERROR",
      });
    }
  });

  // Receipt processing endpoint
  app.post("/api/receipts/process", async (request, reply) => {
    try {
      console.log("📸 Ricevuta richiesta di elaborazione ricevuta");

      const data = await request.file();

      if (!data) {
        return reply.status(400).send({
          error: "Nessun file caricato",
          code: "MISSING_FILE",
        });
      }

      const filename = data.filename || "receipt.jpg";
      const extension = filename.toLowerCase().split(".").pop();
      const isCompressible = ["jpg", "jpeg", "png"].includes(extension || "");
      const MAX_INITIAL_SIZE = 20 * 1024 * 1024; // 20MB

      // Leggi il file in chunks per controllare la dimensione
      console.log("📖 Lettura file in progress...");
      const chunks: Buffer[] = [];
      let totalSize = 0;

      for await (const chunk of data.file) {
        chunks.push(chunk);
        totalSize += chunk.length;

        // Se supera 20MB e non è compressibile, ferma subito
        if (totalSize > MAX_INITIAL_SIZE && !isCompressible) {
          throw new Error(
            "File troppo grande (>20MB) e non è un'immagine compressibile (JPG/PNG)",
          );
        }
      }

      let buffer = Buffer.concat(chunks) as Buffer<ArrayBuffer>;
      console.log(
        `📦 Dimensione file originale: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
      );

      // Se il file supera 20MB e è un'immagine, comprimilo
      if (buffer.length > MAX_INITIAL_SIZE && isCompressible) {
        console.log("⚠️  File supera 20MB, compressione in corso...");
        const { taggunService: tgService } = await import(
          "./services/taggunService.js"
        );
        buffer = (await tgService["compressImage"](
          buffer,
          extension || "jpeg",
        )) as Buffer<ArrayBuffer>;
        console.log(
          `✅ Immagine compressa: ${(buffer.length / 1024 / 1024).toFixed(2)}MB`,
        );
      }

      console.log(`📁 File elaborato: ${filename} (${buffer.length} bytes)`);

      // Importa il servizio Taggun
      const { taggunService } = await import("./services/taggunService.js");

      // Valida il file
      await taggunService.validateImageFile(buffer, filename);

      // Processa la ricevuta
      const result = await taggunService.processReceipt(buffer, filename);

      //TODO: aggiungere controllo sulla validità della ricevuta (es. partitaIVA che deve corrispondere a quelle del BAR, prezzo, data/orario, numeroDocumento, indirizzo etc.)
      //TODO: aggiungere controllo su eventuali duplicati (check su DB)
      //TODO: salvataggio della ricevuta sul DB

      console.log("Result:", result);
      console.log(
        `✅ Ricevuta elaborata con successo: ${result.merchantName || "Merchant sconosciuto"}`,
      );

      return reply.status(200).send({
        success: true,
        data: result,
        message: "Ricevuta elaborata con successo",
      });
    } catch (error) {
      console.error("❌ Errore durante l'elaborazione della ricevuta:", error);

      const errorMessage =
        error instanceof Error ? error.message : "Errore sconosciuto";

      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: "PROCESSING_ERROR",
      });
    }
  });

  // Receipt confirm endpoint
  app.post("/api/receipts/confirm", async (request, reply) => {
    try {
      const data = request.body;

      console.log("📋 Ricevuta richiesta di conferma ricevuta");
      console.log("Dati ricevuti:", data);

      // Salva i dati della ricevuta nel database
      const receiptId = await databaseService.saveReceipt(data);

      return reply.status(200).send({
        status: "OK",
        receiptId: receiptId,
        message: "Ricevuta salvata con successo",
      });
    } catch (error) {
      console.error("❌ Errore durante la conferma della ricevuta:", error);

      const errorMessage =
        error instanceof Error ? error.message : "Errore sconosciuto";

      return reply.status(500).send({
        status: "ERROR",
        error: errorMessage,
      });
    }
  });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    app.log.info("SIGTERM signal received: closing HTTP server");
    await app.close();
    process.exit(0);
  });

  return app;
}

// Start the server
async function startServer() {
  try {
    console.log("🔄 Inizializzazione server in corso...");
    console.log("🔍 5. Creazione istanza server...");

    let app;
    try {
      console.log("🔍 5.1 Creazione server in corso...");
      app = await createServer();
      console.log("✅ Server creato con successo");

      // Inizializza il database
      console.log("🔍 5.2 Inizializzazione database...");
      await databaseService.initializeTables();
      console.log("✅ Database inizializzato");

      // Aggiungi un gestore per la radice
      app.get("/", async (request, reply) => {
        return {
          message: "Benvenuto nel server di Loyalty Bar",
          endpoints: {
            health: "/api/health",
            example: "/api/hello",
            receiptProcessing: "/api/receipts/process",
          },
        };
      });

      console.log("🔍 6. Avvio server in ascolto...");
    } catch (error) {
      console.error("❌ Errore durante la creazione del server:", error);
      process.exit(1);
    }

    // Aggiungi un gestore per le richieste in entrata
    app.addHook("onRequest", async (request, reply) => {
      console.log(`📥 ${request.method} ${request.url}`);
    });

    // Gestisce l'evento di avvio
    app.addHook("onReady", () => {
      console.log("✅ Server pronto!");
    });

    // Gestisce l'evento di errore
    app.addHook("onError", (request, reply, error, done) => {
      console.error("❌ Errore durante la richiesta:", error);
      done();
    });

    console.log(`🔌 Tentativo di avvio su porta ${CONFIG.port}...`);

    console.log(`🔍 7. Avvio server su ${CONFIG.host}:${CONFIG.port}...`);
    let address;
    // Avvia il server
    console.log(`🔍 7. Tentativo di avvio su ${CONFIG.host}:${CONFIG.port}...`);
    try {
      address = await app.listen({
        port: CONFIG.port,
        host: CONFIG.host,
      });
      console.log(`✅ Server in ascolto su ${address}`);
    } catch (err: any) {
      const error = err as NodeJS.ErrnoException;
      console.error("❌ Errore durante l'avvio del server:", error);
      if (error.code === "EADDRINUSE") {
        console.error(`⚠️  La porta ${CONFIG.port} è già in uso!`);
      }
      process.exit(1);
    }

    console.log(`\n🎉 Server avviato con successo!`);
    console.log(`🌐 URL: ${CONFIG.host}:${CONFIG.port}`);

    return app;
  } catch (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
}

// Esporta le funzioni e la configurazione
export { createServer, startServer, CONFIG };

// Avvia il server solo se il file viene eseguito direttamente
// e non quando viene importato come modulo
const isMain =
  import.meta.url.endsWith("index.ts") ||
  (process.argv[1] && process.argv[1].endsWith("index.ts")) ||
  import.meta.url.endsWith("index.js") ||
  (process.argv[1] && process.argv[1].endsWith("index.js"));

if (isMain) {
  console.log("🚀 Avvio del server...");
  startServer().catch((err) => {
    console.error("❌ Errore durante l'avvio del server:", err);
    process.exit(1);
  });
}
