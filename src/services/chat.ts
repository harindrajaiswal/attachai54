import crypto from 'node:crypto';
import type { Repository } from '../repositories/repository.js';
import type { EmbeddingProvider } from '../providers/embedding.js';
import type { VectorProvider } from '../providers/vector.js';
import type { LlmProvider } from '../providers/llm.js';
import type { Client, ChatMessage, RetrievedChunk } from '../domain/types.js';
import { AppError } from '../lib/errors.js';
import {
  cleanAnswerScaffolding,
  retrieveAdvancedEvidence,
  tokens as ragTokens,
  type EvidenceDecision,
  type RetrievalDiagnostics,
} from './advanced-rag.js';
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

const summaryRequest = (message: string) =>
  /\b(summari[sz]e|summary|recap|what did we discuss|what have we discussed|what you just (?:said|told me)|what did i)\b/i.test(
    message,
  );
const clearlyGeneral = (message: string) =>
  /^(hi|hello|hey|thanks|thank you|okay|ok|good morning|good afternoon|good evening|how are you|tell me a joke|what is the meaning of life)[!.? ]*$/i.test(
    message.trim(),
  );
const isFollowUpQuestion = (message: string) =>
  /\b(it|its|they|them|their|that|this|those|these|he|she|his|her|same|above|previous|mentioned|earlier)\b/i.test(
    message,
  ) || /^(?:and|also|what about|how about)\b/i.test(message.trim());
const answerTokens = (answer: string) => answer.match(/\S+\s*/g) ?? [];
const redact = (value: string, limit = 1200) =>
  value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, '[REDACTED_PHONE]')
    .slice(0, limit);
const trace = (requestId: string, event: string, data: Record<string, unknown>) => {
  if (process.env.ORBIT_RAG_DIAGNOSTICS === '1') {
    console.log(JSON.stringify({ groundingTrace: true, requestId, event, ...data }));
  }
};

function professionalFallback(client: Client) {
  const company = client.config.companyName?.trim() || client.name;
  const contact = client.config.teamEmail?.trim();
  return contact
    ? `I don’t have verified information about that in the information provided by ${company}. For the most accurate answer, please contact ${company} directly at ${contact}.`
    : `I don’t have verified information about that in the information provided by ${company}. Please contact ${company} directly through its official support channel for the most accurate answer.`;
}

function isGenericFallback(answer: string) {
  return /\b(?:sorry|apolog(?:y|ize|ise)|don['’]?t|do not|cannot|can['’]?t)\b[\s,]*(?:have|know|possess|find|verify)|\b(?:no|not)\s+(?:verified\s+)?information\b/i.test(
    answer,
  );
}

function boundHistory(prior: ChatMessage[], maxRecent = 12, maxChars = 4000): ChatMessage[] {
  if (!prior.length) return [];
  if (
    prior.length <= maxRecent &&
    prior.reduce((sum, m) => sum + m.content.length, 0) <= maxChars
  ) {
    return prior;
  }
  const recent: ChatMessage[] = [];
  let used = 0;
  for (let i = prior.length - 1; i >= 0 && recent.length < maxRecent - 1; i--) {
    const msg = prior[i]!;
    if (used + msg.content.length > maxChars - 600 && recent.length >= 4) break;
    recent.unshift(msg);
    used += msg.content.length;
  }
  const olderCount = prior.length - recent.length;
  if (olderCount <= 0) return recent;
  const olderFacts = prior
    .slice(0, olderCount)
    .map((m) => m.content.trim())
    .filter((c) => c && !c.endsWith('?'))
    .join(' ')
    .slice(0, 600);
  return olderFacts
    ? [{ role: 'assistant', content: `Earlier context: ${olderFacts}` }, ...recent]
    : recent;
}

function hasConversationSupport(question: string, history: ChatMessage[]): boolean {
  if (!history.length) return false;
  const qTerms = new Set(ragTokens(question));
  if (!qTerms.size) return false;
  const statements = history
    .map((m) => m.content.trim())
    .filter((c) => c && !c.endsWith('?') && !isGenericFallback(c));
  for (const stmt of statements) {
    const sTerms = new Set(ragTokens(stmt));
    const hits = [...qTerms].filter((t) => sTerms.has(t)).length;
    if (hits >= 2 || (isFollowUpQuestion(question) && hits >= 1)) return true;
  }
  return false;
}

/** Tenant-scoped orchestration. Retrieval supports standalone and follow-up queries with bounded history. */
export class ChatService {
  constructor(
    private repo: Repository,
    private embedding: EmbeddingProvider,
    private vector: VectorProvider,
    private llm: LlmProvider,
  ) {}

  async retrieve(clientId: string, message: string, history: ChatMessage[] = []) {
    const client = await this.repo.getClient(clientId);
    if (!client?.enabled) throw new AppError(403, 'TENANT_DISABLED', 'Tenant is disabled');
    const k = Math.min(client.config.topK ?? 20, 40);
    const threshold = client.config.minSimilarity ?? 0.05;
    const [queryVector] = await this.embedding.embed([message]);
    const initialDense = await this.vector.search(clientId, queryVector!, k, threshold);
    const hasListTenant = typeof this.vector.listTenant === 'function';
    const tenantCorpus = hasListTenant ? await this.vector.listTenant(clientId, 2000) : initialDense;

    let dense = initialDense;
    let effectiveQuery = message;
    let result = await retrieveAdvancedEvidence({
      question: message,
      corpus: hasListTenant ? tenantCorpus : dense,
      dense,
    });

    if (history.length > 0 && isFollowUpQuestion(message)) {
      const historyTerms = [
        ...new Set(
          history
            .slice(-4)
            .flatMap((m) => ragTokens(m.content))
            .filter((t) => t.length > 2),
        ),
      ].slice(-8);
      if (historyTerms.length) {
        const contextualQuery = `${historyTerms.join(' ')} ${message}`;
        const contextualResult = await retrieveAdvancedEvidence({
          question: contextualQuery,
          corpus: hasListTenant ? tenantCorpus : dense,
          dense,
        });
        if (contextualResult.decision.sufficient) {
          result = contextualResult;
          effectiveQuery = contextualQuery;
        } else if (!result.decision.sufficient) {
          const [contextVec] = await this.embedding.embed([contextualQuery]);
          const contextDense = await this.vector.search(clientId, contextVec!, k, threshold);
          if (contextDense.length) {
            const byId = new Map(dense.map((c) => [c.id, c]));
            for (const c of contextDense) {
              const prev = byId.get(c.id);
              if (!prev || c.score > prev.score) byId.set(c.id, c);
            }
            dense = [...byId.values()];
            result = await retrieveAdvancedEvidence({
              question: contextualQuery,
              corpus: hasListTenant ? tenantCorpus : dense,
              dense,
            });
            effectiveQuery = contextualQuery;
          }
        }
      }
    }

    const bestDenseScore = dense.reduce((max, c) => Math.max(max, c.score), 0);
    const weakInitial =
      !result.decision.sufficient ||
      (bestDenseScore < Math.max(0.55, threshold + 0.2) && result.decision.coverage < 0.55);
    if (weakInitial && typeof this.llm.reformulate === 'function') {
      const reformulated = await this.llm.reformulate({
        question: message,
        prompt: client.prompt,
        context: result.evidence,
        config: client.config,
        history,
      });
      const altQueries = (reformulated ?? '')
        .split(/\r?\n|\s*\|\s*/)
        .map((x) => x.trim().replace(/^[-*\d.)]+\s*/, ''))
        .filter((x) => x && x.toUpperCase() !== 'NONE')
        .slice(0, 3);
      if (altQueries.length) {
        const byId = new Map(dense.map((c) => [c.id, c]));
        for (const alt of altQueries) {
          const [altVec] = await this.embedding.embed([alt]);
          const altDense = await this.vector.search(clientId, altVec!, k, threshold);
          for (const c of altDense) {
            const prev = byId.get(c.id);
            if (!prev || c.score > prev.score) byId.set(c.id, c);
          }
        }
        dense = [...byId.values()];
        result = await retrieveAdvancedEvidence({
          question: `${effectiveQuery} ${altQueries.join(' ')}`,
          corpus: hasListTenant ? tenantCorpus : dense,
          dense,
        });
      }
    }

    return { client, ...result };
  }

  private selectEvidence(candidates: RetrievedChunk[], question: string) {
    // Compatibility helper for callers outside the active pipeline; near-tied
    // semantic scores promote the candidate with stronger lexical overlap.
    const queryTerms = new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
    return candidates.slice().sort((a, b) => {
      const score = (chunk: RetrievedChunk) =>
        [...queryTerms].filter((term) => chunk.text.toLowerCase().includes(term)).length;
      return Math.abs(b.score - a.score) > 0.08
        ? b.score - a.score
        : score(b) - score(a) || b.score - a.score;
    });
  }

  /**
   * Generate once, validate against the exact selected tenant evidence, and allow
   * one bounded correction generation. A failed correction is never shown.
   */
  private async answerWithGrounding(
    prepared: Prepared,
    question: string,
    prompt = prepared.client.prompt,
  ) {
    const first = cleanAnswerScaffolding(
      await this.llm.answer(this.input(prepared, question, prompt)),
    );
    const groundingEvidence: RetrievedChunk[] =
      prepared.history.length && isFollowUpQuestion(question)
        ? [
            ...prepared.found,
            ...prepared.history.map((m, idx) => ({
              id: `history-${idx}`,
              source: 'conversation',
              text: m.content,
              score: 1,
            })),
          ]
        : prepared.found;
    const firstCheck = validateGrounding(question, first, groundingEvidence);
    const unexpectedRefusal =
      prepared.found.length > 0 &&
      (isGenericFallback(first) || first === prepared.client.config.fallbackMessage);
    trace(prepared.requestId, 'GROUNDING_FIRST', {
      rawAnswer: redact(first),
      validation: firstCheck,
      evidenceCount: prepared.found.length,
    });
    if (firstCheck.ok && !unexpectedRefusal) return first;

    const reasons = firstCheck.reasons.length
      ? firstCheck.reasons
      : ['generic fallback despite tenant evidence'];
    const corrected = cleanAnswerScaffolding(
      await this.llm.answer(
        this.input(prepared, question, `${prompt}\n${groundingCorrection(reasons)}`),
      ),
    );
    const correctedCheck = validateGrounding(question, corrected, groundingEvidence);
    const stillRefused =
      prepared.found.length > 0 &&
      (isGenericFallback(corrected) || corrected === prepared.client.config.fallbackMessage);
    trace(prepared.requestId, 'GROUNDING_CORRECTION', {
      reasons,
      correctedAnswer: redact(corrected),
      validation: correctedCheck,
      final: correctedCheck.ok && !stillRefused ? 'corrected-answer' : 'fallback',
      fallbackMessage: prepared.client.config.fallbackMessage,
    });
    return correctedCheck.ok && !stillRefused
      ? corrected
      : prepared.client.config.fallbackMessage;
  }

  async preview(clientId: string, message: string, prompt: string) {
    const retrieval = await this.retrieve(clientId, message);
    const prepared = {
      requestId: crypto.randomUUID(),
      client: retrieval.client,
      sid: '',
      conversationId: '',
      history: [],
      found: retrieval.evidence,
      decision: retrieval.decision,
      diagnostics: retrieval.diagnostics,
      started: Date.now(),
      summary: false,
    } satisfies Prepared;
    const answer =
      retrieval.decision.sufficient || clearlyGeneral(message)
        ? await this.answerWithGrounding(prepared, message, prompt)
        : retrieval.client.config.fallbackMessage;
    return { answer, retrieval };
  }

  private async prepare(clientId: string, message: string, sessionId?: string): Promise<Prepared> {
    const client = await this.repo.getClient(clientId);
    if (!client?.enabled) throw new AppError(403, 'TENANT_DISABLED', 'Tenant is disabled');
    const sid = sessionId ?? crypto.randomUUID();
    const requestId = crypto.randomUUID();
    trace(requestId, 'REQUEST', {
      tenantId: client.id,
      knowledgeBaseId: client.id,
      question: redact(message, 500),
    });
    const conversationId = await this.repo.createConversation(clientId, sid);
    const prior = await this.repo.messages(conversationId);
    await this.repo.addMessage(conversationId, 'user', message);
    const history = boundHistory(prior);
    const started = Date.now();
    const isSummary = summaryRequest(message);
    if (isSummary || clearlyGeneral(message)) {
      const empty: EvidenceDecision = {
        status: 'NOT_SUPPORTED',
        coverage: 0,
        count: 0,
        sources: 0,
        sufficient: false,
      };
      const prepared = {
        requestId,
        client,
        sid,
        conversationId,
        history,
        found: [],
        decision: empty,
        diagnostics: {
          query: message,
          expanded: false,
          profile: { documents: 0, chunks: 0, vocabulary: 0, topTerms: [] },
          candidateCounts: { exact: 0, keyword: 0, bm25: 0, dense: 0, fused: 0 },
          evidence: empty,
          rejected: [],
        },
        started,
        summary: isSummary,
      } satisfies Prepared;
      trace(requestId, 'RETRIEVAL', {
        tenantId: client.id,
        retrievedChunks: 0,
        decision: empty,
        fallbackBranch: isSummary ? 'summary' : 'general',
      });
      return prepared;
    }
    const retrieval = await this.retrieve(clientId, message, history);
    trace(requestId, 'RETRIEVAL', {
      tenantId: client.id,
      knowledgeBaseId: client.id,
      query: redact(retrieval.diagnostics.query, 500),
      retrievedChunks: retrieval.evidence.length,
      chunks: retrieval.evidence.map((x) => ({
        id: x.id,
        source: x.source,
        score: x.score,
        text: redact(x.text),
      })),
      decision: retrieval.decision,
      diagnostics: retrieval.diagnostics,
    });
    return {
      requestId,
      client,
      sid,
      conversationId,
      history,
      found: retrieval.evidence,
      decision: retrieval.decision,
      diagnostics: retrieval.diagnostics,
      started,
      summary: false,
    };
  }

  private input(prepared: Prepared, question: string, prompt = prepared.client.prompt) {
    const instruction = prepared.summary
      ? `${prompt}\nSummarize the conversation history accurately and concisely.`
      : `${prompt}\nEvidence decision: ${prepared.decision.status}. Answer only supported portions using tenant knowledge and, for follow-up questions, the conversation history. If evidence is partial, state the supported portion and clearly qualify what is not available. If evidence is uncertain or absent for a tenant-specific fact, use the configured fallback message.`;
    return {
      question,
      prompt: instruction,
      context: prepared.found,
      config: prepared.client.config,
      history: prepared.history,
    };
  }

  private result(
    client: Client,
    sid: string,
    conversationId: string,
    answer: string,
    found: RetrievedChunk[],
  ): ChatResult {
    return {
      sessionId: sid,
      conversationId,
      answer,
      sources: found.map((x) => ({
        chunkId: x.id,
        source: x.source,
        score: Math.round(x.score * 1000) / 1000,
      })),
      leadCollection: client.config.collectLead
        ? {
            enabled: true,
            fields: [
              'name',
              ...(client.config.leadFields ?? ['email', 'requirement']).filter(
                (field) => field !== 'name',
              ),
            ],
          }
        : undefined,
    };
  }

  private async finalize(prepared: Prepared, answer: string) {
    const cleaned = cleanAnswerScaffolding(answer);
    trace(prepared.requestId, 'FINALIZE_START', {
      answerChars: cleaned.length,
      conversationId: prepared.conversationId,
    });
    try {
      await this.repo.addMessage(prepared.conversationId, 'assistant', cleaned);
      await this.repo.usage(
        prepared.client.id,
        'chat',
        cleaned.length,
        Date.now() - prepared.started,
      );
      if (prepared.found.length > 0 && typeof this.repo.audit === 'function') {
        await this.repo.audit(prepared.client.id, 'chat.completed', {
          conversationId: prepared.conversationId,
          sources: [...new Set(prepared.found.map((x) => x.source))],
        });
      }
      return this.result(
        prepared.client,
        prepared.sid,
        prepared.conversationId,
        cleaned,
        prepared.found,
      );
    } catch (error) {
      const detail =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: typeof error, message: String(error), stack: undefined };
      trace(prepared.requestId, 'POST_GROUNDING_EXCEPTION', {
        function: 'ChatService.finalize',
        ...detail,
      });
      throw error;
    }
  }

  async chat(clientId: string, message: string, sessionId?: string): Promise<ChatResult> {
    const prepared = await this.prepare(clientId, message, sessionId);
    if (prepared.summary) {
      if (!prepared.history.length) {
        return this.finalize(prepared, prepared.client.config.fallbackMessage);
      }
      const summary = cleanAnswerScaffolding(
        await this.llm.answer(this.input(prepared, message)),
      );
      return this.finalize(prepared, summary || prepared.client.config.fallbackMessage);
    }
    const canUseHistory = hasConversationSupport(message, prepared.history);
    if (!prepared.decision.sufficient && !clearlyGeneral(message) && !canUseHistory) {
      const noEvidenceFallback =
        prepared.found.length === 0
          ? professionalFallback(prepared.client)
          : prepared.client.config.fallbackMessage;
      return this.finalize(prepared, noEvidenceFallback);
    }
    return this.finalize(prepared, await this.answerWithGrounding(prepared, message));
  }

  async stream(
    clientId: string,
    message: string,
    sessionId: string | undefined,
    onToken: (token: string) => void,
  ): Promise<ChatResult> {
    const prepared = await this.prepare(clientId, message, sessionId);
    if (prepared.summary) {
      if (!prepared.history.length) {
        const fallback = prepared.client.config.fallbackMessage;
        for (const token of answerTokens(fallback)) onToken(token);
        return this.finalize(prepared, fallback);
      }
      let streamedSummary = '';
      await this.llm.streamAnswer(this.input(prepared, message), (token) => {
        streamedSummary += token;
      });
      const summary =
        cleanAnswerScaffolding(streamedSummary) || prepared.client.config.fallbackMessage;
      for (const token of answerTokens(summary)) onToken(token);
      return this.finalize(prepared, summary);
    }
    const canUseHistory = hasConversationSupport(message, prepared.history);
    if (!prepared.decision.sufficient && !clearlyGeneral(message) && !canUseHistory) {
      const fallback =
        prepared.found.length === 0
          ? professionalFallback(prepared.client)
          : prepared.client.config.fallbackMessage;
      for (const token of answerTokens(fallback)) onToken(token);
      return this.finalize(prepared, fallback);
    }

    // Do not expose provider tokens until the complete answer has passed grounding.
    let streamed = '';
    await this.llm.streamAnswer(this.input(prepared, message), (token) => {
      streamed += token;
    });
    let answer = cleanAnswerScaffolding(streamed);
    const groundingEvidence: RetrievedChunk[] =
      prepared.history.length && isFollowUpQuestion(message)
        ? [
            ...prepared.found,
            ...prepared.history.map((m, idx) => ({
              id: `history-${idx}`,
              source: 'conversation',
              text: m.content,
              score: 1,
            })),
          ]
        : prepared.found;
    const check = validateGrounding(message, answer, groundingEvidence);
    const unexpectedRefusal =
      prepared.found.length > 0 &&
      (isGenericFallback(answer) || answer === prepared.client.config.fallbackMessage);
    if (!check.ok || unexpectedRefusal) {
      const reasons = check.reasons.length
        ? check.reasons
        : ['generic fallback despite tenant evidence'];
      answer = cleanAnswerScaffolding(
        await this.llm.answer(
          this.input(prepared, message, `${prepared.client.prompt}\n${groundingCorrection(reasons)}`),
        ),
      );
      const correctedCheck = validateGrounding(message, answer, groundingEvidence);
      const stillRefused =
        prepared.found.length > 0 &&
        (isGenericFallback(answer) || answer === prepared.client.config.fallbackMessage);
      if (!correctedCheck.ok || stillRefused) answer = prepared.client.config.fallbackMessage;
    }
    for (const token of answerTokens(answer)) onToken(token);
    return this.finalize(prepared, answer);
  }
}
