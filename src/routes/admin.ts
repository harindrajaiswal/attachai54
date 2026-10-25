import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createClientSchema, configSchema } from '../domain/schemas.js';
import type { Context } from './context.js';
import { safeEqual, normalizeDomain } from '../lib/security.js';
import { AppError } from '../lib/errors.js';
import { z } from 'zod';
import { loadLlmConfig } from '../config/llm.js';
import { createLlmProvider } from '../providers/llm.js';
type LeadRow = Record<string, unknown> & { id: string; status: string; conversationId?: string };

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  q: z.string().max(120).default(''),
  status: z.enum(['all', 'active', 'suspended']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const leadPatch = z
  .object({
    status: z.enum(['new', 'contacted', 'qualified', 'won', 'lost']).optional(),
    assignee: z.string().max(120).nullable().optional(),
    notes: z.string().max(10000).optional(),
  })
  .strict();
const providerSchema = z
  .object({
    provider: z.enum([
      'local',
      'nvidia',
      'openai',
      'openrouter',
      'groq',
      'together',
      'deepseek',
      'custom',
      'azure',
    ]),
    baseUrl: z.string().url().optional(),
    model: z.string().max(200).optional(),
    apiKey: z.string().min(1).max(1000).optional(),
    temperature: z.number().min(0).max(2).default(0),
    maxTokens: z.number().int().min(1).max(100000).optional(),
  })
  .strict();
const presets: Record<string, string> = {
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  deepseek: 'https://api.deepseek.com/v1',
};
export async function adminRoutes(app: FastifyInstance, c: Context) {
  const auth = async (req: FastifyRequest) => {
    const key = req.headers['x-admin-api-key'];
    if (typeof key !== 'string' || !safeEqual(key, c.env.ADMIN_API_KEY))
      throw new AppError(401, 'ADMIN_UNAUTHORIZED', 'Admin authentication required');
  };
  app.addHook('preHandler', auth);
  app.post('/auth/validate', async () => ({ authenticated: true }));
  app.get('/overview', async () => ({
    ...((await c.repo.overview()) as Record<string, unknown>),
    recentAudits: await c.repo.audits(12),
    providers: {
      llm: c.llm.name,
      vector: (await c.vector.health()).provider,
      embedding: c.embedding.name,
    },
  }));
  app.post('/clients', async (req) => {
    const result = await c.clients.create(createClientSchema.parse(req.body));

    return result;
  });
  app.get('/clients', async (req) => {
    const raw = req.query as Record<string, unknown>,
      q = listQuery.parse(raw);
    const all = (await c.repo.listClients())
      .filter(
        (x) =>
          (!q.q ||
            `${x.name} ${x.slug} ${x.config.teamEmail ?? ''}`
              .toLowerCase()
              .includes(q.q.toLowerCase())) &&
          (q.status === 'all' || x.enabled === (q.status === 'active')),
      )
      .map(async (x) => {
        const [domains, key] = await Promise.all([c.repo.domains(x.id), c.repo.keyStatus(x.id)]);
        return {
          ...x,
          domains,
          apiKey: { enabled: Boolean(key?.enabled), createdAt: key?.created_at },
        };
      });
    const resolved = await Promise.all(all);
    if (!Object.keys(raw).length) return resolved;
    return {
      items: resolved.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
      total: resolved.length,
      page: q.page,
      pageSize: q.pageSize,
    };
  });
  app.get('/clients/:id', async (req) => {
    const { id } = idParams.parse(req.params),
      x = await c.repo.getClient(id);
    if (!x) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    return {
      ...x,
      domains: await c.repo.domains(id),
      stats: await c.repo.stats(id),
      apiKey: await c.repo
        .keyStatus(id)
        .then((key) => ({ enabled: Boolean(key?.enabled), createdAt: key?.created_at })),
    };
  });
  app.patch('/clients/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        enabled: z.boolean().optional(),
        prompt: z.string().min(1).max(20000).optional(),
        config: configSchema.optional(),
        domains: z.array(z.string()).min(1).max(30).optional(),
      })
      .strict()
      .parse(req.body);
    if (!(await c.repo.getClient(id))) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    if (body.domains) await c.repo.setDomains(id, body.domains.map(normalizeDomain));
    if (body.prompt) await c.repo.savePromptVersion(id, (await c.repo.getClient(id))!.prompt);
    const x = await c.repo.updateClient(id, body);
    await c.repo.audit(id, 'client.updated', { fields: Object.keys(body) });
    return x;
  });
  app.delete('/clients/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    if (!(await c.clients.remove(id))) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    return reply.code(204).send();
  });
  app.post('/clients/:id/duplicate', async (req) => {
    const { id } = idParams.parse(req.params),
      old = await c.repo.getClient(id);
    if (!old) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    const body = z
      .object({
        name: z.string().min(1).max(120),
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
      })
      .parse(req.body);
    return await c.clients.create({
      name: body.name,
      slug: body.slug,
      domains: await c.repo.domains(id),
      config: old.config,
      prompt: old.prompt,
    });
  });
  app.post('/clients/:id/rotate-key', async (req) => {
    const { id } = idParams.parse(req.params),
      credentials = await c.clients.rotate(id);

    if (!credentials) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    return credentials;
  });
  app.post('/clients/:id/key/:action', async (req) => {
    const { id } = idParams.parse(req.params),
      { action } = z.object({ action: z.enum(['disable', 'enable']) }).parse(req.params);
    if (!(await c.repo.setKeyEnabled(id, action === 'enable')))
      throw new AppError(404, 'NOT_FOUND', 'Client not found');
    await c.repo.audit(id, `key.${action}d`, {});
    return { enabled: action === 'enable' };
  });
  app.get(
    '/clients/:id/prompts/history',
    async (req) => await c.repo.promptVersions(idParams.parse(req.params).id),
  );
  app.post('/clients/:id/prompts/:versionId/restore', async (req) => {
    const { id } = idParams.parse(req.params),
      { versionId } = z.object({ versionId: z.string().uuid() }).parse(req.params),
      v = await c.repo.promptVersion(versionId);
    if (!v || v.client_id !== id) throw new AppError(404, 'NOT_FOUND', 'Prompt version not found');
    const current = await c.repo.getClient(id);
    if (!current) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    await c.repo.savePromptVersion(id, current.prompt);
    return await c.repo.updateClient(id, { prompt: v.prompt });
  });
  app.post('/clients/:id/prompts/reset', async (req) => {
    const { id } = idParams.parse(req.params),
      x = await c.repo.getClient(id);
    if (!x) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    await c.repo.savePromptVersion(id, x.prompt);
    return await c.repo.updateClient(id, {
      prompt:
        'Answer using only the supplied knowledge. If the answer is unavailable, use the configured fallback message.',
    });
  });
  app.post('/clients/:id/prompts/preview', async (req) => {
    const { id } = idParams.parse(req.params),
      body = z
        .object({ question: z.string().min(1).max(1000), prompt: z.string().min(1).max(20000) })
        .parse(req.body),
      x = await c.repo.getClient(id);
    if (!x) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    const preview = await c.chat.preview(id, body.question, body.prompt);
    const context = preview.retrieval.evidence;
    req.log.info({ clientId: id, retrievedChunks: context.length, status: preview.retrieval.decision.status, sources: context.map((chunk) => chunk.source) }, 'prompt preview retrieval');
    const sources = context.map((chunk) => ({ source: chunk.source, score: Math.round(chunk.score * 1000) / 1000, chunkId: chunk.id }));
    return { answer: preview.answer, retrieval: { count: context.length, sources }, sources };
  });
  app.post('/clients/:id/prompt', async (req) => {
    const { id } = idParams.parse(req.params),
      x = await c.repo.getClient(id);
    if (!x) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    const part = await req.file({ limits: { fileSize: 256 * 1024, files: 1 } });
    if (!part || !/[.](txt|md)$/i.test(part.filename))
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Prompt must be TXT or MD');
    const prompt = (await part.toBuffer()).toString('utf8').trim();
    if (!prompt) throw new AppError(400, 'VALIDATION_ERROR', 'Prompt cannot be empty');
    await c.repo.savePromptVersion(id, x.prompt);
    await c.repo.updateClient(id, { prompt });
    return { updated: true };
  });
  app.post('/clients/:id/config', async (req) => {
    const { id } = idParams.parse(req.params);
    if (!(await c.repo.getClient(id))) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    const part = await req.file({ limits: { fileSize: 64 * 1024, files: 1 } });
    if (!part || !/[.]json$/i.test(part.filename))
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Config must be JSON');
    let raw: unknown;
    try {
      raw = JSON.parse((await part.toBuffer()).toString('utf8'));
    } catch {
      throw new AppError(400, 'VALIDATION_ERROR', 'Config is not valid JSON');
    }
    const config = configSchema.parse(raw);
    await c.repo.updateClient(id, { config });
    return { updated: true, config };
  });
  app.post('/clients/:id/knowledge', async (req) => {
    const { id } = idParams.parse(req.params);
    if (!(await c.repo.getClient(id))) throw new AppError(404, 'NOT_FOUND', 'Client not found');
    const results = [];
    for await (const part of req.parts()) {
      if (part.type === 'file')
        results.push(await c.knowledge.upload(id, part.filename, await part.toBuffer()));
    }
    if (!results.length) throw new AppError(400, 'FILE_REQUIRED', 'At least one file is required');
    return results.length === 1 ? results[0] : { items: results };
  });
  app.get('/clients/:id/knowledge', async (req) => c.knowledge.list(idParams.parse(req.params).id));
  app.delete('/clients/:id/knowledge/:filename', async (req) => {
    const { id } = idParams.parse(req.params),
      { filename } = z.object({ filename: z.string().min(1) }).parse(req.params);
    return c.knowledge.remove(id, decodeURIComponent(filename));
  });
  app.post('/clients/:id/knowledge/rebuild', async (req) =>
    c.knowledge.rebuild(idParams.parse(req.params).id),
  );
  app.get('/clients/:id/leads', async (req) => {
    const { id } = idParams.parse(req.params),
      raw = req.query as Record<string, unknown>,
      q = z
        .object({
          q: z.string().default(''),
          status: z.string().default('all'),
          page: z.coerce.number().int().positive().default(1),
          pageSize: z.coerce.number().int().min(1).max(500).default(25),
        })
        .parse(raw);
    const resolved = ((await c.repo.listLeads(id)) as LeadRow[]).filter(
      (x) =>
        (q.status === 'all' || x.status === q.status) &&
        (!q.q || JSON.stringify(x).toLowerCase().includes(q.q.toLowerCase())),
    );
    if (!Object.keys(raw).length) return resolved;
    return {
      items: resolved.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
      total: resolved.length,
      page: q.page,
      pageSize: q.pageSize,
    };
  });
  app.patch('/clients/:id/leads/:leadId', async (req) => {
    const { id } = idParams.parse(req.params),
      { leadId } = z.object({ leadId: z.string().uuid() }).parse(req.params),
      body = leadPatch.parse(req.body);
    if (!(await c.repo.getClient(id)) || !(await c.repo.updateLead(id, leadId, body)))
      throw new AppError(404, 'NOT_FOUND', 'Lead not found');
    await c.repo.audit(id, 'lead.updated', { leadId, fields: Object.keys(body) });
    return { updated: true };
  });
  app.get('/clients/:id/leads/:leadId', async (req) => {
    const { id } = idParams.parse(req.params),
      { leadId } = z.object({ leadId: z.string().uuid() }).parse(req.params),
      lead = ((await c.repo.listLeads(id)) as LeadRow[]).find((x) => x.id === leadId);
    if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
    return {
      ...lead,
      conversation: lead.conversationId
        ? await c.repo.conversationForClient(id, lead.conversationId)
        : null,
    };
  });
  app.get('/clients/:id/leads.csv', async (req, reply) => {
    const { id } = idParams.parse(req.params),
      rows = (await c.repo.listLeads(id)) as LeadRow[],
      esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const columns = [
      'id',
      'name',
      'email',
      'phone',
      'requirement',
      'status',
      'assignee',
      'notes',
      'createdAt',
    ];
    return reply
      .type('text/csv')
      .header('content-disposition', 'attachment; filename="leads.csv"')
      .send(
        columns.join(',') +
          '\n' +
          rows.map((r) => columns.map((k) => esc(r[k])).join(',')).join('\n'),
      );
  });
  app.get('/clients/:id/analytics', async (req) => {
    const { id } = idParams.parse(req.params),
      { period } = z
        .object({ period: z.enum(['daily', 'weekly', 'monthly']).default('daily') })
        .parse(req.query),
      days = period === 'daily' ? 30 : period === 'weekly' ? 84 : 365;
    return await c.repo.analytics(id, days);
  });
  app.get('/settings/provider', async () => {
    const saved = ((await c.repo.setting('provider')) ?? {}) as Record<string, unknown>;
    return {
      running: {
        provider: c.env.llm.providerName,
        type: c.env.llm.providerType,
        baseUrl: c.env.llm.baseUrl,
        model: c.env.llm.model,
        configured: Boolean(c.env.llm.apiKey) || c.env.llm.providerType === 'local',
      },
      staged: saved,
      restartRequired: Object.keys(saved).length > 0,
      presets: Object.keys(presets),
    };
  });
  app.put('/settings/provider', async (req) => {
    const v = providerSchema.omit({ apiKey: true }).parse(req.body);
    await c.repo.setSetting('provider', v);
    await c.repo.audit(undefined, 'provider.settings.staged', { provider: v.provider });
    return { saved: true, restartRequired: true, secretPersisted: false };
  });
  app.post('/settings/provider/test', async (req) => {
    const v = providerSchema.parse(req.body);
    if (v.provider === 'local') return { connected: true, status: 'ready', provider: 'local' };
    const baseUrl = v.baseUrl ?? presets[v.provider];
    if (!baseUrl || !v.model || !v.apiKey)
      throw new AppError(400, 'VALIDATION_ERROR', 'Base URL, model, and API key are required');
    const config = loadLlmConfig({
      LLM_PROVIDER_TYPE: 'openai-compatible',
      LLM_PROVIDER_NAME: v.provider,
      LLM_BASE_URL: baseUrl,
      LLM_MODEL: v.model,
      LLM_API_KEY: v.apiKey,
      LLM_TIMEOUT_MS: '5000',
      LLM_MAX_RETRIES: '0',
    });
    const h = await createLlmProvider(config).health();
    return {
      connected: h.connected,
      status: h.status,
      provider: h.provider,
      reachable: h.reachable,
      authentication: h.authentication,
    };
  });
  app.post('/settings/provider/env', async (req) => {
    const v = providerSchema.parse(req.body);
    const base = v.baseUrl ?? presets[v.provider] ?? '';
    return {
      filename: '.env',
      restartRequired: true,
      content: [
        `LLM_PROVIDER_TYPE=${v.provider === 'local' ? 'local' : 'openai-compatible'}`,
        `LLM_PROVIDER_NAME=${v.provider}`,
        `LLM_BASE_URL=${base}`,
        `LLM_MODEL=${v.model ?? ''}`,
        `LLM_API_KEY=REPLACE_WITH_SECRET`,
      ].join('\n'),
    };
  });
  app.get('/settings/system', async () => ({
    general: { publicBaseUrl: c.env.PUBLIC_BASE_URL, nodeEnv: c.env.NODE_ENV },
    smtp: {
      provider: c.env.NOTIFICATION_PROVIDER,
      host: c.env.SMTP_HOST ?? null,
      port: c.env.SMTP_PORT,
      user: c.env.SMTP_USER ? 'configured' : null,
      password: c.env.SMTP_PASS ? '••••••••' : null,
    },
    storage: { provider: c.storage.name, dataDir: c.env.DATA_DIR },
    database: { provider: c.repo.name },
    api: { corsOrigins: c.env.CORS_ORIGINS },
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      secrets: { adminApiKey: '••••••••', llmApiKey: c.env.llm.apiKey ? '••••••••' : null },
    },
  }));
  app.get('/health', async () => ({
    status: 'ok',
    version: '1.0.0',
    providers: {
      database: await c.repo.health(),
      storage: await c.storage.health(),
      llm: await c.llm.health(),
      embedding: await c.embedding.health(),
      vector: await c.vector.health(),
      notification: await c.notification.health(),
    },
    ...c.metrics.snapshot(),
  }));
}
