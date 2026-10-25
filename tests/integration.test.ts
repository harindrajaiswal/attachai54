import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
const admin = 'test-admin-key-at-least-24';
let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let aKey = '';
let aId = '';
let bKey = '';
let bId = '';
const ah = { 'x-admin-api-key': admin };
const origin = 'https://alpha.example';
async function create(name: string, slug: string, domain: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/admin/clients',
    headers: ah,
    payload: {
      name,
      slug,
      domains: [domain],
      prompt: 'Answer only from context.',
      config: {
        assistantName: name,
        fallbackMessage: 'I do not know.',
        collectLead: true,
        notificationEmail: 'team@example.com',
      },
    },
  });
  expect(r.statusCode).toBe(200);
  return r.json() as { client: { id: string }; apiKey: string; embedCode: string };
}
function multipart(name: string, text: string) {
  const b = '----testboundary';
  return {
    headers: { ...ah, 'content-type': `multipart/form-data; boundary=${b}` },
    payload: `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--${b}--\r\n`,
  };
}
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tenant-ai-'));
  app = await buildApp(
    loadEnv({
      NODE_ENV: 'test',
      ADMIN_API_KEY: admin,
      DATA_DIR: dir,
      PUBLIC_BASE_URL: 'http://localhost:3000',
    }),
  );
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
});
describe('integration/e2e', () => {
  it('starts and reports health providers', async () => {
    const r = await app.inject({ url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json().providers.vector.connected).toBe(true);
  });
  it('reports ready', async () =>
    expect((await app.inject({ url: '/ready' })).statusCode).toBe(200));
  it('protects admin routes', async () =>
    expect((await app.inject({ url: '/admin/clients' })).statusCode).toBe(401));
  it('validates strict client configuration', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/admin/clients',
      headers: ah,
      payload: {
        name: 'x',
        slug: 'xx',
        domains: ['x.com'],
        prompt: 'p',
        config: { assistantName: 'x', fallbackMessage: 'no', unknown: true },
      },
    });
    expect(r.statusCode).toBe(400);
  });
  it('onboards two isolated tenants and returns embed snippets', async () => {
    const a = await create('Alpha', 'alpha', 'alpha.example');
    aKey = a.apiKey;
    aId = a.client.id;
    expect(a.embedCode).toContain('widget.js');
    const b = await create('Beta', 'beta', 'beta.example');
    bKey = b.apiKey;
    bId = b.client.id;
    expect(aKey).not.toBe(bKey);
  });
  it('never returns API keys in client listings', async () => {
    const r = await app.inject({ url: '/admin/clients', headers: ah });
    expect(r.body).not.toContain(aKey);
    expect(r.body).not.toContain('keyHash');
  });
  it('uploads prompt files', async () => {
    const m = multipart('prompt.md', 'Be factual and brief.');
    const r = await app.inject({ method: 'POST', url: `/admin/clients/${aId}/prompt`, ...m });
    expect(r.statusCode).toBe(200);
  });
  it('uploads and strictly validates config files', async () => {
    const m = multipart(
      'config.json',
      JSON.stringify({
        assistantName: 'Alpha bot',
        fallbackMessage: 'Not in Alpha knowledge.',
        collectLead: true,
        notificationEmail: 'team@example.com',
      }),
    );
    const r = await app.inject({ method: 'POST', url: `/admin/clients/${aId}/config`, ...m });
    expect(r.statusCode).toBe(200);
  });
  it('uploads and indexes TXT knowledge', async () => {
    const m = multipart(
      'alpha.txt',
      'Alpha support hours are Monday through Friday. Alpha sells red bicycles.',
    );
    const r = await app.inject({ method: 'POST', url: `/admin/clients/${aId}/knowledge`, ...m });
    expect(r.statusCode).toBe(200);
    expect(r.json().chunks).toBe(1);
  });
  it('appends multiple knowledge files and preserves earlier RAG content', async () => {
    const second = multipart('shipping.txt', 'Alpha shipping takes exactly three business days.');
    const uploaded = await app.inject({
      method: 'POST',
      url: `/admin/clients/${aId}/knowledge`,
      ...second,
    });
    expect(uploaded.statusCode).toBe(200);
    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { 'x-api-key': aKey, origin },
      payload: { message: 'What are Alpha support hours?' },
    });
    const latter = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { 'x-api-key': aKey, origin },
      payload: { message: 'How long does Alpha shipping take?' },
    });
    expect(first.json().answer).toContain('Monday');
    expect(latter.json().answer).toContain('three business days');
  });
  it('rejects unsupported uploads', async () => {
    const m = multipart('bad.exe', 'bad');
    const r = await app.inject({ method: 'POST', url: `/admin/clients/${aId}/knowledge`, ...m });
    expect(r.statusCode).toBe(415);
  });
  it('rejects invalid tenant key', async () =>
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/chat',
          headers: { 'x-api-key': 'bad', origin },
          payload: { message: 'hours?' },
        })
      ).statusCode,
    ).toBe(401));
  it('enforces exact allowed origin', async () =>
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/chat',
          headers: { 'x-api-key': aKey, origin: 'https://evil-alpha.example' },
          payload: { message: 'hours?' },
        })
      ).statusCode,
    ).toBe(403));
  it('retrieves tenant knowledge and tracks a session', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { 'x-api-key': aKey, origin },
      payload: { message: 'What are the Alpha support hours?' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().answer).toContain('Monday');
    expect(r.json().sessionId).toBeTruthy();
  });
  it('prevents cross-tenant retrieval', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { 'x-api-key': bKey, origin: 'https://beta.example' },
      payload: { message: 'What are Alpha support hours?' },
    });
    expect(r.json().answer).toContain('provided by Beta');
    expect(r.json().answer).not.toContain('I’m sorry, I don’t have that information.');
  });
  it('persists lead and simulates notification safely', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/leads',
      headers: { 'x-api-key': aKey, origin },
      payload: { name: 'Ada', email: 'ada@example.com', requirement: 'A bicycle' },
    });
    expect(r.statusCode).toBe(200);
    const leads = await app.inject({ url: `/admin/clients/${aId}/leads`, headers: ah });
    expect(leads.body).toContain('ada@example.com');
    expect((await fs.readdir(path.join(dir, 'outbox'))).length).toBe(1);
  });
  it('disables and deletes tenants', async () => {
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/admin/clients/${bId}`,
          headers: ah,
          payload: { enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/chat',
          headers: { 'x-api-key': bKey, origin: 'https://beta.example' },
          payload: { message: 'hi' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: 'DELETE', url: `/admin/clients/${bId}`, headers: ah }))
        .statusCode,
    ).toBe(204);
  });
  it('serves browser widget and demo fixture', async () => {
    expect((await app.inject({ url: '/widget.js' })).body).toContain('tenant-ai-widget');
    expect((await app.inject({ url: '/demo.html' })).statusCode).toBe(200);
  });
  it('exposes Prometheus metrics', async () =>
    expect((await app.inject({ url: '/metrics' })).body).toContain('app_requests_total'));
});
