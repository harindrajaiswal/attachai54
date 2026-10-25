import { describe, expect, it, vi } from 'vitest';
import { loadLlmConfig } from '../src/config/llm.js';
import { createLlmProvider } from '../src/providers/llm.js';

const input = {
  LLM_PROVIDER_NAME: 'nvidia',
  LLM_PROVIDER_TYPE: 'openai-compatible',
  LLM_BASE_URL: 'https://integrate.example/v1',
  LLM_API_KEY: 'test-only-key',
  LLM_MODEL: 'vendor/model',
  LLM_TIMEOUT_MS: '100',
  LLM_MAX_RETRIES: '1',
  LLM_RETRY_BASE_MS: '0',
  LLM_HEADERS: '{"x-provider-feature":"enabled"}',
};
const answerInput = {
  question: 'What?',
  prompt: 'safe',
  config: { assistantName: 'a', fallbackMessage: 'no' },
  context: [{ id: 'chunk-1', text: 'Known answer.', source: 'one.txt', score: 1 }],
};
describe('generic LLM provider configuration and adapter', () => {
  it('defaults to deterministic local configuration', async () => {
    const config = loadLlmConfig({});
    expect(config.providerType).toBe('local');
    expect((await createLlmProvider(config).health()).status).toBe('ready');
  });
  it('loads generic compatible settings and custom key reference', () => {
    const config = loadLlmConfig({
      ...input,
      LLM_API_KEY_ENV: 'NVIDIA_TOKEN',
      LLM_API_KEY: undefined,
      NVIDIA_TOKEN: 'secret',
    });
    expect(config).toMatchObject({
      providerName: 'nvidia',
      providerType: 'openai-compatible',
      apiKeyEnv: 'NVIDIA_TOKEN',
      model: 'vendor/model',
    });
    expect(config.headers).toEqual({ 'x-provider-feature': 'enabled' });
  });
  it('supports legacy openai selector while switching through configuration only', () => {
    expect(
      loadLlmConfig({
        LLM_PROVIDER: 'openai',
        OPENAI_BASE_URL: 'https://api.example/v1',
        OPENAI_API_KEY: 'x',
        OPENAI_CHAT_MODEL: 'm',
      }).providerType,
    ).toBe('openai-compatible');
  });
  it('fails fast when non-local configuration is incomplete', () => {
    expect(() => loadLlmConfig({ LLM_PROVIDER_TYPE: 'openai-compatible' })).toThrow(
      /Missing non-local LLM configuration/,
    );
  });
  it('sends a no-context message to the LLM instead of terminating with the RAG fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: 'Hello! How can I help?' } }] }));
    const p = createLlmProvider(loadLlmConfig(input), fetchMock);
    await expect(p.answer({ ...answerInput, question: 'hello', context: [] })).resolves.toBe('Hello! How can I help?');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(request.messages.at(-1).content).toContain('Question: hello');
    expect(request.messages[0].content).toContain('verified evidence for this tenant');
    expect(request.messages[0].content).toContain('do not use the fallback merely because');
    expect(request.messages[0].content).toContain('explicit summary or recap request');
  });
  it('answers explicit identity questions with the current tenant identity', async () => {
    const questions = [
      'Who are you?', 'What are you?', 'What is your name?', 'Are you ChatGPT?',
      'Are you Gemini?', 'Are you Claude?', 'Who created you?', 'Which AI model are you?',
      'What company do you belong to?', 'Tell me about yourself.',
    ];
    const tenantA = { assistantName: 'BluePeak AI Assistant', companyName: 'BluePeak', fallbackMessage: 'unknown' };
    const tenantB = { assistantName: 'Acme Helpdesk', companyName: 'Acme', fallbackMessage: 'unknown' };
    const local = createLlmProvider(loadLlmConfig({}), vi.fn());
    for (const question of questions) {
      const a = await local.answer({ ...answerInput, question, config: tenantA });
      const b = await local.answer({ ...answerInput, question, config: tenantB });
      expect(a).toContain("BluePeak's AI assistant");
      expect(b).toContain("Acme's AI assistant");
      expect(a).not.toMatch(/chatgpt|gemini|claude|openai/i);
      expect(b).not.toMatch(/chatgpt|gemini|claude|openai/i);
      expect(a).not.toContain('Acme');
      expect(b).not.toContain('BluePeak');
    }
    const streamed: string[] = [];
    await local.streamAnswer({ ...answerInput, question: 'Are you ChatGPT?', config: tenantA }, (token) => streamed.push(token));
    expect(streamed.join('')).toContain("BluePeak's AI assistant");
  });
  it('puts tenant identity policy ahead of tenant prompt for indirect identity questions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: 'role answer' } }] }));
    const p = createLlmProvider(loadLlmConfig(input), fetchMock);
    await p.answer({ ...answerInput, question: 'Can you describe your role?', config: { ...answerInput.config, companyName: 'BluePeak', assistantName: 'BluePeak AI Assistant' } });
    const request = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(request.messages[0].content).toContain('BluePeak');
    expect(request.messages[0].content).toContain('BluePeak AI Assistant');
    expect(request.messages[0].content).toContain('Do not present the underlying language model');
  });
  it('sends compatible requests and retries a transient response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'answer' } }] }));
    const p = createLlmProvider(loadLlmConfig(input), fetchMock);
    await expect(p.answer(answerInput)).resolves.toBe('answer');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(fetchMock.mock.calls[1]![0]).toEqual(
      new URL('https://integrate.example/v1/chat/completions'),
    );
    expect(request.headers).toMatchObject({
      authorization: 'Bearer test-only-key',
      'x-provider-feature': 'enabled',
    });
  });
  it('configures Azure-style paths, query parameters, and api-key authentication from env only', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'azure answer' } }] }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const config = loadLlmConfig({
      LLM_PROVIDER_TYPE: 'openai-compatible',
      LLM_PROVIDER_NAME: 'azure-openai',
      LLM_BASE_URL: 'https://example.openai.azure.com',
      LLM_MODEL: 'deployment-name',
      LLM_API_KEY_ENV: 'AZURE_OPENAI_API_KEY',
      AZURE_OPENAI_API_KEY: 'azure-test-key',
      LLM_CHAT_PATH: '/openai/deployments/deployment-name/chat/completions',
      LLM_HEALTH_PATH: '/openai/models',
      LLM_QUERY_PARAMS: '{"api-version":"2024-10-21"}',
      LLM_AUTH_HEADER_NAME: 'api-key',
      LLM_AUTH_SCHEME: '',
      LLM_TIMEOUT_MS: '100',
      LLM_MAX_RETRIES: '0',
      LLM_RETRY_BASE_MS: '0',
    });
    const p = createLlmProvider(config, fetchMock);
    await expect(p.answer(answerInput)).resolves.toBe('azure answer');
    await expect(p.health()).resolves.toMatchObject({
      provider: 'azure-openai',
      baseUrl: 'https://example.openai.azure.com',
      status: 'ready',
    });
    expect(fetchMock.mock.calls[0]![0]).toEqual(
      new URL(
        'https://example.openai.azure.com/openai/deployments/deployment-name/chat/completions?api-version=2024-10-21',
      ),
    );
    expect(fetchMock.mock.calls[1]![0]).toEqual(
      new URL('https://example.openai.azure.com/openai/models?api-version=2024-10-21'),
    );
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).headers).toMatchObject({ 'api-key': 'azure-test-key' });
    }
    expect(JSON.stringify(await p.health())).not.toContain('azure-test-key');
    expect(JSON.stringify(await p.health())).not.toContain('api-version');
  });
  it('rejects unsafe paths and headers that could override authentication', () => {
    expect(() => loadLlmConfig({ ...input, LLM_CHAT_PATH: 'https://attacker.test/path' })).toThrow(
      /LLM_CHAT_PATH/,
    );
    expect(() => loadLlmConfig({ ...input, LLM_HEADERS: '{"authorization":"secret"}' })).toThrow(
      /cannot contain/,
    );
  });
  it('bounds stalled requests with a timeout', async () => {
    const stalled = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const p = createLlmProvider(loadLlmConfig({ ...input, LLM_MAX_RETRIES: '0' }), stalled);
    await expect(p.answer(answerInput)).rejects.toThrow(/after 1 attempt/);
  });
  it('recovers through non-streaming when a compatible stream has no content frames', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'Recovered grounded answer' } }] }));
    const p = createLlmProvider(loadLlmConfig(input), fetchMock);
    const tokens: string[] = [];
    await expect(p.streamAnswer(answerInput, (token) => tokens.push(token))).resolves.toBe('Recovered grounded answer');
    expect(tokens.join('')).toBe('Recovered grounded answer');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('reports reachable authentication failure without exposing credentials', async () => {
    const p = createLlmProvider(
      loadLlmConfig(input),
      vi.fn().mockResolvedValue(new Response('', { status: 401 })),
    );
    const health = await p.health();
    expect(health).toMatchObject({
      provider: 'nvidia',
      configured: true,
      reachable: true,
      connected: false,
      authentication: 'rejected',
      status: 'authentication-failed',
      model: 'vendor/model',
      baseUrl: 'https://integrate.example/v1',
    });
    expect(JSON.stringify(health)).not.toContain('test-only-key');
  });
});
