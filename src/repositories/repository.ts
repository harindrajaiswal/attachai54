import type { Client, ClientConfig, ChatMessage } from '../domain/types.js';
export type CreateClient = {
  id: string;
  name: string;
  slug: string;
  config: ClientConfig;
  prompt: string;
  keyHash: string;
  domains: string[];
};
/** Async persistence boundary shared by local SQLite and Supabase implementations. */
export interface Repository {
  readonly name: string;
  init(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<{ provider: string; connected: boolean; detail?: string }>;
  createClient(v: CreateClient): Promise<Client>;
  listClients(): Promise<Client[]>;
  getClient(id: string): Promise<Client | undefined>;
  getClientByKeyHash(hash: string): Promise<Client | undefined>;
  updateClient(
    id: string,
    v: Partial<{ name: string; config: ClientConfig; prompt: string; enabled: boolean }>,
  ): Promise<Client | undefined>;
  deleteClient(id: string): Promise<boolean>;
  domains(id: string): Promise<string[]>;
  setDomains(id: string, d: string[]): Promise<void>;
  rotateKey(id: string, hash: string): Promise<void>;
  createConversation(clientId: string, sessionId: string): Promise<string>;
  addMessage(conversationId: string, role: 'user' | 'assistant', content: string): Promise<void>;
  messages(conversationId: string): Promise<ChatMessage[]>;
  saveLead(
    clientId: string,
    conversationId: string | undefined,
    data: Record<string, string>,
  ): Promise<string>;
  listLeads(clientId: string): Promise<unknown[]>;
  usage(clientId: string, kind: string, units: number, latencyMs: number): Promise<void>;
  audit(clientId: string | undefined, action: string, detail: unknown): Promise<void>;
  stats(clientId: string): Promise<unknown>;
  keyStatus(id: string): Promise<{ enabled: number | boolean; created_at: string } | undefined>;
  setKeyEnabled(id: string, enabled: boolean): Promise<boolean>;
  savePromptVersion(clientId: string, prompt: string): Promise<string>;
  promptVersions(clientId: string): Promise<unknown[]>;
  promptVersion(id: string): Promise<{ id: string; client_id: string; prompt: string } | undefined>;
  saveKnowledge(
    clientId: string,
    filename: string,
    size: number,
    chunks: number,
    status?: string,
  ): Promise<void>;
  knowledge(clientId: string): Promise<unknown[]>;
  removeKnowledge(clientId: string, filename: string): Promise<void>;
  audits(limit?: number): Promise<unknown[]>;
  overview(): Promise<unknown>;
  conversationForClient(clientId: string, id: string): Promise<unknown | undefined>;
  updateLead(
    clientId: string,
    id: string,
    data: { status?: string; assignee?: string | null; notes?: string },
  ): Promise<boolean>;
  setSetting(key: string, value: unknown): Promise<void>;
  setting(key: string): Promise<unknown>;
  analytics(clientId: string, days?: number): Promise<unknown>;
}
