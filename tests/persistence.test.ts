import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { SqliteRepository } from '../src/repositories/sqlite.js';

describe('persistence configuration and tenant boundaries', () => {
  const repos: SqliteRepository[] = [];
  afterEach(async () => {
    for (const repo of repos.splice(0)) await repo.close();
  });
  it('selects local defaults without requiring remote credentials', () => {
    const env = loadEnv({ NODE_ENV: 'test', ADMIN_API_KEY: 'test-admin-key-at-least-24' });
    expect(env.DATABASE_PROVIDER).toBe('sqlite');
    expect(env.STORAGE_PROVIDER).toBe('local');
    expect(env.VECTOR_PROVIDER).toBe('local');
  });
  it('requires credentials before selecting Supabase', () => {
    expect(() =>
      loadEnv({
        DATABASE_PROVIDER: 'supabase',
        NODE_ENV: 'test',
        ADMIN_API_KEY: 'test-admin-key-at-least-24',
      }),
    ).toThrow(/SUPABASE_URL/);
  });
  it('persists and scopes tenant records through the async repository boundary', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-repository-'));
    const repo = new SqliteRepository(path.join(dir, 'metadata.sqlite'));
    repos.push(repo);
    await repo.init();
    const config = { assistantName: 'A', fallbackMessage: 'unknown' };
    await repo.createClient({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'A',
      slug: 'tenant-a',
      config,
      prompt: 'p',
      keyHash: 'hash-a',
      domains: ['a.example'],
    });
    await repo.createClient({
      id: '22222222-2222-4222-8222-222222222222',
      name: 'B',
      slug: 'tenant-b',
      config,
      prompt: 'p',
      keyHash: 'hash-b',
      domains: ['b.example'],
    });
    const cid = await repo.createConversation(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
    );
    await repo.saveLead('11111111-1111-4111-8111-111111111111', cid, { name: 'Alice' });
    expect(await repo.listLeads('22222222-2222-4222-8222-222222222222')).toEqual([]);
    expect(
      await repo.conversationForClient('22222222-2222-4222-8222-222222222222', cid),
    ).toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
