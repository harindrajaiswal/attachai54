import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const admin = 'dashboard-test-admin-key-123',
  h = { 'x-admin-api-key': admin };
let app: Awaited<ReturnType<typeof buildApp>>, dir: string, id: string, key: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-api-'));
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
describe('dashboard API families', () => {
  it('validates login and supports client/key/domain lifecycle', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/admin/auth/validate', headers: h })).statusCode,
    ).toBe(200);
    const r = await app.inject({
      method: 'POST',
      url: '/admin/clients',
      headers: h,
      payload: {
        name: 'Dashboard Co',
        slug: 'dashboard-co',
        domains: ['dash.example'],
        prompt: 'Original prompt',
        config: {
          assistantName: 'Dash',
          fallbackMessage: 'Unknown',
          widget: { primaryColor: '#6d5dfc', width: 360, height: 520, icon: 'sparkles' },
        },
      },
    });
    ({
      client: { id },
      apiKey: key,
    } = r.json());
    expect(key).toMatch(/^tai_/);
    expect(
      (
        await app.inject({ method: 'POST', url: `/admin/clients/${id}/key/disable`, headers: h })
      ).json().enabled,
    ).toBe(false);
    expect(
      (
        await app.inject({ method: 'POST', url: `/admin/clients/${id}/key/enable`, headers: h })
      ).json().enabled,
    ).toBe(true);
  });
  it('persists prompt versions and restores them', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/admin/clients/${id}`,
      headers: h,
      payload: { prompt: 'Second prompt' },
    });
    const versions = (
      await app.inject({ url: `/admin/clients/${id}/prompts/history`, headers: h })
    ).json();
    expect(versions[0].prompt).toBe('Original prompt');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/admin/clients/${id}/prompts/${versions[0].id}/restore`,
          headers: h,
        })
      ).json().prompt,
    ).toBe('Original prompt');
  });
  it('exposes real overview, analytics, settings, provider staging and health', async () => {
    expect((await app.inject({ url: '/admin/overview', headers: h })).json().clients).toBe(1);
    const ar = await app.inject({ url: `/admin/clients/${id}/analytics`, headers: h });
    expect(ar.json().topPages).toEqual([]);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/admin/settings/provider',
          headers: h,
          payload: { provider: 'openai', model: 'gpt-test', temperature: 0 },
        })
      ).json().restartRequired,
    ).toBe(true);
    const provider = (await app.inject({ url: '/admin/settings/provider', headers: h })).json();
    expect(provider.staged.provider).toBe('openai');
    expect(JSON.stringify(provider)).not.toContain(key);
    expect((await app.inject({ url: '/admin/settings/system', headers: h })).body).toContain(
      '••••••••',
    );
    expect((await app.inject({ url: '/admin/health', headers: h })).statusCode).toBe(200);
  });
  it('serves widget config without exposing tenant secrets', async () => {
    const r = await app.inject({
      url: '/v1/config',
      headers: { 'x-api-key': key, origin: 'https://dash.example' },
    });
    expect(r.json().widget.icon).toBe('sparkles');
    expect(r.body).not.toContain(key);
  });
});
