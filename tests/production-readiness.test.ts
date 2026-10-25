import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

const adminKey = 'production-readiness-admin-key';
const adminHeaders = { 'x-admin-api-key': adminKey };
const northstarOrigin = 'https://northstar.example';
const brightSmileOrigin = 'https://brightsmile.example';
let app: Awaited<ReturnType<typeof buildApp>>;
let dataDir: string;
let northstarId = '';
let northstarKey = '';
let brightSmileId = '';
let brightSmileKey = '';
let northstarConversationId = '';
let brightSmileConversationId = '';
let northstarLeadId = '';

function multipart(filename: string, text: string) {
  const boundary = '----productionreadiness';
  return {
    headers: { ...adminHeaders, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--${boundary}--\r\n`,
  };
}

async function createTenant(name: string, slug: string, domain: string, fallbackMessage: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/admin/clients',
    headers: adminHeaders,
    payload: {
      name,
      slug,
      domains: [domain],
      prompt: `Answer only from ${name} knowledge.`,
      config: {
        assistantName: `${name} Assistant`,
        fallbackMessage,
        collectLead: true,
        leadFields: ['email', 'requirement'],
        minSimilarity: 0.999,
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { client: { id: string }; apiKey: string };
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-production-readiness-'));
  app = await buildApp(
    loadEnv({
      NODE_ENV: 'production',
      ADMIN_API_KEY: adminKey,
      DATA_DIR: dataDir,
      PUBLIC_BASE_URL: 'https://orbit.example',
      CORS_ORIGINS: 'https://dashboard.example',
    }),
  );
  await app.ready();
  const northstar = await createTenant(
    'Northstar Solar',
    'northstar-solar',
    'northstar.example',
    'Not found in Northstar knowledge.',
  );
  northstarId = northstar.client.id;
  northstarKey = northstar.apiKey;
  const brightSmile = await createTenant(
    'BrightSmile Dental',
    'brightsmile-dental',
    'brightsmile.example',
    'Not found in BrightSmile knowledge.',
  );
  brightSmileId = brightSmile.client.id;
  brightSmileKey = brightSmile.apiKey;
  await app.inject({
    method: 'POST',
    url: `/admin/clients/${northstarId}/knowledge`,
    ...multipart(
      'northstar.txt',
      'Northstar Solar installs HelioPeak panels with a 27-year warranty.',
    ),
  });
  await app.inject({
    method: 'POST',
    url: `/admin/clients/${brightSmileId}/knowledge`,
    ...multipart(
      'brightsmile.txt',
      'BrightSmile Dental offers CometClean appointments on Saturday mornings.',
    ),
  });
});

afterAll(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('two-tenant production-readiness regressions', () => {
  it('allows tenant-authorized public CORS without opening admin CORS', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/chat',
      headers: {
        origin: northstarOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-api-key',
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(northstarOrigin);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { origin: 'https://attacker.example', 'x-api-key': northstarKey },
      payload: { message: 'Northstar Solar installs HelioPeak panels with a 27-year warranty.' },
    });
    expect(forbidden.statusCode).toBe(403);

    const adminResponse = await app.inject({
      url: '/admin/clients',
      headers: { ...adminHeaders, origin: 'https://attacker.example' },
    });
    expect(adminResponse.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('uses tenant-scoped RAG in prompt preview with safe zero-context evidence', async () => {
    const positive = await app.inject({
      method: 'POST',
      url: `/admin/clients/${northstarId}/prompts/preview`,
      headers: adminHeaders,
      payload: {
        question: 'Northstar Solar installs HelioPeak panels with a 27-year warranty.',
        prompt: 'Use only Northstar Solar context.',
      },
    });
    expect(positive.statusCode).toBe(200);
    expect(positive.json().answer).toContain('HelioPeak');
    expect(positive.json().retrieval.count).toBe(1);
    expect(positive.json().retrieval.sources[0]).toMatchObject({ source: 'northstar.txt' });
    expect(positive.json().retrieval.sources[0].chunkId).toEqual(expect.any(String));
    expect(positive.json().retrieval.sources[0].score).toBe(1);

    const unrelated = await app.inject({
      method: 'POST',
      url: `/admin/clients/${northstarId}/prompts/preview`,
      headers: adminHeaders,
      payload: {
        question: 'BrightSmile Dental offers CometClean appointments on Saturday mornings.',
        prompt: 'Use only Northstar Solar context.',
      },
    });
    expect(unrelated.json()).toMatchObject({
      answer: 'Not found in Northstar knowledge.',
      retrieval: { count: 0, sources: [] },
    });

    const reverse = await app.inject({
      method: 'POST',
      url: `/admin/clients/${brightSmileId}/prompts/preview`,
      headers: adminHeaders,
      payload: {
        question: 'Northstar Solar installs HelioPeak panels with a 27-year warranty.',
        prompt: 'Use only BrightSmile Dental context.',
      },
    });
    expect(reverse.json()).toMatchObject({
      answer: 'Not found in BrightSmile knowledge.',
      retrieval: { count: 0, sources: [] },
    });
  });

  it('grounds public chat bidirectionally and keeps sessions tenant-scoped', async () => {
    const northstar = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { origin: northstarOrigin, 'x-api-key': northstarKey },
      payload: { message: 'Northstar Solar installs HelioPeak panels with a 27-year warranty.' },
    });
    expect(northstar.statusCode).toBe(200);
    expect(northstar.json().answer).toContain('HelioPeak');
    expect(northstar.json().sources[0]).toMatchObject({ source: 'northstar.txt', score: 1 });
    expect(northstar.json().sources[0].chunkId).toEqual(expect.any(String));
    expect(northstar.json().leadCollection.fields[0]).toBe('name');
    northstarConversationId = northstar.json().conversationId;

    const brightSmile = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { origin: brightSmileOrigin, 'x-api-key': brightSmileKey },
      payload: {
        message: 'BrightSmile Dental offers CometClean appointments on Saturday mornings.',
      },
    });
    expect(brightSmile.json().answer).toContain('CometClean');
    brightSmileConversationId = brightSmile.json().conversationId;

    const northstarCross = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { origin: northstarOrigin, 'x-api-key': northstarKey },
      payload: {
        message: 'BrightSmile Dental offers CometClean appointments on Saturday mornings.',
      },
    });
    expect(northstarCross.json().answer).toContain('provided by Northstar Solar');
    expect(northstarCross.json().answer).not.toContain('CometClean');
    expect(northstarCross.json().answer).not.toContain('BrightSmile Dental');

    const brightSmileCross = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { origin: brightSmileOrigin, 'x-api-key': brightSmileKey },
      payload: { message: 'Northstar Solar installs HelioPeak panels with a 27-year warranty.' },
    });
    expect(brightSmileCross.json().answer).toContain('provided by BrightSmile Dental');
    expect(brightSmileCross.json().answer).not.toContain('I’m sorry, I don’t have that information.');

    const reusedSession = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { origin: brightSmileOrigin, 'x-api-key': brightSmileKey },
      payload: {
        sessionId: northstar.json().sessionId,
        message: 'Northstar Solar installs HelioPeak panels with a 27-year warranty.',
      },
    });
    expect(reusedSession.json().answer).toContain('provided by BrightSmile Dental');
    expect(reusedSession.json().answer).not.toContain('I’m sorry, I don’t have that information.');
    expect(reusedSession.json().conversationId).not.toBe(northstarConversationId);
  });

  it('rejects cross-tenant conversation links and cross-tenant lead updates', async () => {
    const crossLink = await app.inject({
      method: 'POST',
      url: '/v1/leads',
      headers: { origin: northstarOrigin, 'x-api-key': northstarKey },
      payload: { name: 'Synthetic Northstar Lead', conversationId: brightSmileConversationId },
    });
    expect(crossLink.statusCode).toBe(404);
    expect(crossLink.json().error.code).toBe('CONVERSATION_NOT_FOUND');

    const valid = await app.inject({
      method: 'POST',
      url: '/v1/leads',
      headers: { origin: northstarOrigin, 'x-api-key': northstarKey },
      payload: {
        name: 'Synthetic Northstar Lead',
        email: 'northstar.test@example.com',
        conversationId: northstarConversationId,
      },
    });
    expect(valid.statusCode).toBe(200);
    northstarLeadId = valid.json().id;

    const crossUpdate = await app.inject({
      method: 'PATCH',
      url: `/admin/clients/${brightSmileId}/leads/${northstarLeadId}`,
      headers: adminHeaders,
      payload: { status: 'won' },
    });
    expect(crossUpdate.statusCode).toBe(404);

    const detail = await app.inject({
      url: `/admin/clients/${northstarId}/leads/${northstarLeadId}`,
      headers: adminHeaders,
    });
    expect(detail.json().conversation.client_id).toBe(northstarId);
    expect(detail.body).not.toContain('CometClean');
  });

  it('keeps analytics tenant-specific and rotates API keys copy-once', async () => {
    const northstarAnalytics = await app.inject({
      url: `/admin/clients/${northstarId}/analytics`,
      headers: adminHeaders,
    });
    const brightSmileAnalytics = await app.inject({
      url: `/admin/clients/${brightSmileId}/analytics`,
      headers: adminHeaders,
    });
    expect(northstarAnalytics.json().leads).toBe(1);
    expect(brightSmileAnalytics.json().leads).toBe(0);

    const rotated = await app.inject({
      method: 'POST',
      url: `/admin/clients/${northstarId}/rotate-key`,
      headers: adminHeaders,
    });
    expect(rotated.json().copyOnce).toBe(true);
    const newKey = rotated.json().apiKey as string;
    expect(newKey).not.toBe(northstarKey);

    const oldKeyResponse = await app.inject({
      url: '/v1/config',
      headers: { origin: northstarOrigin, 'x-api-key': northstarKey },
    });
    expect(oldKeyResponse.statusCode).toBe(401);
    const newKeyResponse = await app.inject({
      url: '/v1/config',
      headers: { origin: northstarOrigin, 'x-api-key': newKey },
    });
    expect(newKeyResponse.statusCode).toBe(200);
    expect(newKeyResponse.body).not.toContain(newKey);
  });

  it('serves widget lead-capture behavior without embedding key values', async () => {
    const widget = await app.inject({ url: '/widget.js' });
    expect(widget.statusCode).toBe(200);
    expect(widget.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(widget.body).toContain("fetch(base + '/v1/leads'");
    expect(widget.body).toContain('conversationId');
    expect(widget.body).toContain('Thanks — your details were sent.');
    expect(widget.body).not.toContain(northstarKey);
    expect(widget.body).not.toContain(brightSmileKey);
  });
});
