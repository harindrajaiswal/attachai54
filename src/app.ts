import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import { ZodError } from 'zod';
import type { Env } from './config/env.js';
import { SqliteRepository } from './repositories/sqlite.js';
import { SupabaseRepository } from './repositories/supabase.js';
import { LocalStorage, SupabaseStorage } from './providers/storage.js';
import { LocalEmbedding, OpenAIEmbedding } from './providers/embedding.js';
import { LocalVector, QdrantVector, SupabaseVector } from './providers/vector.js';
import { createLlmProvider } from './providers/llm.js';
import {
  OutboxNotification,
  SmtpNotification,
  SupabaseOutboxNotification,
} from './providers/notification.js';
import { ClientService } from './services/clients.js';
import { KnowledgeService } from './services/knowledge.js';
import { ChatService } from './services/chat.js';
import { Metrics } from './lib/metrics.js';
import { AppError } from './lib/errors.js';
import { adminRoutes } from './routes/admin.js';
import { publicRoutes } from './routes/public.js';
import { systemRoutes } from './routes/system.js';
export async function buildApp(env: Env) {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'test'
        ? false
        : {
            level: 'info',
            redact: [
              'req.headers.x-api-key',
              'req.headers.x-admin-api-key',
              'req.headers.authorization',
            ],
          },
    bodyLimit: 1024 * 1024,
    requestTimeout: 30000,
  });
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_ANON_KEY;
  const repo =
    env.DATABASE_PROVIDER === 'supabase'
      ? new SupabaseRepository(env.SUPABASE_URL!, supabaseKey)
      : new SqliteRepository(path.join(env.DATA_DIR, 'metadata.sqlite'));
  await repo.init();
  const storage =
    env.STORAGE_PROVIDER === 'supabase'
      ? new SupabaseStorage(env.SUPABASE_URL!, env.SUPABASE_STORAGE_BUCKET, supabaseKey)
      : new LocalStorage(path.join(env.DATA_DIR, 'objects'));
  const embedding =
    env.EMBEDDING_PROVIDER === 'openai'
      ? new OpenAIEmbedding(env.OPENAI_BASE_URL, env.OPENAI_API_KEY, env.OPENAI_EMBEDDING_MODEL)
      : new LocalEmbedding();
  const vector =
    env.VECTOR_PROVIDER === 'qdrant'
      ? new QdrantVector(env.QDRANT_URL, env.QDRANT_API_KEY)
      : env.VECTOR_PROVIDER === 'supabase'
        ? new SupabaseVector(env.SUPABASE_URL!, supabaseKey)
        : new LocalVector(path.join(env.DATA_DIR, 'vectors.json'));
  const llm = createLlmProvider(env.llm);
  const notification =
    env.NOTIFICATION_PROVIDER === 'smtp'
      ? new SmtpNotification({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          user: env.SMTP_USER,
          pass: env.SMTP_PASS,
          from: env.SMTP_FROM,
        })
      : env.NOTIFICATION_PROVIDER === 'supabase'
        ? new SupabaseOutboxNotification(env.SUPABASE_URL!, env.SUPABASE_OUTBOX_TABLE, supabaseKey)
        : new OutboxNotification(path.join(env.DATA_DIR, 'outbox'));
  const metrics = new Metrics();
  const clients = new ClientService(repo, storage, vector, env.PUBLIC_BASE_URL);
  const knowledge = new KnowledgeService(storage, embedding, vector, repo);
  const chat = new ChatService(repo, embedding, vector, llm);
  const ctx = {
    env,
    repo,
    storage,
    embedding,
    vector,
    llm,
    notification,
    metrics,
    clients,
    knowledge,
    chat,
  };
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
  });
  await app.register(cors, {
    delegator: (req, cb) => {
      const publicRequest = req.url === '/v1' || req.url.startsWith('/v1/');
      cb(null, {
        origin: publicRequest
          ? true
          : (origin, originCb) => {
              if (!origin || env.NODE_ENV !== 'production' || env.CORS_ORIGINS.includes(origin))
                originCb(null, true);
              else originCb(null, false);
            },
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
        allowedHeaders: ['content-type', 'x-admin-api-key', 'x-api-key'],
      });
    },
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 10, parts: 15 } });
  await app.register(staticPlugin, {
    root: path.resolve('public'),
    prefix: '/',
    setHeaders: (res, pathName) => {
      if (pathName.endsWith('widget.js')) {
        res.header('Cross-Origin-Resource-Policy', 'cross-origin');
        res.header('Cache-Control', 'no-store');
      }

      if (pathName.endsWith('admin/index.html')) {
        res.header('Cache-Control', 'no-store');
      }
    },
  });
  app.addHook('onRequest', async (req) => {
    (req as typeof req & { startedAt: number }).startedAt = Date.now();
  });
  app.addHook('onResponse', async (req, reply) =>
    metrics.record(
      Date.now() - (req as typeof req & { startedAt: number }).startedAt,
      reply.statusCode,
    ),
  );
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: e.issues.map((x) => ({ path: x.path.join('.'), message: x.message })),
        },
      });
    if (e instanceof AppError)
      return reply.code(e.statusCode).send({ error: { code: e.code, message: e.message } });
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE')
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
    app.log.error({ err: e }, 'request failed');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred' } });
  });
  await systemRoutes(app, ctx);
  await app.register(async (a) => adminRoutes(a, ctx), { prefix: '/admin' });
  await app.register(async (a) => publicRoutes(a, ctx), { prefix: '/v1' });
  app.addHook('onClose', async () => repo.close());
  return app;
}
