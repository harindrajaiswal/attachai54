import crypto from 'node:crypto';
import type { Repository } from '../repositories/repository.js';
import type { EmbeddingProvider } from '../providers/embedding.js';
import type { VectorProvider } from '../providers/vector.js';
import type { LlmProvider } from '../providers/llm.js';
import type { Client, ChatMessage, RetrievedChunk } from '../domain/types.js';
import { AppError } from '../lib/errors.js';
import { cleanAnswerScaffolding, retrieveAdvancedEvidence, type EvidenceDecision, type RetrievalDiagnostics } from './advanced-rag.js';
import { groundingCorrection, validateGrounding } from './grounding.js';

type ChatResult = {
  sessionId: string;
  conversationId: string;
  answer: string;
  sources: { chunkId: string; source: string; score: number }[];
  leadCollection?: { enabled: true; fields: string[] };
};

type Prepared = {
  requestId: string;
  client: Client;
  sid: string;
  conversationId: string;
  history: ChatMessage[];
  found: RetrievedChunk[];
  decision: EvidenceDecision;
  diagnostics: RetrievalDiagnostics;
  started: number;
  summary: boolean;
};

const summaryRequest = (message: string) => /\b(summarize|summary|recap|what did we discuss|what you just said)\b/i.test(message);
const clearlyGeneral = (message: string) => /^(hi|hello|hey|thanks|thank you|okay|ok|good morning|good afternoon|good evening|how are you|tell me a joke|what is the meaning of life)[!.? ]*$/i.test(message.trim());
const answerTokens = (answer: string) => answer.match(/\S+\s*/g) ?? [];
const redact = (value: string, limit = 1200) => value
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
  .replace(/(?:\\+?\\d[\\d ()-]{7,}\\d)/g, '[REDACTED_PHONE]')
  .slice(0, limit);
const trace = (requestId: string, event: string, data: Record<string, unknown>) =>
  console.log(JSON.stringify({ groundingTrace: true, requestId, event, ...data }));

/** Tenant-scoped orchestration. Retrieval is always attempted for the current question; history is summary-only. */
export class ChatService {
  constructor(
    private repo: Repository,
    private embedding: EmbeddingProvider,
    private vector: VectorProvider,
    private llm: LlmProvider,
  ) {}

  async retrieve(clientId: string, message: string) {
    const client = await this.repo.getClient(clientId);
    if (!client?.enabled) throw new AppError(403, 'TENANT_DISABLED', 'Tenant is disabled');
    const [queryVector] = await this.embedding.embed([message]);
    const dense = await this.vector.search(clientId, queryVector!, Math.min(client.config.topK ?? 20, 40), client.config.minSimilarity ?? 0.05);
    const corpus = typeof this.vector.listTenant === 'function' ? await this.vector.listTenant(clientId, 2000) : dense;
    return { client, ...(await retrieveAdvancedEvidence({ question: message, corpus, dense })) };
  }

  private selectEvidence(candidates: RetrievedChunk[], question: string) {
    // Compatibility helper for callers outside the active pipeline; chat/preview
    // use retrieveAdvancedEvidence directly and never apply a second selector.
    const queryTerms = new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    return candidates.slice().sort((a, b) => {
      const score = (chunk: RetrievedChunk) => [...queryTerms].filter((term) => chunk.text.toLowerCase().includes(term)).length;
      return b.score - a.score || score(b) - score(a);
    });
  }

  /**
   * Generate once, validate against the exact selected tenant evidence, and allow
   * one bounded correction generation. A failed correction is never shown.
   */
  private async answerWithGrounding(prepared: Prepared, question: string, prompt = prepared.client.prompt) {
    const first = cleanAnswerScaffolding(await this.llm.answer(this.input(prepared, question, prompt)));
    const firstCheck = validateGrounding(question, first, prepared.found);
    trace(prepared.requestId, 'GROUNDING_FIRST', { rawAnswer: redact(first), validation: firstCheck, evidenceCount: prepared.found.length });
    if (firstCheck.ok) return first;

    const corrected = cleanAnswerScaffolding(await this.llm.answer(
      this.input(prepared, question, `${prompt}\n${groundingCorrection(firstCheck.reasons)}`),
    ));
    const correctedCheck = validateGrounding(question, corrected, prepared.found);
    trace(prepared.requestId, 'GROUNDING_CORRECTION', { reasons: firstCheck.reasons, correctedAnswer: redact(corrected), validation: correctedCheck, final: correctedCheck.ok ? 'corrected-answer' : 'fallback', fallbackMessage: prepared.client.config.fallbackMessage });
    return correctedCheck.ok ? corrected : prepared.client.config.fallbackMessage;
  }

  async preview(clientId: string, message: string, prompt: string) {
    const retrieval = await this.retrieve(clientId, message);
    const prepared = {
      requestId: crypto.randomUUID(), client: retrieval.client, sid: '', conversationId: '', history: [], found: retrieval.evidence,
      decision: retrieval.decision, diagnostics: retrieval.diagnostics, started: Date.now(), summary: false,
    } satisfies Prepared;
    const answer = retrieval.decision.sufficient || clearlyGeneral(message)
      ? await this.answerWithGrounding(prepared, message, prompt)
      : retrieval.client.config.fallbackMessage;
    return { answer, retrieval };
  }

  private async prepare(clientId: string, message: string, sessionId?: string): Promise<Prepared> {
    const client = await this.repo.getClient(clientId);
    if (!client?.enabled) throw new AppError(403, 'TENANT_DISABLED', 'Tenant is disabled');
    const sid = sessionId ?? crypto.randomUUID();
    const requestId = crypto.randomUUID();
    trace(requestId, 'REQUEST', { tenantId: client.id, knowledgeBaseId: client.id, question: redact(message, 500) });
    const conversationId = await this.repo.createConversation(clientId, sid);
    const prior = await this.repo.messages(conversationId);
    await this.repo.addMessage(conversationId, 'user', message);
    const history = prior.slice(-12);
    const started = Date.now();
    if (summaryRequest(message)) {
      const empty: EvidenceDecision = { status: 'NOT_SUPPORTED', coverage: 0, count: 0, sources: 0, sufficient: false };
      const prepared = { requestId, client, sid, conversationId, history, found: [], decision: empty, diagnostics: { query: message, expanded: false, profile: { documents: 0, chunks: 0, vocabulary: 0, topTerms: [] }, candidateCounts: { exact: 0, keyword: 0, bm25: 0, dense: 0, fused: 0 }, evidence: empty, rejected: [] }, started, summary: true } satisfies Prepared;
      trace(requestId, 'RETRIEVAL', { tenantId: client.id, retrievedChunks: 0, decision: empty, fallbackBranch: 'summary' });
      return prepared;
    }
    const retrieval = await this.retrieve(clientId, message);
    trace(requestId, 'RETRIEVAL', {
      tenantId: client.id, knowledgeBaseId: client.id, query: redact(retrieval.diagnostics.query, 500),
      retrievedChunks: retrieval.evidence.length,
      chunks: retrieval.evidence.map((x) => ({ id: x.id, source: x.source, score: x.score, text: redact(x.text) })),
      decision: retrieval.decision, diagnostics: retrieval.diagnostics,
    });
    return { requestId, client, sid, conversationId, history, found: retrieval.evidence, decision: retrieval.decision, diagnostics: retrieval.diagnostics, started, summary: false };
  }

  private input(prepared: Prepared, question: string, prompt = prepared.client.prompt) {
    return {
      question,
      prompt: `${prompt}\nEvidence decision: ${prepared.decision.status}. Answer only supported portions. If evidence is partial, state the supported portion and clearly qualify what is not available. If evidence is uncertain or absent for a tenant-specific fact, use the configured fallback message.`,
      context: prepared.found,
      config: prepared.client.config,
    };
  }

  private result(client: Client, sid: string, conversationId: string, answer: string, found: RetrievedChunk[]): ChatResult {
    return {
      sessionId: sid,
      conversationId,
      answer,
      sources: found.map((x) => ({ chunkId: x.id, source: x.source, score: Math.round(x.score * 1000) / 1000 })),
      leadCollection: client.config.collectLead
        ? { enabled: true, fields: ['name', ...(client.config.leadFields ?? ['email', 'requirement']).filter((field) => field !== 'name')] }
        : undefined,
    };
  }

  private async finalize(prepared: Prepared, answer: string) {
    const cleaned = cleanAnswerScaffolding(answer);
    trace(prepared.requestId, 'FINALIZE_START', { answerChars: cleaned.length, conversationId: prepared.conversationId });
    try {
      trace(prepared.requestId, 'PERSIST_MESSAGE_START', { conversationId: prepared.conversationId });
      await this.repo.addMessage(prepared.conversationId, 'assistant', cleaned);
      trace(prepared.requestId, 'PERSIST_MESSAGE_DONE', { conversationId: prepared.conversationId });
      trace(prepared.requestId, 'PERSIST_USAGE_START', { tenantId: prepared.client.id, answerChars: cleaned.length });
      await this.repo.usage(prepared.client.id, 'chat', cleaned.length, Date.now() - prepared.started);
      trace(prepared.requestId, 'PERSIST_USAGE_DONE', { tenantId: prepared.client.id });
      const result = this.result(prepared.client, prepared.sid, prepared.conversationId, cleaned, prepared.found);
      trace(prepared.requestId, 'FINALIZE_DONE', { answerChars: cleaned.length });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: typeof error, message: String(error), stack: undefined };
      trace(prepared.requestId, 'POST_GROUNDING_EXCEPTION', { function: 'ChatService.finalize', ...detail });
      throw error;
    }
  }

  async chat(clientId: string, message: string, sessionId?: string): Promise<ChatResult> {
    const prepared = await this.prepare(clientId, message, sessionId);
    if (prepared.summary) { trace(prepared.requestId, 'FALLBACK', { reason: 'summary-request', answer: prepared.client.config.fallbackMessage }); return this.finalize(prepared, prepared.client.config.fallbackMessage); }
    if (!prepared.decision.sufficient && !clearlyGeneral(message)) { trace(prepared.requestId, 'FALLBACK', { reason: 'evidence-insufficient-before-llm', decision: prepared.decision, answer: prepared.client.config.fallbackMessage }); return this.finalize(prepared, prepared.client.config.fallbackMessage); }
    return this.finalize(prepared, await this.answerWithGrounding(prepared, message));
  }

  async stream(clientId: string, message: string, sessionId: string | undefined, onToken: (token: string) => void): Promise<ChatResult> {
    const prepared = await this.prepare(clientId, message, sessionId);
    if (prepared.summary) {
      trace(prepared.requestId, 'FALLBACK', { reason: 'summary-request', answer: prepared.client.config.fallbackMessage });
      const fallback = prepared.client.config.fallbackMessage;
      for (const token of answerTokens(fallback)) onToken(token);
      return this.finalize(prepared, fallback);
    }
    if (!prepared.decision.sufficient && !clearlyGeneral(message)) {
      trace(prepared.requestId, 'FALLBACK', { reason: 'evidence-insufficient-before-llm', decision: prepared.decision, answer: prepared.client.config.fallbackMessage });
      const fallback = prepared.client.config.fallbackMessage;
      for (const token of answerTokens(fallback)) onToken(token);
      return this.finalize(prepared, fallback);
    }

    // Do not expose provider tokens until the complete answer has passed grounding.
    let streamed = '';
    await this.llm.streamAnswer(this.input(prepared, message), (token) => { streamed += token; });
    let answer = cleanAnswerScaffolding(streamed);
    const check = validateGrounding(message, answer, prepared.found);
    trace(prepared.requestId, 'GROUNDING_FIRST', { rawAnswer: redact(answer), validation: check, evidenceCount: prepared.found.length, mode: 'stream-buffered' });
    if (!check.ok) {
      answer = cleanAnswerScaffolding(await this.llm.answer(
        this.input(prepared, message, `${prepared.client.prompt}\n${groundingCorrection(check.reasons)}`),
      ));
      const correctedCheck = validateGrounding(message, answer, prepared.found);
      trace(prepared.requestId, 'GROUNDING_CORRECTION', { reasons: check.reasons, correctedAnswer: redact(answer), validation: correctedCheck, final: correctedCheck.ok ? 'corrected-answer' : 'fallback', fallbackMessage: prepared.client.config.fallbackMessage, mode: 'stream-buffered' });
      if (!correctedCheck.ok) answer = prepared.client.config.fallbackMessage;
    }
    if (answer === prepared.client.config.fallbackMessage && check.ok) trace(prepared.requestId, 'FALLBACK', { reason: 'provider-returned-configured-fallback', answer });
    const outputTokens = answerTokens(answer);
    trace(prepared.requestId, 'STREAM_DELIVERY_START', { tokenCount: outputTokens.length, answerChars: answer.length });
    for (const token of outputTokens) onToken(token);
    trace(prepared.requestId, 'STREAM_DELIVERY_DONE', { tokenCount: outputTokens.length });
    trace(prepared.requestId, 'FINALIZE_CALL', { branch: 'stream-success' });
    return this.finalize(prepared, answer);
  }
}
