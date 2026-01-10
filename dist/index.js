import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from 'dotenv';
// Load environment variables
config();
// Configuration
const CONFIG = {
    port: Number(process.env.PORT || 4000),
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
};
// Create Fastify server
async function createServer() {
    const app = Fastify({
        logger: {
            level: CONFIG.nodeEnv === 'development' ? 'info' : 'warn',
            transport: CONFIG.nodeEnv === 'development' ? {
                target: 'pino-pretty',
                options: {
                    translateTime: 'HH:MM:ss Z',
                    ignore: 'pid,hostname',
                },
            } : undefined,
        },
        disableRequestLogging: CONFIG.nodeEnv === 'production',
    });
    // Plugins
    await app.register(cors, {
        origin: (origin, cb) => {
            // Allow all in development, restrict in production
            if (CONFIG.nodeEnv === 'development' || !origin) {
                return cb(null, true);
            }
            // Add your production domains here
            const allowedOrigins = [
                /^https?:\/\/localhost(:\d+)?$/, // Localhost with any port
                /^https?:\/\/127\.0\.0\.1(:\d+)?$/, // 127.0.0.1 with any port
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
        const app = await createServer();
        await app.listen({
            port: CONFIG.port,
            host: CONFIG.host,
        });
        console.log(`\n🚀 Server running at http://${CONFIG.host}:${CONFIG.port}`);
        console.log(`📊 Health check: http://${CONFIG.host}:${CONFIG.port}/api/health\n`);
        return app;
    }
    catch (err) {
        console.error('Error starting server:', err);
        process.exit(1);
    }
}
// Only start the server if this file is run directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    startServer().catch(console.error);
}
export { createServer, startServer, CONFIG };
//# sourceMappingURL=index.js.map