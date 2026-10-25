import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('lead/contact delivery', () => {
  it('uses the trusted tenant registered email and includes visitor details', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lead-feature-'));
    const app = await buildApp(loadEnv({ NODE_ENV: 'test', ADMIN_API_KEY: 'lead-test-admin-key-123456', DATA_DIR: dir, PUBLIC_BASE_URL: 'http://localhost:3000' }));
    await app.ready();
    const headers = { 'x-admin-api-key': 'lead-test-admin-key-123456' };
    const created = await app.inject({ method: 'POST', url: '/admin/clients', headers, payload: {
      name: 'Client A', slug: 'client-a', domains: ['client-a.example'], prompt: 'p',
      config: { assistantName: 'A', fallbackMessage: 'Unknown', notificationEmail: 'client-a@example.com' },
    }});
    const { client, apiKey } = created.json();
    const response = await app.inject({ method: 'POST', url: '/v1/leads', headers: { 'x-api-key': apiKey, origin: 'https://client-a.example' }, payload: {
      name: 'Ada Lovelace', email: 'ada@example.com', message: 'Please contact me', destination: 'attacker@example.com',
    }});
    expect(response.statusCode).toBe(400);
    const valid = await app.inject({ method: 'POST', url: '/v1/leads', headers: { 'x-api-key': apiKey, origin: 'https://client-a.example' }, payload: {
      name: 'Ada Lovelace', email: 'ada@example.com', message: 'Please contact me',
    }});
    expect(valid.statusCode).toBe(200);
    const files = await fs.readdir(path.join(dir, 'outbox'));
    const outbox = JSON.parse(await fs.readFile(path.join(dir, 'outbox', files[0]!), 'utf8'));
    expect(outbox.to).toBe('client-a@example.com');
    expect(outbox.replyTo).toBe('ada@example.com');
    expect(outbox.data).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com', message: 'Please contact me', client: client.name });
    await app.close(); await fs.rm(dir, { recursive: true, force: true });
  });

  it('rejects missing message and invalid email', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lead-validation-'));
    const app = await buildApp(loadEnv({ NODE_ENV: 'test', ADMIN_API_KEY: 'lead-test-admin-key-123456', DATA_DIR: dir })); await app.ready();
    const h = { 'x-admin-api-key': 'lead-test-admin-key-123456' };
    const created = await app.inject({ method: 'POST', url: '/admin/clients', headers: h, payload: { name: 'Client B', slug: 'client-b', domains: ['client-b.example'], prompt: 'p', config: { assistantName: 'B', fallbackMessage: 'Unknown', notificationEmail: 'client-b@example.com' } } });
    const { apiKey } = created.json(); const publicHeaders = { 'x-api-key': apiKey, origin: 'https://client-b.example' };
    expect((await app.inject({ method: 'POST', url: '/v1/leads', headers: publicHeaders, payload: { name: 'x', email: 'bad', message: 'hi' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/leads', headers: publicHeaders, payload: { name: 'x', email: 'x@example.com' } })).statusCode).toBe(400);
    await app.close(); await fs.rm(dir, { recursive: true, force: true });
  });
});
