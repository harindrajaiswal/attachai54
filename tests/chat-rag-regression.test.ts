/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/services/chat.js';
import type { Client, RetrievedChunk } from '../src/domain/types.js';

const client: Client = {
  id: 'tenant-a',
  name: 'Tenant A',
  slug: 'tenant-a',
  enabled: true,
  prompt: 'Be concise.',
  createdAt: '',
  updatedAt: '',
  config: {
    assistantName: 'A',
    companyName: 'Tenant A',
    fallbackMessage: 'UNKNOWN',
    topK: 4,
  },
};
const chunk = (id: string, text: string, score: number): RetrievedChunk => ({
  id,
  text,
  source: 'knowledge.md',
  score,
});

function fixture(
  opts: {
    search?: (q: number[]) => Promise<RetrievedChunk[]>;
    answer?: (input: any) => Promise<string>;
    reformulate?: () => Promise<string | null>;
  } = {},
) {
  const searches: number[][] = [];
  const repo: any = {
    getClient: vi.fn(async () => client),
    createConversation: vi.fn(async () => 'conversation-1'),
    messages: vi.fn(async () => []),
    addMessage: vi.fn(async () => undefined),
    usage: vi.fn(async () => undefined),
  };
  const embedding: any = {
    embed: vi.fn(async (values: string[]) => values.map((x) => [x.length])),
  };
  const vector: any = {
    search: vi.fn(async (_id: string, q: number[]) => {
      searches.push(q);
      return opts.search?.(q) ?? [];
    }),
  };
  const llm: any = {
    answer: vi.fn(opts.answer ?? (async (input: any) => input.context[0]?.text ?? 'UNKNOWN')),
    streamAnswer: vi.fn(
      async (input: any) => opts.answer?.(input) ?? input.context[0]?.text ?? 'UNKNOWN',
    ),
    reformulate: opts.reformulate ? vi.fn(opts.reformulate) : undefined,
  };
  return {
    service: new ChatService(repo, embedding, vector, llm),
    repo,
    embedding,
    vector,
    llm,
    searches,
  };
}

describe('generic RAG recovery and grounding path', () => {
  it('keeps semantic similarity ahead of generic lexical overlap', async () => {
    const { service } = fixture();
    const selected = (service as any).selectEvidence(
      [
        chunk('generic', 'Contact our general service team.', 0.58),
        chunk('answer', 'Customer Care can be reached by email at help@example.test.', 0.82),
      ],
      'How can I contact Customer Care?',
    );
    expect(selected[0].id).toBe('answer');
  });

  it('promotes a clearly lexical tenant answer when semantic scores are near-tied', async () => {
    const { service } = fixture();
    const selected = (service as any).selectEvidence(
      [
        chunk('generic', 'Gousto is a flexible recipe box company.', 0.264),
        chunk(
          'sizes',
          'Box sizes are designed for 1 to 5 people; customers can choose 2 to 5 recipes.',
          0.213,
        ),
      ],
      'What recipe box sizes do you offer?',
    );
    expect(selected[0].id).toBe('sizes');
  });

  it('recovers after a weak first hit and merges recovered tenant evidence', async () => {
    const relevant = chunk(
      'care',
      'For assistance, customers can contact the Customer Care team by email.',
      0.79,
    );
    let searchCount = 0;
    const { service, llm, vector } = fixture({
      search: async (_q) =>
        ++searchCount === 1
          ? [chunk('weak', 'Our company offers customer services.', 0.31)]
          : [relevant],
      reformulate: async () => 'support contact assistance',
    });
    const result = await service.chat('tenant-a', 'How can I contact Customer Care?');
    expect(llm.reformulate).toHaveBeenCalledOnce();
    expect(vector.search).toHaveBeenCalledTimes(2);
    expect(result.sources[0]?.chunkId).toBe('care');
    expect(result.answer).toContain('Customer Care');
  });

  it('recovers from zero initial chunks via deterministic query expansion without requiring an LLM reformulation call', async () => {
    const relevant = chunk(
      'airtasker-dispute',
      'To post a task on Airtasker, describe the job and budget. For disputes, keep messages inside the app.',
      0.84,
    );
    let searchCount = 0;
    const { service, llm, vector } = fixture({
      search: async () => (++searchCount === 1 ? [] : [relevant]),
    });
    const result = await service.chat(
      'tenant-a',
      'Could you please tell me how Airtasker works and what happens if I have a dispute?',
    );
    expect(vector.search.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(llm.reformulate).toBeUndefined();
    expect(result.sources[0]?.chunkId).toBe('airtasker-dispute');
    expect(result.answer).toContain('Airtasker');
  });

  it('retries a generic model fallback with an explicit evidence correction', async () => {
    const relevant = chunk('care', 'Call 020 3011 1002 or use the Gousto Help Centre.', 0.82);
    let calls = 0;
    const { service, llm } = fixture({
      search: async () => [relevant],
      answer: async (input) =>
        ++calls === 1 ? 'I don’t have verified information about that.' : input.context[0]!.text,
    });
    const result = await service.chat('tenant-a', 'How can I contact Customer Care?');
    expect(llm.answer).toHaveBeenCalledTimes(2);
    expect(result.answer).toContain('020 3011 1002');
  });

  it('retrieves evidence through the live chat path for the Gousto freshness question', async () => {
    const relevant = chunk(
      'freshness',
      'Gousto ingredients stay fresh for the period shown on the use-by label.',
      0.82,
    );
    const { service, embedding, vector } = fixture({ search: async () => [relevant] });
    const result = await service.chat('tenant-a', 'how long do gousto ingredients stay fresh?');
    expect(embedding.embed).toHaveBeenCalledWith(['how long do gousto ingredients stay fresh?']);
    expect(vector.search).toHaveBeenCalledOnce();
    expect(result.sources[0]?.chunkId).toBe('freshness');
    expect(result.answer).toContain('Gousto ingredients stay fresh');
  });

  it('retrieves evidence through the live chat path for the Airtasker posting question', async () => {
    const relevant = chunk(
      'posting',
      'To post a task, describe what you need, add a budget, and publish it for Taskers to see.',
      0.82,
    );
    const { service, embedding, vector } = fixture({ search: async () => [relevant] });
    const result = await service.chat('tenant-a', 'How do I post a task on Airtasker?');
    expect(embedding.embed).toHaveBeenCalledWith(['How do I post a task on Airtasker?']);
    expect(vector.search).toHaveBeenCalledOnce();
    expect(result.sources[0]?.chunkId).toBe('posting');
    expect(result.answer).toContain('post a task');
  });

  it('retrieves evidence for a normal known knowledge question and records stage timings with 1 LLM call', async () => {
    const relevant = chunk(
      'refunds',
      'Refund requests are reviewed under the published refund policy.',
      0.82,
    );
    const { service, vector, llm } = fixture({ search: async () => [relevant] });
    const result = await service.preview('tenant-a', 'What is your refund policy?', client.prompt);
    expect(vector.search).toHaveBeenCalledOnce();
    expect(llm.answer).toHaveBeenCalledOnce();
    expect(result.retrieval.evidence[0]?.id).toBe('refunds');
    expect(result.answer).toContain('refund policy');
    expect(result.retrieval.diagnostics.timings?.llmCalls).toBe(1);
    expect(result.retrieval.diagnostics.timings?.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('removes internal FAQ scaffolding and duplicate sentences without corrupting abbreviations like e.g. or numbered lists', async () => {
    const relevant = chunk(
      'work',
      'Choose recipes (e.g., vegetarian meals) and receive ingredients and recipe cards at your door.',
      0.82,
    );
    const { service } = fixture({
      search: async () => [relevant],
      answer: async () =>
        '## FAQ\\nQ: How does a recipe box work? A: Choose recipes (e.g., vegetarian meals) and receive ingredients and recipe cards at your door. Choose recipes (e.g., vegetarian meals) and receive ingredients and recipe cards at your door.',
    });
    const result = await service.chat('tenant-a', 'How does the recipe box work?');
    expect(result.answer).toBe(
      'Choose recipes (e.g., vegetarian meals) and receive ingredients and recipe cards at your door.',
    );
    expect(result.answer).not.toContain('e. g.');
    expect(result.answer).not.toMatch(/(?:^|\s)(?:Q:|A:|## FAQ)/i);
  });

  it('keeps a genuinely unknown question on the configured fallback', async () => {
    const { service, llm, vector } = fixture({ answer: async () => 'UNKNOWN' });
    const result = await service.chat('tenant-a', 'What is the meaning of life?');
    expect(vector.search).not.toHaveBeenCalled();
    expect(llm.answer).toHaveBeenCalledOnce();
    expect(result.answer).toBe('UNKNOWN');
  });

  it('handles greetings and closings immediately with 0 vector searches and 0 LLM calls', async () => {
    const { service, embedding, vector, llm } = fixture();
    const greeting = await service.chat('tenant-a', 'Hello!');
    expect(embedding.embed).not.toHaveBeenCalled();
    expect(vector.search).not.toHaveBeenCalled();
    expect(llm.answer).not.toHaveBeenCalled();
    expect(greeting.answer).toContain('Hello!');

    const closing = await service.chat('tenant-a', 'Thank you!');
    expect(closing.answer).toContain('welcome');
    expect(llm.answer).not.toHaveBeenCalled();
  });

  it('asks a concise clarification question on an ambiguous pronoun-only query with no history', async () => {
    const { service, embedding, vector, llm } = fixture();
    const result = await service.chat('tenant-a', 'What about it?');
    expect(embedding.embed).not.toHaveBeenCalled();
    expect(vector.search).not.toHaveBeenCalled();
    expect(llm.answer).not.toHaveBeenCalled();
    expect(result.answer).toContain('clarify');
  });

  it('detects PARTIALLY_SUPPORTED evidence for a multi-part question when only one sub-question is covered', async () => {
    const relevant = chunk(
      'posting',
      'To post a task on Airtasker, click Post a Task, describe the job, and set your budget.',
      0.82,
    );
    const { service } = fixture({
      search: async () => [relevant],
      answer: async () =>
        'To post a task on Airtasker, click Post a Task, describe the job, and set your budget. The provided information does not cover enterprise helicopter charter rates.',
    });
    const result = await service.preview(
      'tenant-a',
      'How do I post a task on Airtasker and what are your enterprise helicopter charter rates?',
      client.prompt,
    );
    expect(result.retrieval.decision.status).toBe('PARTIALLY_SUPPORTED');
    expect(result.answer).toContain('post a task on Airtasker');
  });

  it('keeps standalone factual retrieval independent of prior chat answers', async () => {
    const relevant = chunk('sizes', 'Gousto box sizes are designed for 1 to 5 people.', 0.82);
    const { service, repo, embedding } = fixture({ search: async () => [relevant] });
    repo.messages.mockResolvedValue([
      { role: 'user', content: 'How does Gousto work?' },
      { role: 'assistant', content: 'Gousto delivers recipe boxes.' },
    ]);
    await service.chat('tenant-a', 'What recipe box sizes do you offer?', 'existing-session');
    expect(embedding.embed).toHaveBeenCalledWith(['What recipe box sizes do you offer?']);
  });

  it('uses bounded conversation history for summaries without knowledge retrieval', async () => {
    const { service, repo, embedding, vector, llm } = fixture({
      answer: async (input) => input.history.map((x: any) => x.content).join(' | '),
    });
    repo.messages.mockResolvedValue([
      { role: 'user', content: 'We discussed delivery.' },
      { role: 'assistant', content: 'Delivery takes two days.' },
    ]);
    const result = await service.chat(
      'tenant-a',
      'Please provide a detailed summary for this chat',
    );
    expect(embedding.embed).not.toHaveBeenCalled();
    expect(vector.search).not.toHaveBeenCalled();
    expect(llm.answer).toHaveBeenCalledOnce();
    expect(result.answer).toContain('Delivery takes two days.');
  });
});
