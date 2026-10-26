import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Context } from './context.js';
import { hashKey, originMatches } from '../lib/security.js';
import { AppError } from '../lib/errors.js';
import { chatSchema, leadSchema } from '../domain/schemas.js';

type TenantRequest = FastifyRequest & { tenantId: string };
export async function publicRoutes(app: FastifyInstance, c: Context) {
  const tenant = async (req: FastifyRequest) => {
    const key = req.headers['x-api-key'],
      origin = req.headers.origin;
    if (typeof key !== 'string')
      throw new AppError(401, 'INVALID_API_KEY', 'Valid public client credential required');
    const client = await c.repo.getClientByKeyHash(hashKey(key));
    if (!client?.enabled)
      throw new AppError(401, 'INVALID_API_KEY', 'Valid public client credential required');
    if (typeof origin !== 'string' || !originMatches(origin, await c.repo.domains(client.id)))
      throw new AppError(403, 'ORIGIN_FORBIDDEN', 'Origin is not allowed');
    (req as TenantRequest).tenantId = client.id;
  };
  app.addHook('preHandler', tenant);
  app.get('/config', async (req) => {
    const x = await c.repo.getClient((req as TenantRequest).tenantId);
    if (!x) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    return {
      clientName: x.name,
      assistantName: x.config.assistantName,
      welcomeMessage: x.config.welcomeMessage,
      widget: x.config.widget ?? {},
      theme: x.config.theme ?? {},
    };
  });
  app.post('/chat', async (req) => {
    const b = chatSchema.parse(req.body);
    return c.chat.chat((req as TenantRequest).tenantId, b.message, b.sessionId);
  });
  app.post('/chat/stream', async (req, reply) => {
    const b = chatSchema.parse(req.body);
    // Hijacking bypasses Fastify's normal response hooks, so preserve the
    // already-authorized exact origin for browser-readable tenant streaming.
    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      reply.raw.setHeader('access-control-allow-origin', origin);
      reply.raw.setHeader('vary', 'Origin');
    }
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('cache-control', 'no-cache, no-transform');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.flushHeaders?.();
    try {
      const result = await c.chat.stream(
        (req as TenantRequest).tenantId,
        b.message,
        b.sessionId,
        (token) => {
          reply.raw.write(`event: token\ndata: ${JSON.stringify({ token })}\n\n`);
        },
      );
      reply.raw.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
    } catch (error) {
      const detail =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: typeof error, message: String(error), stack: undefined };
      app.log.error(
        {
          route: 'POST /chat/stream',
          requestId: req.id,
          question: b.message.slice(0, 500),
          error: detail,
        },
        'stream request failed after route dispatch',
      );
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ message: 'Unable to complete the response' })}\n\n`,
      );
    } finally {
      reply.raw.end();
    }
  });
  app.post('/leads', async (req) => {
    const b = leadSchema.parse(req.body);
    const tid = (req as TenantRequest).tenantId;
    const client = await c.repo.getClient(tid);
    if (!client?.enabled) throw new AppError(403, 'TENANT_DISABLED', 'Tenant is disabled');
    const { conversationId, ...rawData } = b;
    const data = Object.fromEntries(
      Object.entries(rawData).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    for (const value of Object.values(data)) {
      if (/\r|\n/.test(value))
        throw new AppError(400, 'INVALID_LEAD', 'Lead fields contain invalid characters');
    }
    if (conversationId && !(await c.repo.conversationForClient(tid, conversationId)))
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    const destination = client.config.notificationEmail ?? client.config.teamEmail;
    if (!destination && c.notification.name === 'smtp')
      throw new AppError(503, 'LEAD_DELIVERY_UNAVAILABLE', 'Lead delivery is not configured');
    const id = await c.repo.saveLead(tid, conversationId, data);
    try {
      await c.notification.notify(
        destination,
        `New lead for ${client.name}`,
        {
          id,
          client: client.name,
          receivedAt: new Date().toISOString(),
          name: data.name,
          email: data.email,
          message: data.message ?? data.requirement,
          phone: data.phone,
        },
        tid,
        { replyTo: data.email },
      );
    } catch {
      throw new AppError(
        503,
        'LEAD_DELIVERY_FAILED',
        'Unable to send your message. Please try again.',
      );
    }
    await c.repo.audit(tid, 'lead.created', { leadId: id });
    return { id, status: 'accepted' };
  });
}
