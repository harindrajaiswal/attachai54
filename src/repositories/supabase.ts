/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Client, ClientConfig, ChatMessage } from '../domain/types.js';
import type { CreateClient, Repository } from './repository.js';

/**
 * Supabase persistence adapter. All tenant-facing queries carry an explicit tenant
 * predicate; RLS in migrations is a second, independent isolation boundary.
 */
export class SupabaseRepository implements Repository {
  readonly name = 'supabase';
  private readonly db: SupabaseClient<any>;
  constructor(urlOrClient: string | SupabaseClient<any>, serviceRoleKey?: string) {
    this.db =
      typeof urlOrClient === 'string'
        ? createClient(urlOrClient, serviceRoleKey ?? '', {
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : urlOrClient;
  }
  async init() {
    /* Supabase schema is managed by migrations. */
  }
  async close() {
    /* HTTP client has no open socket lifecycle. */
  }
  async health() {
    const { error } = await this.db.from('clients').select('id').limit(1);
    return { provider: this.name, connected: !error, detail: error?.message };
  }
  private fail(error: { message?: string } | null): never {
    throw new Error(error?.message ?? 'Supabase request failed');
  }
  private map(r: any): Client {
    return {
      id: String(r.id),
      name: String(r.name),
      slug: String(r.slug),
      enabled: Boolean(r.enabled),
      config: (typeof r.config === 'string' ? JSON.parse(r.config) : r.config) as ClientConfig,
      prompt: String(r.prompt),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
  async createClient(v: CreateClient) {
    const t = new Date().toISOString();
    const { error: ce } = await this.db.from('clients').insert({
      id: v.id,
      name: v.name,
      slug: v.slug,
      enabled: true,
      config: v.config,
      prompt: v.prompt,
      created_at: t,
      updated_at: t,
    });
    if (ce) this.fail(ce);
    const { error: ke } = await this.db.from('api_keys').insert({
      id: crypto.randomUUID(),
      client_id: v.id,
      key_hash: v.keyHash,
      enabled: true,
      created_at: t,
    });
    if (ke) {
      await this.db.from('clients').delete().eq('id', v.id);
      this.fail(ke);
    }
    if (v.domains.length) {
      const { error } = await this.db
        .from('domains')
        .insert(v.domains.map((domain) => ({ client_id: v.id, domain })));
      if (error) {
        await this.db.from('clients').delete().eq('id', v.id);
        this.fail(error);
      }
    }
    return (await this.getClient(v.id))!;
  }
  async listClients() {
    const { data, error } = await this.db.from('clients').select('*').order('created_at');
    if (error) this.fail(error);
    return (data ?? []).map((x: any) => this.map(x));
  }
  async getClient(id: string) {
    const { data, error } = await this.db.from('clients').select('*').eq('id', id).maybeSingle();
    if (error) this.fail(error);
    return data ? this.map(data) : undefined;
  }
  async getClientByKeyHash(hash: string) {
    const { data, error } = await this.db
      .from('clients')
      .select('*,api_keys!inner(key_hash,enabled)')
      .eq('api_keys.key_hash', hash)
      .eq('api_keys.enabled', true)
      .maybeSingle();
    if (error) this.fail(error);
    return data ? this.map(data) : undefined;
  }
  async updateClient(
    id: string,
    v: Partial<{ name: string; config: ClientConfig; prompt: string; enabled: boolean }>,
  ) {
    const old = await this.getClient(id);
    if (!old) return;
    const n = { ...old, ...v, updatedAt: new Date().toISOString() };
    const { error } = await this.db
      .from('clients')
      .update({
        name: n.name,
        config: n.config,
        prompt: n.prompt,
        enabled: n.enabled,
        updated_at: n.updatedAt,
      })
      .eq('id', id);
    if (error) this.fail(error);
    return this.getClient(id);
  }
  async deleteClient(id: string) {
    const { error, count } = await this.db.from('clients').delete({ count: 'exact' }).eq('id', id);
    if (error) this.fail(error);
    return (count ?? 0) > 0;
  }
  async domains(id: string) {
    const { data, error } = await this.db
      .from('domains')
      .select('domain')
      .eq('client_id', id)
      .order('domain');
    if (error) this.fail(error);
    return (data ?? []).map((x: any) => String(x.domain));
  }
  async setDomains(id: string, domains: string[]) {
    const { error: de } = await this.db.from('domains').delete().eq('client_id', id);
    if (de) this.fail(de);
    if (domains.length) {
      const { error } = await this.db
        .from('domains')
        .insert(domains.map((domain) => ({ client_id: id, domain })));
      if (error) this.fail(error);
    }
  }
  async rotateKey(id: string, hash: string) {
    const { error } = await this.db
      .from('api_keys')
      .update({ key_hash: hash, created_at: new Date().toISOString(), enabled: true })
      .eq('client_id', id);
    if (error) this.fail(error);
  }
  async createConversation(clientId: string, sessionId: string) {
    const { data: found, error: fe } = await this.db
      .from('conversations')
      .select('id')
      .eq('client_id', clientId)
      .eq('session_id', sessionId)
      .maybeSingle();
    if (fe) this.fail(fe);
    if (found) return String(found.id);
    const id = crypto.randomUUID();
    const { error } = await this.db.from('conversations').insert({
      id,
      client_id: clientId,
      session_id: sessionId,
      created_at: new Date().toISOString(),
    });
    if (error) this.fail(error);
    return id;
  }
  async addMessage(conversationId: string, role: 'user' | 'assistant', content: string) {
    const { error } = await this.db.from('messages').insert({
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      role,
      content,
      created_at: new Date().toISOString(),
    });
    if (error) this.fail(error);
  }
  async messages(conversationId: string) {
    const { data, error } = await this.db
      .from('messages')
      .select('role,content')
      .eq('conversation_id', conversationId)
      .order('created_at');
    if (error) this.fail(error);
    return (data ?? []) as ChatMessage[];
  }
  async saveLead(
    clientId: string,
    conversationId: string | undefined,
    data: Record<string, string>,
  ) {
    const id = crypto.randomUUID();
    const { error } = await this.db.from('leads').insert({
      id,
      client_id: clientId,
      conversation_id: conversationId ?? null,
      data,
      status: 'new',
      created_at: new Date().toISOString(),
    });
    if (error) this.fail(error);
    return id;
  }
  async listLeads(clientId: string) {
    const { data, error } = await this.db
      .from('leads')
      .select('id,conversation_id,data,created_at,status,lead_workflow(assignee,notes,updated_at)')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });
    if (error) this.fail(error);
    return (data ?? []).map((x: any) => {
      const w = Array.isArray(x.lead_workflow) ? x.lead_workflow[0] : x.lead_workflow;
      const d = typeof x.data === 'string' ? JSON.parse(x.data) : x.data;
      return {
        id: x.id,
        conversationId: x.conversation_id,
        ...(d ?? {}),
        status: x.status ?? w?.status ?? 'new',
        assignee: w?.assignee ?? null,
        notes: w?.notes ?? '',
        createdAt: x.created_at,
        updatedAt: w?.updated_at ?? null,
      };
    });
  }
  async usage(clientId: string, kind: string, units: number, latencyMs: number) {
    const { error } = await this.db.from('usage_logs').insert({
      id: crypto.randomUUID(),
      client_id: clientId,
      kind,
      units,
      latency_ms: latencyMs,
      created_at: new Date().toISOString(),
    });
    if (error) this.fail(error);
  }
  async audit(clientId: string | undefined, action: string, detail: unknown) {
    const { error } = await this.db.from('audit_logs').insert({
      id: crypto.randomUUID(),
      client_id: clientId ?? null,
      action,
      detail,
      created_at: new Date().toISOString(),
    });
    if (error) this.fail(error);
  }
  async stats(clientId: string) {
    const [c, m, l, u] = await Promise.all([
      this.db
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', clientId),
      this.db
        .from('messages')
        .select('id,conversations!inner(client_id)', { count: 'exact', head: true })
        .eq('conversations.client_id', clientId),
      this.db.from('leads').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
      this.db.from('usage_logs').select('units').eq('client_id', clientId),
    ]);
    if (c.error) this.fail(c.error);
    if (m.error) this.fail(m.error);
    if (l.error) this.fail(l.error);
    if (u.error) this.fail(u.error);
    return {
      conversations: c.count ?? 0,
      messages: m.count ?? 0,
      leads: l.count ?? 0,
      units: (u.data ?? []).reduce((n: number, x: any) => n + Number(x.units ?? 0), 0),
    };
  }
  async keyStatus(id: string) {
    const { data, error } = await this.db
      .from('api_keys')
      .select('enabled,created_at')
      .eq('client_id', id)
      .maybeSingle();
    if (error) this.fail(error);
    return data ? (data as { enabled: boolean; created_at: string }) : undefined;
  }
  async setKeyEnabled(id: string, enabled: boolean) {
    const { error, count } = await this.db
      .from('api_keys')
      .update({ enabled }, { count: 'exact' })
      .eq('client_id', id);
    if (error) this.fail(error);
    return (count ?? 0) > 0;
  }
  async savePromptVersion(clientId: string, prompt: string) {
    const id = crypto.randomUUID();
    const { error } = await this.db
      .from('prompt_versions')
      .insert({ id, client_id: clientId, prompt, created_at: new Date().toISOString() });
    if (error) this.fail(error);
    return id;
  }
  async promptVersions(clientId: string) {
    const { data, error } = await this.db
      .from('prompt_versions')
      .select('id,prompt,created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });
    if (error) this.fail(error);
    return (data ?? []).map((x: any) => ({ id: x.id, prompt: x.prompt, createdAt: x.created_at }));
  }
  async promptVersion(id: string) {
    const { data, error } = await this.db
      .from('prompt_versions')
      .select('id,client_id,prompt')
      .eq('id', id)
      .maybeSingle();
    if (error) this.fail(error);
    return data ? (data as { id: string; client_id: string; prompt: string }) : undefined;
  }
  async saveKnowledge(
    clientId: string,
    filename: string,
    size: number,
    chunks: number,
    status = 'ready',
  ) {
    const { error } = await this.db.from('knowledge_files').upsert(
      {
        client_id: clientId,
        filename,
        size,
        chunks,
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,filename' },
    );
    if (error) this.fail(error);
  }
  async knowledge(clientId: string) {
    const { data, error } = await this.db
      .from('knowledge_files')
      .select('filename,size,chunks,status,updated_at')
      .eq('client_id', clientId)
      .order('updated_at', { ascending: false });
    if (error) this.fail(error);
    return (data ?? []).map((x: any) => ({
      filename: x.filename,
      size: x.size,
      chunks: x.chunks,
      status: x.status,
      updatedAt: x.updated_at,
    }));
  }
  async removeKnowledge(clientId: string, filename: string) {
    const { error } = await this.db
      .from('knowledge_files')
      .delete()
      .eq('client_id', clientId)
      .eq('filename', filename);
    if (error) this.fail(error);
  }
  async audits(limit = 20) {
    const { data, error } = await this.db
      .from('audit_logs')
      .select('id,client_id,action,detail,created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) this.fail(error);
    return (data ?? []).map((x: any) => ({
      id: x.id,
      clientId: x.client_id,
      action: x.action,
      detail: typeof x.detail === 'string' ? JSON.parse(x.detail) : x.detail,
      createdAt: x.created_at,
    }));
  }
  async overview() {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString();
    const [a, b, c, d, ct, lt] = await Promise.all([
      this.db.from('clients').select('id', { count: 'exact', head: true }),
      this.db.from('clients').select('id', { count: 'exact', head: true }).eq('enabled', true),
      this.db.from('conversations').select('id', { count: 'exact', head: true }),
      this.db.from('leads').select('id', { count: 'exact', head: true }),
      this.db
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', todayIso),
      this.db
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', todayIso),
    ]);
    for (const x of [a, b, c, d, ct, lt]) if (x.error) this.fail(x.error);
    return {
      clients: a.count ?? 0,
      activeClients: b.count ?? 0,
      conversations: c.count ?? 0,
      leads: d.count ?? 0,
      conversationsToday: ct.count ?? 0,
      leadsToday: lt.count ?? 0,
    };
  }
  async conversations(clientId: string) {
    const { data, error } = await this.db
      .from('conversations')
      .select('id,client_id,session_id,created_at,messages(created_at),leads(id)')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });
    if (error) this.fail(error);
    return (data ?? []).map((x: any) => {
      const msgs = Array.isArray(x.messages) ? x.messages : [];
      const leads = Array.isArray(x.leads) ? x.leads : [];
      const lastMessageAt = msgs.reduce(
        (latest: string, m: any) =>
          String(m.created_at) > latest ? String(m.created_at) : latest,
        String(x.created_at),
      );
      return {
        id: String(x.id),
        clientId: String(x.client_id),
        session_id: String(x.session_id),
        sessionId: String(x.session_id),
        createdAt: String(x.created_at),
        messageCount: msgs.length,
        leadCount: leads.length,
        lastMessageAt,
      };
    });
  }
  async conversationForClient(clientId: string, id: string) {
    const { data, error } = await this.db
      .from('conversations')
      .select('*')
      .eq('id', id)
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) this.fail(error);
    return data ? { ...data, messages: await this.messages(id) } : undefined;
  }
  async updateLead(
    clientId: string,
    id: string,
    data: { status?: string; assignee?: string | null; notes?: string },
  ) {
    const { data: lead, error: le } = await this.db
      .from('leads')
      .select('id')
      .eq('id', id)
      .eq('client_id', clientId)
      .maybeSingle();
    if (le) this.fail(le);
    if (!lead) return false;
    if (data.status) {
      const { error } = await this.db
        .from('leads')
        .update({ status: data.status })
        .eq('id', id)
        .eq('client_id', clientId);
      if (error) this.fail(error);
    }
    const { error } = await this.db.from('lead_workflow').upsert({
      lead_id: id,
      status: data.status ?? 'new',
      assignee: data.assignee ?? null,
      notes: data.notes ?? '',
      updated_at: new Date().toISOString(),
    });
    if (error) this.fail(error);
    return true;
  }
  async setSetting(key: string, value: unknown) {
    const { error } = await this.db
      .from('settings')
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) this.fail(error);
  }
  async setting(key: string) {
    const { data, error } = await this.db
      .from('settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) this.fail(error);
    if (!data) return undefined;
    return typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
  }
  async analytics(clientId: string, days = 30) {
    const base = await this.stats(clientId);
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - Math.max(0, days - 1));
    const [conversations, leads, usage, questions, knowledge] = await Promise.all([
      this.db
        .from('conversations')
        .select('id,created_at')
        .eq('client_id', clientId)
        .gte('created_at', start.toISOString()),
      this.db
        .from('leads')
        .select('id,created_at')
        .eq('client_id', clientId)
        .gte('created_at', start.toISOString()),
      this.db.from('usage_logs').select('latency_ms').eq('client_id', clientId),
      this.db
        .from('messages')
        .select('content,conversations!inner(client_id)')
        .eq('conversations.client_id', clientId)
        .eq('role', 'user'),
      this.db
        .from('audit_logs')
        .select('detail')
        .eq('client_id', clientId)
        .eq('action', 'chat.completed'),
    ]);
    for (const x of [conversations, leads, usage, questions, knowledge])
      if (x.error) this.fail(x.error);
    const day = (value: string) => value.slice(0, 10);
    const dates: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const countByDay = (rows: any[]) =>
      rows.reduce(
        (m, x) => {
          const k = day(String(x.created_at));
          m[k] = (m[k] ?? 0) + 1;
          return m;
        },
        {} as Record<string, number>,
      );
    const chats = countByDay(conversations.data ?? []),
      leadCounts = countByDay(leads.data ?? []);
    const series = dates.map((date) => ({
      date,
      chats: chats[date] ?? 0,
      leads: leadCounts[date] ?? 0,
    }));
    const questionCounts = new Map<string, number>();
    for (const x of questions.data ?? [])
      questionCounts.set(String(x.content), (questionCounts.get(String(x.content)) ?? 0) + 1);
    const topQuestions = [...questionCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([question, count]) => ({ question, count }));
    const sourceCounts = new Map<string, number>();
    for (const x of knowledge.data ?? []) {
      const sources = (x.detail as any)?.sources;
      for (const source of Array.isArray(sources) ? sources : [])
        sourceCounts.set(String(source), (sourceCounts.get(String(source)) ?? 0) + 1);
    }
    const knowledgeUsage = [...sourceCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sources, count]) => ({ sources, count }));
    const latencies = (usage.data ?? [])
      .map((x: any) => Number(x.latency_ms))
      .filter(Number.isFinite);
    return {
      ...(base as Record<string, unknown>),
      averageResponseLatencyMs: latencies.length
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0,
      conversionRate: Number((base as any).conversations)
        ? Number((base as any).leads) / Number((base as any).conversations)
        : 0,
      series,
      topQuestions,
      knowledgeUsage,
      topPages: [],
    };
  }
}
