import type { FastifyInstance } from 'fastify';
import type { Context } from './context.js';
export async function systemRoutes(app: FastifyInstance, c: Context) {
  app.get('/health', async () => ({
    status: 'ok',
    providers: {
      database: await c.repo.health(),
      storage: await c.storage.health(),
      vector: await c.vector.health(),
      embedding: await c.embedding.health(),
      llm: await c.llm.health(),
      notification: await c.notification.health(),
    },
    ...c.metrics.snapshot(),
  }));
  app.get('/ready', async (_r, reply) => {
    const h = await Promise.all([
      c.repo.health(),
      c.storage.health(),
      c.vector.health(),
      c.embedding.health(),
      c.llm.health(),
      c.notification.health(),
    ]);
    const ready = h.every((x: { connected: boolean }) => x.connected);
    return reply.code(ready ? 200 : 503).send({ ready, providers: h });
  });
  app.get('/metrics', async (_r, reply) =>
    reply.type('text/plain; version=0.0.4').send(c.metrics.prometheus()),
  );
}
