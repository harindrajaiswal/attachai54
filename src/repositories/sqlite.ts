import { DatabaseSync } from 'node:sqlite';
import type { Client, ClientConfig, ChatMessage } from '../domain/types.js';
import type { Repository, CreateClient } from './repository.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const now = () => new Date().toISOString();
export class SqliteRepository implements Repository {
  readonly name = 'sqlite';
  private db: DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
  }
  async init() {
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT UNIQUE NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,config TEXT NOT NULL,prompt TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,client_id TEXT UNIQUE NOT NULL,key_hash TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS domains(client_id TEXT NOT NULL,domain TEXT NOT NULL,PRIMARY KEY(client_id,domain),FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,session_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(client_id,session_id),FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS leads(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,conversation_id TEXT,data TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS usage_logs(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,kind TEXT NOT NULL,units INTEGER NOT NULL,latency_ms REAL NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY,client_id TEXT,action TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS prompt_versions(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,prompt TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS knowledge_files(client_id TEXT NOT NULL,filename TEXT NOT NULL,size INTEGER NOT NULL,chunks INTEGER NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(client_id,filename),FOREIGN KEY(client_id) REFERENCES clients(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lead_workflow(lead_id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'new',assignee TEXT,notes TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE);`);
    const leadCols = this.db.prepare('PRAGMA table_info(leads)').all() as { name: string }[];
    if (!leadCols.some((x) => x.name === 'status'))
      this.db.exec("ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'new'");
    const keyCols = this.db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[];
    if (!keyCols.some((x) => x.name === 'enabled'))
      this.db.exec('ALTER TABLE api_keys ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
  }
  async close() {
    this.db.close();
  }
  async health() {
    return { provider: this.name, connected: true };
  }
  private map(r: Record<string, unknown>): Client {
    return {
      id: String(r.id),
      name: String(r.name),
      slug: String(r.slug),
      enabled: Boolean(r.enabled),
      config: JSON.parse(String(r.config)) as ClientConfig,
      prompt: String(r.prompt),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
  async createClient(v: CreateClient) {
    const t = now();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?)')
        .run(v.id, v.name, v.slug, 1, JSON.stringify(v.config), v.prompt, t, t);
      this.db
        .prepare('INSERT INTO api_keys(id,client_id,key_hash,created_at) VALUES(?,?,?,?)')
        .run(crypto.randomUUID(), v.id, v.keyHash, t);
      for (const d of v.domains) this.db.prepare('INSERT INTO domains VALUES(?,?)').run(v.id, d);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return (await this.getClient(v.id))!;
  }
  async listClients() {
    return (
      this.db.prepare('SELECT * FROM clients ORDER BY created_at').all() as Record<
        string,
        unknown
      >[]
    ).map((r) => this.map(r));
  }
  async getClient(id: string) {
    const r = this.db.prepare('SELECT * FROM clients WHERE id=?').get(id) as
      Record<string, unknown> | undefined;
    return r ? this.map(r) : undefined;
  }
  async getClientByKeyHash(h: string) {
    const r = this.db
      .prepare(
        'SELECT c.* FROM clients c JOIN api_keys k ON k.client_id=c.id WHERE k.key_hash=? AND k.enabled=1',
      )
      .get(h) as Record<string, unknown> | undefined;
    return r ? this.map(r) : undefined;
  }
  async updateClient(
    id: string,
    v: Partial<{ name: string; config: ClientConfig; prompt: string; enabled: boolean }>,
  ) {
    const old = await this.getClient(id);
    if (!old) return;
    const n = { ...old, ...v, updatedAt: now() };
    this.db
      .prepare('UPDATE clients SET name=?,config=?,prompt=?,enabled=?,updated_at=? WHERE id=?')
      .run(n.name, JSON.stringify(n.config), n.prompt, n.enabled ? 1 : 0, n.updatedAt, id);
    return await this.getClient(id);
  }
  async deleteClient(id: string) {
    return this.db.prepare('DELETE FROM clients WHERE id=?').run(id).changes > 0;
  }
  async domains(id: string) {
    return (
      this.db.prepare('SELECT domain FROM domains WHERE client_id=?').all(id) as {
        domain: string;
      }[]
    ).map((x) => x.domain);
  }
  async setDomains(id: string, d: string[]) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM domains WHERE client_id=?').run(id);
      for (const x of d) this.db.prepare('INSERT INTO domains VALUES(?,?)').run(id, x);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async rotateKey(id: string, h: string) {
    this.db
      .prepare('UPDATE api_keys SET key_hash=?,created_at=? WHERE client_id=?')
      .run(h, now(), id);
  }
  async createConversation(clientId: string, sessionId: string) {
    const found = this.db
      .prepare('SELECT id FROM conversations WHERE client_id=? AND session_id=?')
      .get(clientId, sessionId) as { id: string } | undefined;
    if (found) return found.id;
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO conversations VALUES(?,?,?,?)')
      .run(id, clientId, sessionId, now());
    return id;
  }
  async addMessage(cid: string, role: 'user' | 'assistant', content: string) {
    this.db
      .prepare('INSERT INTO messages VALUES(?,?,?,?,?)')
      .run(crypto.randomUUID(), cid, role, content, now());
  }
  async messages(cid: string) {
    return this.db
      .prepare('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at')
      .all(cid) as ChatMessage[];
  }
  async saveLead(clientId: string, cid: string | undefined, data: Record<string, string>) {
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO leads(id,client_id,conversation_id,data,created_at) VALUES(?,?,?,?,?)')
      .run(id, clientId, cid ?? null, JSON.stringify(data), now());
    return id;
  }
  async listLeads(clientId: string) {
    return (
      this.db
        .prepare(
          `SELECT l.id,l.conversation_id,l.data,l.created_at,l.status,w.assignee,w.notes,w.updated_at FROM leads l LEFT JOIN lead_workflow w ON w.lead_id=l.id WHERE l.client_id=? ORDER BY l.created_at DESC`,
        )
        .all(clientId) as {
        id: string;
        conversation_id: string | null;
        data: string;
        created_at: string;
        status: string;
        assignee: string | null;
        notes: string | null;
        updated_at: string | null;
      }[]
    ).map((x) => ({
      id: x.id,
      conversationId: x.conversation_id,
      ...(JSON.parse(x.data) as object),
      status: x.status,
      assignee: x.assignee,
      notes: x.notes ?? '',
      createdAt: x.created_at,
      updatedAt: x.updated_at,
    }));
  }
  async usage(c: string, k: string, u: number, l: number) {
    this.db
      .prepare('INSERT INTO usage_logs VALUES(?,?,?,?,?,?)')
      .run(crypto.randomUUID(), c, k, u, l, now());
  }
  async audit(c: string | undefined, a: string, d: unknown) {
    this.db
      .prepare('INSERT INTO audit_logs VALUES(?,?,?,?,?)')
      .run(crypto.randomUUID(), c ?? null, a, JSON.stringify(d), now());
  }
  async stats(c: string) {
    return this.db
      .prepare(
        `SELECT (SELECT count(*) FROM conversations WHERE client_id=?) conversations,(SELECT count(*) FROM messages m JOIN conversations x ON x.id=m.conversation_id WHERE x.client_id=?) messages,(SELECT count(*) FROM leads WHERE client_id=?) leads,(SELECT coalesce(sum(units),0) FROM usage_logs WHERE client_id=?) units`,
      )
      .get(c, c, c, c);
  }
  async keyStatus(id: string) {
    return this.db.prepare('SELECT enabled,created_at FROM api_keys WHERE client_id=?').get(id) as
      { enabled: number; created_at: string } | undefined;
  }
  async setKeyEnabled(id: string, enabled: boolean) {
    return (
      this.db.prepare('UPDATE api_keys SET enabled=? WHERE client_id=?').run(enabled ? 1 : 0, id)
        .changes > 0
    );
  }
  async savePromptVersion(clientId: string, prompt: string) {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO prompt_versions VALUES(?,?,?,?)').run(id, clientId, prompt, now());
    return id;
  }
  async promptVersions(clientId: string) {
    return this.db
      .prepare(
        'SELECT id,prompt,created_at createdAt FROM prompt_versions WHERE client_id=? ORDER BY created_at DESC',
      )
      .all(clientId);
  }
  async promptVersion(id: string) {
    return this.db.prepare('SELECT * FROM prompt_versions WHERE id=?').get(id) as
      { id: string; client_id: string; prompt: string } | undefined;
  }
  async saveKnowledge(
    clientId: string,
    filename: string,
    size: number,
    chunks: number,
    status = 'ready',
  ) {
    this.db
      .prepare(
        `INSERT INTO knowledge_files VALUES(?,?,?,?,?,?) ON CONFLICT(client_id,filename) DO UPDATE SET size=excluded.size,chunks=excluded.chunks,status=excluded.status,updated_at=excluded.updated_at`,
      )
      .run(clientId, filename, size, chunks, status, now());
  }
  async knowledge(clientId: string) {
    return this.db
      .prepare(
        'SELECT filename,size,chunks,status,updated_at updatedAt FROM knowledge_files WHERE client_id=? ORDER BY updated_at DESC',
      )
      .all(clientId);
  }
  async removeKnowledge(clientId: string, filename: string) {
    this.db
      .prepare('DELETE FROM knowledge_files WHERE client_id=? AND filename=?')
      .run(clientId, filename);
  }
  async audits(limit = 20) {
    return this.db
      .prepare(
        'SELECT id,client_id clientId,action,detail,created_at createdAt FROM audit_logs ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit)
      .map((x) => {
        const row = x as Record<string, unknown> & { detail: string };
        return { ...row, detail: JSON.parse(row.detail) };
      });
  }
  async overview() {
    return this.db
      .prepare(
        `SELECT (SELECT count(*) FROM clients) clients,(SELECT count(*) FROM clients WHERE enabled=1) activeClients,(SELECT count(*) FROM conversations) conversations,(SELECT count(*) FROM leads) leads,(SELECT count(*) FROM conversations WHERE date(created_at)=date('now')) conversationsToday,(SELECT count(*) FROM leads WHERE date(created_at)=date('now')) leadsToday`,
      )
      .get();
  }
  async conversationForClient(clientId: string, id: string) {
    const conversation = this.db
      .prepare('SELECT * FROM conversations WHERE id=? AND client_id=?')
      .get(id, clientId);
    return conversation ? { ...conversation, messages: this.messages(id) } : undefined;
  }
  async updateLead(
    clientId: string,
    id: string,
    data: { status?: string; assignee?: string | null; notes?: string },
  ) {
    const lead = this.db
      .prepare('SELECT id FROM leads WHERE id=? AND client_id=?')
      .get(id, clientId);
    if (!lead) return false;
    if (data.status)
      this.db
        .prepare('UPDATE leads SET status=? WHERE id=? AND client_id=?')
        .run(data.status, id, clientId);
    this.db
      .prepare(
        `INSERT INTO lead_workflow(lead_id,status,assignee,notes,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET status=excluded.status,assignee=excluded.assignee,notes=excluded.notes,updated_at=excluded.updated_at`,
      )
      .run(id, data.status ?? 'new', data.assignee ?? null, data.notes ?? '', now());
    return true;
  }
  async setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        `INSERT INTO settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), now());
  }
  async setting(key: string) {
    const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as
      { value: string } | undefined;
    return r ? JSON.parse(r.value) : undefined;
  }
  async analytics(clientId: string, days = 30) {
    const series = this.db
      .prepare(
        `WITH RECURSIVE dates(d) AS (SELECT date('now', ?) UNION ALL SELECT date(d,'+1 day') FROM dates WHERE d<date('now')) SELECT dates.d date,count(DISTINCT c.id) chats,count(DISTINCT l.id) leads FROM dates LEFT JOIN conversations c ON c.client_id=? AND date(c.created_at)=dates.d LEFT JOIN leads l ON l.client_id=? AND date(l.created_at)=dates.d GROUP BY dates.d ORDER BY dates.d`,
      )
      .all(`-${days - 1} days`, clientId, clientId);
    const base = (await this.stats(clientId)) as {
      conversations: number;
      messages: number;
      leads: number;
      units: number;
    };
    const latency = this.db
      .prepare(
        `SELECT coalesce(avg(latency_ms),0) averageResponseLatencyMs FROM usage_logs WHERE client_id=?`,
      )
      .get(clientId);
    const questions = this.db
      .prepare(
        `SELECT content question,count(*) count FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.client_id=? AND m.role='user' GROUP BY content ORDER BY count(*) DESC LIMIT 10`,
      )
      .all(clientId);
    const knowledge = this.db
      .prepare(
        `SELECT json_extract(detail,'$.sources') sources,count(*) count FROM audit_logs WHERE client_id=? AND action='chat.completed' GROUP BY sources LIMIT 10`,
      )
      .all(clientId);
    return {
      ...base,
      ...latency,
      conversionRate: Number(base.conversations)
        ? Number(base.leads) / Number(base.conversations)
        : 0,
      series,
      topQuestions: questions,
      knowledgeUsage: knowledge,
      topPages: [],
    };
  }
}
