// 1. Log iniziale per confermare l'avvio
console.log('🔍 1. Inizio esecuzione script');

console.log('🔍 1.1 Prima di importare Fastify');
import Fastify, { FastifyInstance } from 'fastify';
console.log('✅ Fastify importato');

console.log('🔍 1.2 Prima di importare CORS');
import cors from '@fastify/cors';
console.log('✅ CORS importato');

console.log('🔍 1.3 Prima di importare dotenv');
import { config } from 'dotenv';
console.log('✅ dotenv importato');

console.log('🔍 1.4 Prima di importare multipart');
import multipart from '@fastify/multipart';
console.log('✅ multipart importato');

console.log('🔍 2. Import completati');

// Load environment variables
console.log('🔍 3. Caricamento variabili d\'ambiente...');
try {
  config();
  console.log('✅ .env caricato correttamente');
} catch (error) {
  console.error('❌ Errore nel caricamento del file .env:', error);
}

// Types
type ServerConfig = {
  port: number;
  host: string;
  nodeEnv: 'development' | 'production' | 'test';
};

// Configuration
const CONFIG: ServerConfig = {
  port: Number(process.env.PORT || 4000),
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: (process.env.NODE_ENV as ServerConfig['nodeEnv']) || 'development',
};

console.log('🔍 4. Configurazione:', {
  port: CONFIG.port,
  host: CONFIG.host,
  nodeEnv: CONFIG.nodeEnv
});

// Verifica che le dipendenze siano caricate correttamente
async function checkDependencies() {
  console.log('🔍 4.1 Verifica dipendenze...');
  
  try {
    // Usiamo import() dinamico per caricare i package.json
    const fastifyPkg = await import('fastify/package.json', { assert: { type: 'json' } });
    const corsPkg = await import('@fastify/cors/package.json', { assert: { type: 'json' } });
    const dotenvPkg = await import('dotenv/package.json', { assert: { type: 'json' } });

    console.log('- Fastify versione:', fastifyPkg.default.version);
    console.log('- @fastify/cors versione:', corsPkg.default.version);
    console.log('- dotenv versione:', dotenvPkg.default.version);
    console.log('✅ Dipendenze verificate');
  } catch (error) {
    console.error('❌ Errore durante la verifica delle dipendenze:', error);
    process.exit(1);
  }
}

// Esegui la verifica delle dipendenze
await checkDependencies();

// Create Fastify server
async function createServer(): Promise<FastifyInstance> {
  console.log('🔍 5. Creazione istanza Fastify...');
  const app = Fastify({
    logger: {
      level: CONFIG.nodeEnv === 'development' ? 'info' : 'warn',
      // Formattazione di base per lo sviluppo
      ...(CONFIG.nodeEnv === 'development' && {
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        },
      }),
    },
    disableRequestLogging: CONFIG.nodeEnv === 'production',
  });

  console.log('✅ Istanza Fastify creata');

  // Plugins
  console.log('🔍 6. Registrazione plugin CORS...');
  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow all in development, restrict in production
      if (CONFIG.nodeEnv === 'development' || !origin) {
        return cb(null, true);
      }

      // Add your production domains here
      const allowedOrigins = [
        /^https?:\/\/localhost(:\d+)?$/,  // Localhost with any port
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/,  // 127.0.0.1 with any port
        // Add your production domain here, e.g.:
        // /^https?:\/\/yourdomain\.com$/,
      ].map(re => new RegExp(re));

      if (allowedOrigins.some(re => re.test(origin))) {
        return cb(null, true);
      }

      cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
  });
  console.log('✅ Plugin CORS registrato');

  // Register multipart plugin for file uploads
  console.log('🔍 6.1 Registrazione plugin multipart...');
  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB limit
    },
  });
  console.log('✅ Plugin multipart registrato');

  // Health check endpoint
  app.get('/api/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: CONFIG.nodeEnv,
  }));

  // Example endpoint
  app.get('/api/hello', async () => ({
    message: 'Hello from Loyalty Bar API',
    timestamp: new Date().toISOString(),
    environment: CONFIG.nodeEnv,
  }));

  // Receipt processing endpoint
  app.post('/api/receipts/process', async (request, reply) => {
    try {
      console.log('📸 Ricevuta richiesta di elaborazione ricevuta');
      
      const data = await request.file();
      
      if (!data) {
        return reply.status(400).send({
          error: 'Nessun file caricato',
          code: 'MISSING_FILE'
        });
      }

      const buffer = await data.toBuffer();
      const filename = data.filename || 'receipt.jpg';

      console.log(`📁 File ricevuto: ${filename} (${buffer.length} bytes)`);

      // Importa il servizio Taggun
      const { taggunService } = await import('./services/taggunService.js');

      // Valida il file
      await taggunService.validateImageFile(buffer, filename);

      // Processa la ricevuta
      const result = await taggunService.processReceipt(buffer, filename);

      //TODO: aggiungere controllo sulla validità della ricevuta (es. partitaIVA che deve corrispondere a quelle del BAR, prezzo, data/orario, numeroDocumento, indirizzo etc.)
      //TODO: aggiungere controllo su eventuali duplicati (check su DB)
      //TODO: salvataggio della ricevuta sul DB

      console.log('Result:', result);
      console.log(`✅ Ricevuta elaborata con successo: ${result.merchantName || 'Merchant sconosciuto'}`);

      return reply.status(200).send({
        success: true,
        data: result,
        message: 'Ricevuta elaborata con successo'
      });

    } catch (error) {
      console.error('❌ Errore durante l\'elaborazione della ricevuta:', error);
      
      const errorMessage = error instanceof Error ? error.message : 'Errore sconosciuto';
      
      return reply.status(500).send({
        success: false,
        error: errorMessage,
        code: 'PROCESSING_ERROR'
      });
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    app.log.info('SIGTERM signal received: closing HTTP server');
    await app.close();
    process.exit(0);
  });

  return app;
}

// Start the server
async function startServer() {
  try {
    console.log('🔄 Inizializzazione server in corso...');
    console.log('🔍 5. Creazione istanza server...');

    let app;
    try {
      console.log('🔍 5.1 Creazione server in corso...');
      app = await createServer();
      console.log('✅ Server creato con successo');
      
      // Aggiungi un gestore per la radice
      app.get('/', async (request, reply) => {
        return { 
          message: 'Benvenuto nel server di Loyalty Bar',
          endpoints: {
            health: '/api/health',
            example: '/api/hello',
            receiptProcessing: '/api/receipts/process'
          }
        };
      });
      
      console.log('🔍 6. Avvio server in ascolto...');
    } catch (error) {
      console.error('❌ Errore durante la creazione del server:', error);
      process.exit(1);
    }
    
    // Aggiungi un gestore per le richieste in entrata
    app.addHook('onRequest', async (request, reply) => {
      console.log(`📥 ${request.method} ${request.url}`);
    });

    // Gestisce l'evento di avvio
    app.addHook('onReady', () => {
      console.log('✅ Server pronto!');
    });

    // Gestisce l'evento di errore
    app.addHook('onError', (request, reply, error, done) => {
      console.error('❌ Errore durante la richiesta:', error);
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
      console.log('🌐 URL disponibili:');
      console.log(`- http://localhost:${CONFIG.port}`);
      console.log(`- http://127.0.0.1:${CONFIG.port}`);
      console.log(`- http://${CONFIG.host}:${CONFIG.port}`);
    } catch (err: any) {
      const error = err as NodeJS.ErrnoException;
      console.error('❌ Errore durante l\'avvio del server:', error);
      if (error.code === 'EADDRINUSE') {
        console.error(`⚠️  La porta ${CONFIG.port} è già in uso!`);
      }
      process.exit(1);
    }

    console.log(`\n🎉 Server avviato con successo!`);
    console.log(`🌐 URL: http://${CONFIG.host}:${CONFIG.port}`);
    console.log(`🩺 Health check: http://${CONFIG.host}:${CONFIG.port}/api/health`);
    console.log(`👋 Endpoint di esempio: http://${CONFIG.host}:${CONFIG.port}/api/hello\n`);

    return app;
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
}

// Esporta le funzioni e la configurazione
export { createServer, startServer, CONFIG };

// Avvia il server solo se il file viene eseguito direttamente
// e non quando viene importato come modulo
const isMain = import.meta.url.endsWith('index.ts') || 
               (process.argv[1] && process.argv[1].endsWith('index.ts'));

if (isMain) {
  console.log('🚀 Avvio del server...');
  startServer().catch(err => {
    console.error('❌ Errore durante l\'avvio del server:', err);
    process.exit(1);
  });
}
