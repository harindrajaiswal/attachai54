/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import type { ProviderHealth } from '../domain/types.js';
export interface NotificationProvider {
  readonly name: string;
  notify(
    to: string | undefined,
    subject: string,
    data: unknown,
    clientId?: string,
    options?: { replyTo?: string },
  ): Promise<void>;
  health(): Promise<ProviderHealth>;
}
export class OutboxNotification implements NotificationProvider {
  name = 'file-outbox';
  constructor(private dir: string) {}
  async notify(to: string | undefined, subject: string, data: unknown, _clientId?: string, options?: { replyTo?: string }) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(
      path.join(this.dir, `${Date.now()}-${crypto.randomUUID()}.json`),
      JSON.stringify({ to: to ?? null, subject, data, replyTo: options?.replyTo ?? null, createdAt: new Date().toISOString() }),
    );
  }
  async health() {
    return { provider: this.name, connected: true };
  }
}
export class SmtpNotification implements NotificationProvider {
  name = 'smtp';
  private tx;
  constructor(options: {
    host?: string;
    port: number;
    user?: string;
    pass?: string;
    from?: string;
  }) {
    this.tx = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.port === 465,
      auth: options.user ? { user: options.user, pass: options.pass } : undefined,
    });
    this.from = options.from;
  }
  private from?: string;
  async notify(to: string | undefined, subject: string, data: unknown, _clientId?: string, options?: { replyTo?: string }) {
    if (!to) throw new Error('Notification email is not configured');
    await this.tx.sendMail({ from: this.from, to, replyTo: options?.replyTo, subject, text: JSON.stringify(data, null, 2) });
  }
  async health() {
    try {
      await this.tx.verify();
      return { provider: this.name, connected: true };
    } catch {
      return { provider: this.name, connected: false };
    }
  }
}

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
/** Durable notification/outbox provider. Delivery workers can claim rows later. */
export class SupabaseOutboxNotification implements NotificationProvider {
  readonly name = 'supabase-outbox';
  private readonly client: SupabaseClient<any>;
  constructor(
    urlOrClient: string | SupabaseClient<any>,
    private table = 'notifications',
    key?: string,
  ) {
    this.client =
      typeof urlOrClient === 'string'
        ? createClient(urlOrClient, key ?? '', {
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : urlOrClient;
  }
  async notify(to: string | undefined, subject: string, data: unknown, clientId?: string, options?: { replyTo?: string }) {
    const { error } = await this.client.from(this.table).insert({
      id: crypto.randomUUID(),
      client_id: clientId ?? null,
      recipient: to ?? null,
      subject,
      payload: { ...(data as Record<string, unknown>), replyTo: options?.replyTo ?? null },
      status: 'pending',
      attempts: 0,
      created_at: new Date().toISOString(),
    });
    if (error) throw new Error(`Supabase outbox insert failed: ${error.message}`);
  }
  async health(): Promise<ProviderHealth> {
    const { error } = await this.client.from(this.table).select('id').limit(1);
    return { provider: this.name, connected: !error, detail: error?.message };
  }
}
