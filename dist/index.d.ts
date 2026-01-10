import Fastify, { FastifyInstance } from 'fastify';
type ServerConfig = {
    port: number;
    host: string;
    nodeEnv: 'development' | 'production' | 'test';
};
declare const CONFIG: ServerConfig;
declare function createServer(): Promise<FastifyInstance>;
declare function startServer(): Promise<Fastify.FastifyInstance<Fastify.RawServerDefault, import("http").IncomingMessage, import("http").ServerResponse<import("http").IncomingMessage>, Fastify.FastifyBaseLogger, Fastify.FastifyTypeProviderDefault>>;
export { createServer, startServer, CONFIG };
