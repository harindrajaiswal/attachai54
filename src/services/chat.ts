import crypto from 'node:crypto';
import type { Repository } from '../repositories/repository.js';
import type { EmbeddingProvider } from '../providers/embedding.js';
import type { VectorProvider } from '../providers/vector.js';
import type { LlmProvider } from '../providers/llm.js';
import type { Client, ChatMessage, RetrievedChunk } from '../domain/types.js';
import { AppError } from '../lib/errors.js';
import {
  buildAlternativeQueries,
  cleanAnswerScaffolding,
  retrieveAdvancedEvidence,
  tokens as ragTokens,
  type EvidenceDecision,
  type RetrievalDiagnostics,
  type StageTimings,
} from './advanced-rag.js';
import { groundingCorrection, validateGrounding } from './grounding.js';

export type QueryIntent =
  | 'greeting'
  | 'closing'
  | 'identity'
  | 'summary'
  | 'follow_up'
  | 'ambiguous'
  | 'general'
  | 'knowledge';

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
  intent: QueryIntent;
  timings: StageTimings;
};

const summaryRequest = (message: string) =>
  /\b(summari[sz]e|summary|recap|what did we discuss|what have we discussed|what you just (?:said|told me)|what did i)\b/i.test(
    message,
  );
const isGreeting = (message: string) =>
  /^(hi|hello|hey|hi there|hello there|good morning|good afternoon|good evening|greetings)[!.? ]*$/i.test(
    message.trim(),
  );
const isClosing = (message: string) =>
  /^(thanks|thank you|thank you so much|thx|okay|ok|got it)[!.? ]*$/i.test(message.trim());
const clearlyGeneral = (message: string) =>
  isGreeting(message) ||
  isClosing(message) ||
  /^(how are you|tell me a joke|what is the meaning of life)[!.? ]*$/i.test(message.trim());
const isFollowUpQuestion = (message: string) =>
  /\b(it|its|they|them|their|that|this|those|these|he|she|his|her|same|above|previous|mentioned|earlier)\b/i.test(
    message,
  ) || /^(?:and|also|what about|how about)\b/i.test(message.trim());
const isIdentityQuestion = (message: string) =>
  /^(who are you|what are you|what(?:'s| is) your name|tell me about yourself|who created you|who developed you|what company do you belong to|which ai model are you|are you\s+\S+)[!?., ]*$/i.test(
    message.trim(),
  );

export function classifyIntent(message: string, history: ChatMessage[] = []): QueryIntent {
  if (isGreeting(message)) return 'greeting';
  if (isClosing(message)) return 'closing';
  if (isIdentityQuestion(message)) return 'identity';
  if (summaryRequest(message)) return 'summary';
  if (/^(how are you|tell me a joke|what is the meaning of life)[!.? ]*$/i.test(message.trim())) {
    return 'general';
  }
  const contentTerms = ragTokens(message);
  if (history.length > 0 && isFollowUpQuestion(message)) return 'follow_up';
  if (history.length === 0 && isFollowUpQuestion(message) && contentTerms.length === 0) {
    return 'ambiguous';
  }
  return 'knowledge';
}

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

function emptyTimings(): StageTimings {
  return {
    classificationMs: 0,
    dbReadMs: 0,
    embeddingMs: 0,
    initialRetrievalMs: 0,
    reformulationMs: 0,
    additionalRetrievalMs: 0,
    rerankAndContextMs: 0,
    llmFirstTokenMs: 0,
    llmCompleteMs: 0,
    groundingMs: 0,
    correctionMs: 0,
    dbWriteMs: 0,
    totalMs: 0,
    llmCalls: 0,
    embeddingCalls: 0,
    retrievalRounds: 0,
  };
}

function professionalFallback(client: Client) {
  const company = client.config.companyName?.trim() || client.name;
  const contact = client.config.teamEmail?.trim();
  return contact
    ? `I don’t have verified information about that in the information provided by ${company}. For the most accurate answer, please contact ${company} directly at ${contact}.`
    : `I don’t have verified information about that in the information provided by ${company}. Please contact ${company} directly through its official support channel for the most accurate answer.`;
}

function greetingOrClosingResponse(intent: QueryIntent, client: Client): string | null {
  const assistant = client.config.assistantName.trim();
  const company = client.config.companyName?.trim() || client.name;
  if (intent === 'greeting') {
    if (client.config.welcomeMessage?.trim()) return client.config.welcomeMessage.trim();
    return `Hello! I’m ${assistant} for ${company}. How can I help you today?`;
  }
  if (intent === 'closing') {
    return 'You’re welcome! Let me know if there is anything else I can help you with.';
  }
  if (intent === 'ambiguous') {
    return `Could you please clarify which ${company} product, service, or topic you are asking about so I can help?`;
  }
  return null;
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
  const hasUserStatement = history.some(
    (m) => m.role === "user" && m.content.trim() && !m.content.trim().endsWith("?"),
  );
  if (isFollowUpQuestion(question) && hasUserStatement) return true;
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

  async retrieve(
    clientId: string,
    message: string,
    history: ChatMessage[] = [],
    timings: StageTimings = emptyTimings(),
  ) {
    const tDb = Date.now();
    const client = await this.repo.getClient(clientId);
    timings.dbReadMs += Date.now() - tDb;
    if (!client?.enabled) throw new AppError(403, 'TENANT_DISABLED', 'Tenant is disabled');

    const k = Math.min(client.config.topK ?? 20, 40);
    const threshold = client.config.minSimilarity ?? 0.05;

    const tEmbed = Date.now();
    const [queryVector] = await this.embedding.embed([message]);
    timings.embeddingMs += Date.now() - tEmbed;
    timings.embeddingCalls += 1;

    const tInitRet = Date.now();
    const initialDense = await this.vector.search(clientId, queryVector!, k, threshold);
    const hasListTenant = typeof this.vector.listTenant === 'function';
    const tenantCorpus = hasListTenant ? await this.vector.listTenant(clientId, 2000) : initialDense;
    timings.initialRetrievalMs += Date.now() - tInitRet;
    timings.retrievalRounds += 1;

    let dense = initialDense;
    let effectiveQuery = message;
    const tRerank = Date.now();
    let result = await retrieveAdvancedEvidence({
      question: message,
      corpus: hasListTenant ? tenantCorpus : dense,
      dense,
    });
    timings.rerankAndContextMs += Date.now() - tRerank;

    if (history.length > 0 && isFollowUpQuestion(message)) {
      const historyTerms = [
        ...new Set(
          history
            .filter((m) => !isGenericFallback(m.content) && m.content !== client.config.fallbackMessage)
            .slice(-4)
            .flatMap((m) => ragTokens(m.content))
            .filter((t) => t.length > 2),
        ),
      ].slice(-8);
      if (historyTerms.length) {
        const contextualQuery = `${historyTerms.join(' ')} ${message}`;
        const tCtx = Date.now();
        const contextualResult = await retrieveAdvancedEvidence({
          question: contextualQuery,
          corpus: hasListTenant ? tenantCorpus : dense,
          dense,
        });
        timings.rerankAndContextMs += Date.now() - tCtx;
        if (contextualResult.decision.sufficient) {
          result = contextualResult;
          effectiveQuery = contextualQuery;
        } else if (!result.decision.sufficient) {
          const tEmb2 = Date.now();
          const [contextVec] = await this.embedding.embed([contextualQuery]);
          timings.embeddingMs += Date.now() - tEmb2;
          timings.embeddingCalls += 1;

          const tAddRet = Date.now();
          const contextDense = await this.vector.search(clientId, contextVec!, k, threshold);
          timings.additionalRetrievalMs += Date.now() - tAddRet;
          timings.retrievalRounds += 1;

          if (contextDense.length) {
            const byId = new Map(dense.map((c) => [c.id, c]));
            for (const c of contextDense) {
              const prev = byId.get(c.id);
              if (!prev || c.score > prev.score) byId.set(c.id, c);
            }
            dense = [...byId.values()];
            const tRerank2 = Date.now();
            result = await retrieveAdvancedEvidence({
              question: contextualQuery,
              corpus: hasListTenant ? tenantCorpus : dense,
              dense,
            });
            timings.rerankAndContextMs += Date.now() - tRerank2;
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
      const tRef = Date.now();
      const reformulated = await this.llm.reformulate({
        question: message,
        prompt: client.prompt,
        context: result.evidence,
        config: client.config,
        history,
      });
      timings.reformulationMs += Date.now() - tRef;
      timings.llmCalls += 1;

      const altQueries = (reformulated ?? '')
        .split(/\r?\n|\s*\|\s*/)
        .map((x) => x.trim().replace(/^[-*\d.)]+\s*/, ''))
        .filter((x) => x && x.toUpperCase() !== 'NONE')
        .slice(0, 3);
      if (altQueries.length) {
        const byId = new Map(dense.map((c) => [c.id, c]));
        for (const alt of altQueries) {
          const tEmbAlt = Date.now();
          const [altVec] = await this.embedding.embed([alt]);
          timings.embeddingMs += Date.now() - tEmbAlt;
          timings.embeddingCalls += 1;

          const tRetAlt = Date.now();
          const altDense = await this.vector.search(clientId, altVec!, k, threshold);
          timings.additionalRetrievalMs += Date.now() - tRetAlt;
          timings.retrievalRounds += 1;

          for (const c of altDense) {
            const prev = byId.get(c.id);
            if (!prev || c.score > prev.score) byId.set(c.id, c);
          }
        }
        dense = [...byId.values()];
        const tRerankAlt = Date.now();
        result = await retrieveAdvancedEvidence({
          question: `${effectiveQuery} ${altQueries.join(' ')}`,
          corpus: hasListTenant ? tenantCorpus : dense,
          dense,
        });
        timings.rerankAndContextMs += Date.now() - tRerankAlt;
      }
    } else if (
      !result.decision.sufficient &&
      dense.length === 0 &&
      typeof this.llm.reformulate !== 'function'
    ) {
      const detAlt = buildAlternativeQueries(message, history)[0];
      if (detAlt && detAlt !== message) {
        const tEmbDet = Date.now();
        const [altVec] = await this.embedding.embed([detAlt]);
        timings.embeddingMs += Date.now() - tEmbDet;
        timings.embeddingCalls += 1;

        const tRetDet = Date.now();
        const altDense = await this.vector.search(clientId, altVec!, k, threshold);
        timings.additionalRetrievalMs += Date.now() - tRetDet;
        timings.retrievalRounds += 1;

        if (altDense.length) {
          dense = altDense;
          const tRerankDet = Date.now();
          result = await retrieveAdvancedEvidence({
            question: `${message} ${detAlt}`,
            corpus: hasListTenant ? tenantCorpus : dense,
            dense,
          });
          timings.rerankAndContextMs += Date.now() - tRerankDet;
        }
      }
    }

    result.diagnostics.timings = timings;
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
    const tLlm = Date.now();
    const rawFirst = await this.llm.answer(this.input(prepared, question, prompt));
    const llmElapsed = Date.now() - tLlm;
    prepared.timings.llmFirstTokenMs = llmElapsed;
    prepared.timings.llmCompleteMs += llmElapsed;
    prepared.timings.llmCalls += 1;

    const first = cleanAnswerScaffolding(rawFirst);
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
    const tGround1 = Date.now();
    const firstCheck = validateGrounding(question, first, groundingEvidence);
    prepared.timings.groundingMs += Date.now() - tGround1;

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
    const tCorr = Date.now();
    const rawCorrected = await this.llm.answer(
      this.input(prepared, question, `${prompt}\n${groundingCorrection(reasons)}`),
    );
    prepared.timings.correctionMs += Date.now() - tCorr;
    prepared.timings.llmCalls += 1;

    const corrected = cleanAnswerScaffolding(rawCorrected);
    const tGround2 = Date.now();
    const correctedCheck = validateGrounding(question, corrected, groundingEvidence);
    prepared.timings.groundingMs += Date.now() - tGround2;

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
    const started = Date.now();
    const timings = emptyTimings();
    const tClass = Date.now();
    const intent = classifyIntent(message, []);
    timings.classificationMs = Date.now() - tClass;

    const retrieval = await this.retrieve(clientId, message, [], timings);
    const prepared = {
      requestId: crypto.randomUUID(),
      client: retrieval.client,
      sid: '',
      conversationId: '',
      history: [],
      found: retrieval.evidence,
      decision: retrieval.decision,
      diagnostics: retrieval.diagnostics,
      started,
      summary: false,
      intent,
      timings,
    } satisfies Prepared;
    const social = greetingOrClosingResponse(intent, retrieval.client);
    const answer =
      social && !retrieval.decision.sufficient
        ? social
        : retrieval.decision.sufficient || clearlyGeneral(message)
          ? await this.answerWithGrounding(prepared, message, prompt)
          : retrieval.client.config.fallbackMessage;
    timings.totalMs = Date.now() - started;
    retrieval.diagnostics.timings = timings;
    return { answer, retrieval };
  }

  private async prepare(clientId: string, message: string, sessionId?: string): Promise<Prepared> {
    const started = Date.now();
    const timings = emptyTimings();
    const tDb = Date.now();
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
    timings.dbReadMs += Date.now() - tDb;

    const history = boundHistory(prior);
    const tClass = Date.now();
    const intent = classifyIntent(message, history);
    timings.classificationMs = Date.now() - tClass;

    const isSummary = intent === 'summary';
    if (
      isSummary ||
      intent === 'greeting' ||
      intent === 'closing' ||
      intent === 'identity' ||
      intent === 'general' ||
      intent === 'ambiguous'
    ) {
      const empty: EvidenceDecision = {
        status: 'NOT_SUPPORTED',
        coverage: 0,
        count: 0,
        sources: 0,
        sufficient: false,
      };
      const diagnostics: RetrievalDiagnostics = {
        query: message,
        expanded: false,
        profile: { documents: 0, chunks: 0, vocabulary: 0, topTerms: [] },
        candidateCounts: { exact: 0, keyword: 0, bm25: 0, dense: 0, fused: 0 },
        evidence: empty,
        rejected: [],
        timings,
      };
      const prepared = {
        requestId,
        client,
        sid,
        conversationId,
        history,
        found: [],
        decision: empty,
        diagnostics,
        started,
        summary: isSummary,
        intent,
        timings,
      } satisfies Prepared;
      trace(requestId, 'RETRIEVAL', {
        tenantId: client.id,
        retrievedChunks: 0,
        decision: empty,
        fallbackBranch: intent,
      });
      return prepared;
    }
    const retrieval = await this.retrieve(clientId, message, history, timings);
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
      intent,
      timings,
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
    const tWrite = Date.now();
    try {
      await this.repo.addMessage(prepared.conversationId, 'assistant', cleaned);
      const totalElapsed = Date.now() - prepared.started;
      await this.repo.usage(prepared.client.id, 'chat', cleaned.length, totalElapsed);
      if (prepared.found.length > 0 && typeof this.repo.audit === 'function') {
        await this.repo.audit(prepared.client.id, 'chat.completed', {
          conversationId: prepared.conversationId,
          sources: [...new Set(prepared.found.map((x) => x.source))],
        });
      }
      prepared.timings.dbWriteMs += Date.now() - tWrite;
      prepared.timings.totalMs = Date.now() - prepared.started;
      trace(prepared.requestId, 'TIMINGS', {
        tenantId: prepared.client.id,
        intent: prepared.intent,
        timings: prepared.timings,
      });
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
    if (
      prepared.intent === 'greeting' ||
      prepared.intent === 'closing' ||
      prepared.intent === 'ambiguous'
    ) {
      const response = greetingOrClosingResponse(prepared.intent, prepared.client)!;
      return this.finalize(prepared, response);
    }
    if (prepared.summary) {
      if (!prepared.history.length) {
        return this.finalize(prepared, prepared.client.config.fallbackMessage);
      }
      const tLlm = Date.now();
      const rawSummary = await this.llm.answer(this.input(prepared, message));
      prepared.timings.llmFirstTokenMs = Date.now() - tLlm;
      prepared.timings.llmCompleteMs += Date.now() - tLlm;
      prepared.timings.llmCalls += 1;
      const summary = cleanAnswerScaffolding(rawSummary);
      return this.finalize(prepared, summary || prepared.client.config.fallbackMessage);
    }
    const canUseHistory = hasConversationSupport(message, prepared.history);
    if (
      !prepared.decision.sufficient &&
      prepared.intent !== 'general' &&
      prepared.intent !== 'identity' &&
      !canUseHistory
    ) {
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
    if (
      prepared.intent === 'greeting' ||
      prepared.intent === 'closing' ||
      prepared.intent === 'ambiguous'
    ) {
      const response = greetingOrClosingResponse(prepared.intent, prepared.client)!;
      for (const token of answerTokens(response)) onToken(token);
      return this.finalize(prepared, response);
    }
    if (prepared.summary) {
      if (!prepared.history.length) {
        const fallback = prepared.client.config.fallbackMessage;
        for (const token of answerTokens(fallback)) onToken(token);
        return this.finalize(prepared, fallback);
      }
      let streamedSummary = '';
      const tLlm = Date.now();
      let firstTokenRecorded = false;
      await this.llm.streamAnswer(this.input(prepared, message), (token) => {
        if (!firstTokenRecorded) {
          prepared.timings.llmFirstTokenMs = Date.now() - tLlm;
          firstTokenRecorded = true;
        }
        streamedSummary += token;
      });
      prepared.timings.llmCompleteMs += Date.now() - tLlm;
      prepared.timings.llmCalls += 1;
      const summary =
        cleanAnswerScaffolding(streamedSummary) || prepared.client.config.fallbackMessage;
      for (const token of answerTokens(summary)) onToken(token);
      return this.finalize(prepared, summary);
    }
    const canUseHistory = hasConversationSupport(message, prepared.history);
    if (
      !prepared.decision.sufficient &&
      prepared.intent !== 'general' &&
      prepared.intent !== 'identity' &&
      !canUseHistory
    ) {
      const fallback =
        prepared.found.length === 0
          ? professionalFallback(prepared.client)
          : prepared.client.config.fallbackMessage;
      for (const token of answerTokens(fallback)) onToken(token);
      return this.finalize(prepared, fallback);
    }

    // Do not expose provider tokens until the complete answer has passed grounding.
    let streamed = '';
    const tLlm = Date.now();
    let firstTokenRecorded = false;
    await this.llm.streamAnswer(this.input(prepared, message), (token) => {
      if (!firstTokenRecorded) {
        prepared.timings.llmFirstTokenMs = Date.now() - tLlm;
        firstTokenRecorded = true;
      }
      streamed += token;
    });
    prepared.timings.llmCompleteMs += Date.now() - tLlm;
    prepared.timings.llmCalls += 1;

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
    const tGround1 = Date.now();
    const check = validateGrounding(message, answer, groundingEvidence);
    prepared.timings.groundingMs += Date.now() - tGround1;

    const unexpectedRefusal =
      prepared.found.length > 0 &&
      (isGenericFallback(answer) || answer === prepared.client.config.fallbackMessage);
    if (!check.ok || unexpectedRefusal) {
      const reasons = check.reasons.length
        ? check.reasons
        : ['generic fallback despite tenant evidence'];
      const tCorr = Date.now();
      const rawCorrected = await this.llm.answer(
        this.input(prepared, message, `${prepared.client.prompt}\n${groundingCorrection(reasons)}`),
      );
      prepared.timings.correctionMs += Date.now() - tCorr;
      prepared.timings.llmCalls += 1;

      answer = cleanAnswerScaffolding(rawCorrected);
      const tGround2 = Date.now();
      const correctedCheck = validateGrounding(message, answer, groundingEvidence);
      prepared.timings.groundingMs += Date.now() - tGround2;

      const stillRefused =
        prepared.found.length > 0 &&
        (isGenericFallback(answer) || answer === prepared.client.config.fallbackMessage);
      if (!correctedCheck.ok || stillRefused) answer = prepared.client.config.fallbackMessage;
    }
    for (const token of answerTokens(answer)) onToken(token);
    return this.finalize(prepared, answer);
  }
}
