import type { ChatMessage, ClientConfig, ProviderHealth, RetrievedChunk } from '../domain/types.js';
import type { LlmConfig } from '../config/llm.js';
import { tokens as ragTokens } from '../services/advanced-rag.js';
export type ChatDebug = (stage: string, data: Record<string, unknown>) => void;
export interface LlmInput {
  question: string;
  prompt: string;
  context: RetrievedChunk[];
  config: ClientConfig;
  history?: ChatMessage[];
  debug?: ChatDebug;
}
export interface LlmProvider {
  readonly name: string;
  answer(input: LlmInput): Promise<string>;
  streamAnswer(input: LlmInput, onToken: (token: string) => void): Promise<string>;
  /** One bounded, tenant-scoped retrieval-query reformulation after an initial miss. */
  reformulate?(input: LlmInput): Promise<string | null>;
  health(): Promise<ProviderHealth>;
}
type Fetch = typeof fetch;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const retryable = (status: number) => [408, 409, 425, 429].includes(status) || status >= 500;
const approxTokens = (value: string) => Math.ceil(value.length / 4);
const debugPreview = (value: string, limit = 800) =>
  value
    .replace(/(?:sk|pk|api[_ -]?key|bearer)[=: ]+[A-Za-z0-9._-]+/gi, '[REDACTED_SECRET]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/(?:\+?\d[\d ()-]{7,}\d)/g, '[REDACTED_PHONE]')
    .slice(0, limit);

/** Customer-facing identity is tenant configuration, never the model/provider. */
export function tenantIdentityPolicy(config: ClientConfig) {
  const assistant = config.assistantName.trim();
  const company = config.companyName?.trim();
  const tenant = company ? `the company ${JSON.stringify(company)}` : 'the current tenant';
  return [
    `You are the customer-facing AI assistant for ${tenant}.`,
    `Your configured assistant identity is ${JSON.stringify(assistant)}.`,
    'Use that tenant identity when describing who you are, what you are, your name, your creator, or the company you belong to.',
    'Do not present the underlying language model, vendor, provider, or implementation as your customer-facing identity.',
    'If asked whether you are a particular AI model or provider, politely clarify that you are the tenant-branded assistant and explain your role instead.',
    'Do not invent a creator or disclose implementation details unless the tenant knowledge explicitly supports a customer-facing answer.',
  ].join(' ');
}

function explicitIdentityQuestion(question: string) {
  const text = question.trim().replace(/[!?.,]+$/g, '');
  return /^(who are you|what are you|what(?:'s| is) your name|tell me about yourself|who created you|who developed you|what company do you belong to|which ai model are you|are you\s+\S+)$/i.test(
    text,
  );
}

function tenantIdentityAnswer(question: string, config: ClientConfig) {
  if (!explicitIdentityQuestion(question)) return null;
  const assistant = config.assistantName.trim();
  const company = config.companyName?.trim();
  if (company)
    return `I’m ${company}'s AI assistant, ${assistant}. I’m here to help with ${company}'s products, services, and information.`;
  return `I’m ${assistant}. I’m here to help with this tenant’s products, services, and information.`;
}

export class LocalLlm implements LlmProvider {
  readonly name: string;
  constructor(private providerName = 'local') {
    this.name = providerName === 'local' ? 'local-extractive' : providerName;
  }
  async answer(i: LlmInput) {
    const identity = tenantIdentityAnswer(i.question, i.config);
    if (identity) return identity;
    if (
      /\b(summari[sz]e|summary|recap|what did i|what did we discuss|what have we discussed|what you just)\b/i.test(
        i.question,
      ) &&
      i.history?.length
    )
      return i.history
        .slice(-4)
        .map((x) => x.content)
        .join(' ');
    const stop = new Set([
      "what",
      "which",
      "who",
      "how",
      "when",
      "where",
      "why",
      "does",
      "did",
      "can",
      "will",
      "are",
      "was",
      "were",
      "the",
      "and",
      "for",
      "with",
      "that",
      "this",
      "its",
      "your",
      "you",
      "our",
      "from",
      "have",
      "has",
    ]);
    const rawTerms = new Set(
      (i.question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !stop.has(t)),
    );
    const normTerms = new Set(ragTokens(i.question));
    const followUp =
      /\b(it|its|they|them|their|that|this|those|these|he|she|his|her|same|above|previous|mentioned|earlier)\b/i.test(
        i.question,
      );
    const historyTerms = followUp
      ? new Set(
          (i.history ?? [])
            .slice(-4)
            .flatMap((m) => ragTokens(m.content))
            .filter((t) => t.length > 2),
        )
      : new Set<string>();
    const scoreText = (s: string, includeHistoryBonus = false) => {
      const sWords = new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
      const sNorm = new Set(ragTokens(s));
      const rawHits = [...rawTerms].filter((t) => sWords.has(t)).length;
      const normHits = [...normTerms].filter((t) => sNorm.has(t)).length;
      const base = Math.max(rawHits, normHits);
      if (!includeHistoryBonus || !historyTerms.size) return base;
      const histHits = [...historyTerms].filter((t) => sNorm.has(t) || sWords.has(t)).length;
      return base > 0 ? base + histHits * 0.25 : 0;
    };
    const contextSentences = i.context
      .flatMap((c) => c.text.split(/(?<=[.!?])\s+/))
      .map((s) => ({ s, hit: scoreText(s, true) }))
      .filter((x) => x.hit > 0)
      .sort((a, b) => b.hit - a.hit)
      .slice(0, 3);
    if (contextSentences.length) return contextSentences.map((x) => x.s).join(' ');
    const historyStatements = (i.history ?? [])
      .map((x) => x.content.trim())
      .filter(
        (s) =>
          s &&
          !s.endsWith('?') &&
          s !== i.config.fallbackMessage &&
          !/I don['’]t have verified information/i.test(s),
      )
      .flatMap((s) => s.split(/(?<=[.!?])\s+/))
      .map((s) => ({ s, hit: scoreText(s, false) }))
      .filter((x) => x.hit > 0)
      .sort((a, b) => b.hit - a.hit)
      .slice(0, 3);
    if (historyStatements.length) return historyStatements.map((x) => x.s).join(' ');
    if (i.context.length && (i.context[0]?.score ?? 0) >= 0.5) {
      return i.context[0]!.text;
    }
    return i.config.fallbackMessage;
  }
  async streamAnswer(i: LlmInput, onToken: (token: string) => void) {
    const answer = await this.answer(i);
    for (const token of answer.match(/\S+\s*/g) ?? []) onToken(token);
    return answer;
  }
  async health(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      type: 'local',
      connected: true,
      configured: true,
      reachable: true,
      authentication: 'not-required',
      status: 'ready',
    };
  }
}

export class OpenAICompatibleLlm implements LlmProvider {
  readonly name: string;
  constructor(
    private config: LlmConfig,
    private fetchImpl: Fetch = fetch,
  ) {
    this.name = config.providerName;
  }
  private async request(url: string | URL, init: RequestInit, retries: number): Promise<Response> {
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
        if (!retryable(response.status) || attempt === retries) return response;
        last = new Error(`retryable status ${response.status}`);
      } catch (error) {
        last = error;
        if (attempt === retries)
          throw new Error(`LLM request failed after ${attempt + 1} attempt(s)`, { cause: error });
      } finally {
        clearTimeout(timer);
      }
      await sleep(this.config.retryBaseMs * 2 ** attempt);
    }
    throw last;
  }
  private url(path: string) {
    const url = new URL(path.slice(1), `${this.config.baseUrl}/`);
    for (const [name, value] of Object.entries(this.config.queryParams))
      url.searchParams.set(name, value);
    return url;
  }
  private headers() {
    const key = this.config.authScheme
      ? `${this.config.authScheme} ${this.config.apiKey!}`
      : this.config.apiKey!;
    return {
      ...this.config.headers,
      [this.config.authHeaderName]: key,
      'content-type': 'application/json',
    };
  }
  private payload(i: LlmInput, stream: boolean) {
    const context = i.context
      .map((x, n) => `[Source ${n + 1}: ${x.source} | chunk ${x.id}]\n${x.text}`)
      .join('\n\n');
    const policy = `${tenantIdentityPolicy(i.config)}\n${i.prompt}\nStrict grounding policy: For tenant-specific factual questions, answer only from TENANT KNOWLEDGE below. TENANT KNOWLEDGE is authoritative and overrides pretrained/model knowledge. The following tenant knowledge is verified evidence for this tenant and must be treated as authoritative. Do not invent or infer missing prices, availability, policies, features, guarantees, fees, locations, dates, or operating details. Preserve qualifications such as “starting from”, gym/location dependence, eligibility, and terms. If evidence explicitly says UNKNOWN or the requested fact is absent, say it is not available; do not use the fallback merely because the question is phrased differently from the evidence in the current tenant knowledge and direct the customer to the official support route when appropriate. Distinguish verified facts from assumptions. Use bounded CONVERSATION history only to resolve follow-ups. For an explicit summary or recap request, summarize that bounded conversation history and do not require tenant knowledge. For greetings and general conversation, respond naturally without requiring tenant knowledge. If the question is tenant-specific and evidence is empty, use this fallback: ${i.config.fallbackMessage}`;
    const boundedHistory = (i.history ?? []).slice(-8);
    const messages = [
      { role: 'system', content: `SYSTEM POLICY\n${policy}` },
      {
        role: 'system',
        content: `TENANT KNOWLEDGE (authoritative, tenant-scoped)\n${context || '(none)'}`,
      },
      ...boundedHistory.map((m) => ({ role: m.role, content: `CONVERSATION\n${m.content}` })),
      { role: 'user', content: `USER\nQuestion: ${i.question}` },
    ];
    const contextText = context || '(none)';
    const payloadChars = messages.reduce((total, message) => total + message.content.length, 0);
    i.debug?.('FINAL_CONTEXT', {
      chars: contextText.length,
      tokensApprox: approxTokens(contextText),
      selectedChunkCount: i.context.length,
      preview: debugPreview(contextText, 2400),
    });
    i.debug?.('LLM_CONTEXT', {
      chars: contextText.length,
      tokensApprox: approxTokens(contextText),
      selectedChunkCount: i.context.length,
      preview: debugPreview(contextText, 2400),
    });
    i.debug?.('LLM_MESSAGES', {
      historyIncluded: boundedHistory.length > 0,
      messages: messages.map((m) => ({
        role: m.role,
        chars: m.content.length,
        tokensApprox: approxTokens(m.content),
        content: debugPreview(m.content, 2400),
      })),
    });
    const serializedPayloadChars = JSON.stringify({
      model: this.config.model,
      stream,
      messages,
    }).length;
    i.debug?.('LLM_REQUEST_SIZE', {
      provider: this.config.providerName,
      model: this.config.model,
      stream,
      messageCount: messages.length,
      inputChars: payloadChars,
      inputTokensApprox: approxTokens(JSON.stringify(messages)),
      serializedPayloadChars,
      serializedPayloadTokensApprox: approxTokens(
        JSON.stringify({ model: this.config.model, stream, messages }),
      ),
    });
    i.debug?.('LLM_REQUEST', {
      provider: this.config.providerName,
      model: this.config.model,
      stream,
      payloadChars,
      payloadTokensApprox: approxTokens(JSON.stringify(messages)),
      serializedPayloadChars,
      messages: messages.map((m) => ({
        role: m.role,
        chars: m.content.length,
        tokensApprox: approxTokens(m.content),
      })),
    });
    return {
      model: this.config.model,
      temperature: this.config.sampling.temperature,
      ...(this.config.sampling.topP === undefined ? {} : { top_p: this.config.sampling.topP }),
      ...(this.config.sampling.maxTokens === undefined
        ? {}
        : { max_tokens: this.config.sampling.maxTokens }),
      stream,
      messages,
    };
  }
  async answer(i: LlmInput) {
    const identity = tenantIdentityAnswer(i.question, i.config);
    if (identity) return identity;
    const r = await this.request(
      this.url(this.config.chatPath),
      { method: 'POST', headers: this.headers(), body: JSON.stringify(this.payload(i, false)) },
      this.config.maxRetries,
    );
    if (!r.ok) throw new Error(`LLM provider failed (${r.status})`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const answer = j.choices?.[0]?.message?.content ?? i.config.fallbackMessage;
    i.debug?.('LLM_RESPONSE', {
      stream: false,
      chars: answer.length,
      tokensApprox: approxTokens(answer),
      preview: debugPreview(answer, 2400),
    });
    i.debug?.('RAW_LLM_RESPONSE', {
      stream: false,
      chars: answer.length,
      tokensApprox: approxTokens(answer),
      preview: debugPreview(answer, 2400),
    });
    return answer;
  }
  async streamAnswer(i: LlmInput, onToken: (token: string) => void) {
    const identity = tenantIdentityAnswer(i.question, i.config);
    if (identity) {
      for (const token of identity.match(/\S+\s*/g) ?? []) onToken(token);
      return identity;
    }
    const r = await this.request(
      this.url(this.config.chatPath),
      { method: 'POST', headers: this.headers(), body: JSON.stringify(this.payload(i, true)) },
      this.config.maxRetries,
    );
    if (!r.ok) throw new Error(`LLM provider failed (${r.status})`);
    if (!r.body) return this.answer(i);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    const emit = (line: string) => {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') return;
      try {
        const token =
          (JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[] })
            .choices?.[0]?.delta?.content ?? '';
        if (token) {
          answer += token;
          onToken(token);
        }
      } catch {
        /* ignore incomplete provider frames */
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(emit);
      if (done) break;
    }
    i.debug?.('LLM_RESPONSE', {
      stream: true,
      chars: answer.length,
      tokensApprox: approxTokens(answer),
      preview: debugPreview(answer, 2400),
    });
    i.debug?.('RAW_LLM_RESPONSE', {
      stream: true,
      chars: answer.length,
      tokensApprox: approxTokens(answer),
      preview: debugPreview(answer, 2400),
    });
    if (!answer) {
      const recovered = await this.answer(i);
      if (recovered) onToken(recovered);
      return recovered;
    }
    return answer;
  }
  async reformulate(i: LlmInput) {
    const history = (i.history ?? [])
      .slice(-8)
      .map((x) => `${x.role}: ${x.content}`)
      .join('\n');
    const payload = {
      model: this.config.model,
      temperature: 0,
      max_tokens: 80,
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'Convert the user request into one concise search query for the current tenant knowledge base. Resolve pronouns using the conversation. Return up to three concise alternative search queries, one per line, with no numbering or explanation. Resolve pronouns using the conversation. If this is a greeting or general conversational request, return NONE.',
        },
        {
          role: 'user',
          content: `Conversation:\n${history || '(none)'}\nCurrent request: ${i.question}`,
        },
      ],
    };
    const reformulationMessages = payload.messages;
    const reformulationChars = reformulationMessages.reduce(
      (total, message) => total + message.content.length,
      0,
    );
    i.debug?.('LLM_CONTEXT', {
      chars: 0,
      tokensApprox: 0,
      preview: '(reformulation request has no tenant context)',
    });
    i.debug?.('LLM_MESSAGES', {
      historyIncluded: history.length > 0,
      messages: reformulationMessages.map((m) => ({
        role: m.role,
        chars: m.content.length,
        tokensApprox: approxTokens(m.content),
        preview: debugPreview(m.content, 800),
      })),
    });
    i.debug?.('LLM_REQUEST', {
      provider: this.config.providerName,
      model: this.config.model,
      stream: false,
      payloadChars: reformulationChars,
      payloadTokensApprox: approxTokens(JSON.stringify(reformulationMessages)),
      messages: reformulationMessages.map((m) => ({
        role: m.role,
        chars: m.content.length,
        tokensApprox: approxTokens(m.content),
      })),
    });
    const r = await this.request(
      this.url(this.config.chatPath),
      { method: 'POST', headers: this.headers(), body: JSON.stringify(payload) },
      0,
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const query = j.choices?.[0]?.message?.content?.trim().replace(/^['"]|['"]$/g, '');
    i.debug?.('RAW_LLM_RESPONSE', {
      stream: false,
      chars: query?.length ?? 0,
      tokensApprox: approxTokens(query ?? ''),
      preview: debugPreview(query ?? '', 2400),
    });
    return query && query.toUpperCase() !== 'NONE' ? query : null;
  }
  async health(): Promise<ProviderHealth> {
    const common = {
      provider: this.config.providerName,
      type: this.config.providerType,
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      configured: true,
    };
    try {
      const r = await this.request(
        this.url(this.config.healthPath),
        { method: 'GET', headers: this.headers() },
        0,
      );
      const authentication = [401, 403].includes(r.status)
        ? 'rejected'
        : r.ok
          ? 'accepted'
          : 'unknown';
      return {
        ...common,
        connected: r.ok,
        reachable: true,
        authentication,
        status: r.ok ? 'ready' : authentication === 'rejected' ? 'authentication-failed' : 'upstream-error',
        detail: `diagnostic HTTP ${r.status}`,
      };
    } catch (error) {
      const timeout =
        error instanceof Error &&
        (error.name === 'AbortError' || String(error.cause).includes('AbortError'));
      return {
        ...common,
        connected: false,
        reachable: false,
        authentication: 'unknown',
        status: timeout ? 'timeout' : 'unreachable',
        detail: timeout ? `diagnostic timed out after ${this.config.timeoutMs}ms` : 'diagnostic request failed',
      };
    }
  }
}
export function createLlmProvider(config: LlmConfig, fetchImpl: Fetch = fetch): LlmProvider {
  return config.providerType === 'local'
    ? new LocalLlm(config.providerName)
    : new OpenAICompatibleLlm(config, fetchImpl);
}
