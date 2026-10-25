/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeSegment } from '../lib/security.js';
export interface ObjectStorage {
  readonly name: string;
  put(clientId: string, name: string, data: Buffer): Promise<string>;
  list(clientId: string): Promise<string[]>;
  read(clientId: string, name: string): Promise<Buffer>;
  remove(clientId: string, name: string): Promise<void>;
  removeTenant(clientId: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}
export class LocalStorage implements ObjectStorage {
  readonly name = 'local-filesystem';
  constructor(private root: string) {}
  private dir(id: string) {
    return path.join(this.root, safeSegment(id));
  }
  private file(id: string, name: string) {
    const clean = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!clean || clean === '.' || clean === '..') throw new Error('Unsafe filename');
    return path.join(this.dir(id), clean);
  }
  async put(id: string, n: string, d: Buffer) {
    await fs.mkdir(this.dir(id), { recursive: true });
    const f = this.file(id, n);
    await fs.writeFile(f, d, { flag: 'wx' }).catch(async (e) => {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') await fs.writeFile(f, d);
      else throw e;
    });
    return path.basename(f);
  }
  async list(id: string) {
    return fs.readdir(this.dir(id)).catch(() => []);
  }
  async read(id: string, n: string) {
    return fs.readFile(this.file(id, n));
  }
  async remove(id: string, n: string) {
    await fs.rm(this.file(id, n), { force: true });
  }
  async removeTenant(id: string) {
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }
  async health(): Promise<ProviderHealth> {
    try {
      await fs.mkdir(this.root, { recursive: true });
      return { provider: this.name, connected: true };
    } catch (error) {
      return { provider: this.name, connected: false, detail: String(error) };
    }
  }
}

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ProviderHealth } from '../domain/types.js';
/** Private Supabase Storage bucket with an immutable tenant path prefix. */
export class SupabaseStorage implements ObjectStorage {
  readonly name = 'supabase-storage';
  private readonly client: SupabaseClient<any>;
  constructor(
    urlOrClient: string | SupabaseClient<any>,
    private bucket: string,
    key?: string,
  ) {
    this.client =
      typeof urlOrClient === 'string'
        ? createClient(urlOrClient, key ?? '', {
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : urlOrClient;
  }
  private object(id: string, name: string) {
    const clean = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!clean || clean === '.' || clean === '..') throw new Error('Unsafe filename');
    return `${safeSegment(id)}/${clean}`;
  }
  async put(id: string, name: string, data: Buffer) {
    const object = this.object(id, name);
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(object, data, { upsert: true, contentType: 'application/octet-stream' });
    if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);
    return path.basename(object);
  }
  async list(id: string) {
    const prefix = safeSegment(id);
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .list(prefix, { limit: 1000 });
    if (error) throw new Error(`Supabase Storage list failed: ${error.message}`);
    return (data ?? []).map((x: any) => String(x.name)).filter(Boolean);
  }
  async read(id: string, name: string) {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .download(this.object(id, name));
    if (error || !data)
      throw new Error(`Supabase Storage download failed: ${error?.message ?? 'empty object'}`);
    return Buffer.from(await data.arrayBuffer());
  }
  async remove(id: string, name: string) {
    const { error } = await this.client.storage.from(this.bucket).remove([this.object(id, name)]);
    if (error) throw new Error(`Supabase Storage delete failed: ${error.message}`);
  }
  async removeTenant(id: string) {
    const files = await this.list(id);
    if (files.length) {
      const { error } = await this.client.storage
        .from(this.bucket)
        .remove(files.map((x) => this.object(id, x)));
      if (error) throw new Error(`Supabase Storage tenant delete failed: ${error.message}`);
    }
  }
  async health(): Promise<ProviderHealth> {
    const { error } = await this.client.storage.from(this.bucket).list('', { limit: 1 });
    return { provider: this.name, connected: !error, detail: error?.message };
  }
}
