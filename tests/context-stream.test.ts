import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
let app: Awaited<ReturnType<typeof buildApp>>;
let dir: string;
let key = '';
let clientId = '';
const admin = 'context-test-admin-key-123456';
const origin = 'https://context.example';
const multipart = (filename: string, text: string) => {
  const b = '----context';
  return {
    headers: { 'x-admin-api-key': admin, 'content-type': `multipart/form-data; boundary=${b}` },
    payload: `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--${b}--\r\n`,
  };
};
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-context-'));
  app = await buildApp(
    loadEnv({
      NODE_ENV: 'test',
      ADMIN_API_KEY: admin,
      DATA_DIR: dir,
      PUBLIC_BASE_URL: 'http://localhost:3000',
    }),
  );
  await app.ready();
  const c = await app.inject({
    method: 'POST',
    url: '/admin/clients',
    headers: { 'x-admin-api-key': admin },
    payload: {
      name: 'Context',
      slug: 'context',
      domains: ['context.example'],
      prompt: 'Answer only from supplied context.',
      config: { assistantName: 'Context', fallbackMessage: 'I do not know.' },
    },
  });
  key = c.json().apiKey;
  clientId = c.json().client.id;
  await app.inject({
    method: 'POST',
    url: `/admin/clients/${clientId}/knowledge`,
    ...multipart(
      'facts.txt',
      'Context Co offers emergency plumbing service and is based in Austin.\n\nSolarMax Pro is a residential solar inverter system.\n\nSolarMax Pro main benefits include 98% conversion efficiency and silent operation.',
    ),
  });
});
afterAll(async () => {
  await app.close();
  await fs.rm(dir, { recursive: true, force: true });
});
describe('conversation memory and streaming', () => {
  it('uses persisted conversation history for a bounded follow-up', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { 'x-api-key': key, origin },
      payload: { message: 'What emergency service do you offer?' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { 'x-api-key': key, origin },
      payload: { message: 'Summarize what you just told me.', sessionId: first.json().sessionId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().answer).toContain('emergency plumbing');
  });
  it('answers a follow-up question from a prior conversational statement', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { 'x-api-key': key, origin },
      payload: { message: 'Our product costs ₹999 per month.' },
    });
    const followUp = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { 'x-api-key': key, origin },
      payload: { message: 'What is its monthly price?', sessionId: first.json().sessionId },
    });
    expect(followUp.statusCode).toBe(200);
    expect(followUp.json().answer).toContain('₹999 per month');
  });
  it('resolves pronoun follow-up questions against the knowledge base using conversation history', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { 'x-api-key': key, origin },
      payload: { message: 'What is SolarMax Pro?' },
    });
    expect(first.json().answer).toContain('SolarMax Pro');
    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { 'x-api-key': key, origin },
      payload: { message: 'What are its main benefits?', sessionId: first.json().sessionId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().answer).toContain('98% conversion efficiency');
  });
  it('exposes progressive SSE events and a final persisted result', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/stream',
      headers: { 'x-api-key': key, origin },
      payload: { message: 'What service do you offer?' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.headers['access-control-allow-origin']).toBe(origin);
    expect(r.headers.vary).toContain('Origin');
    expect(r.body).toContain('event: token');
    expect(r.body).toContain('event: done');
  });
});
