import { z } from 'zod';

export type LlmProviderType = 'local' | 'openai-compatible';
export type LlmConfig = {
  providerName: string;
  providerType: LlmProviderType;
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv: string;
  model?: string;
  sampling: { temperature: number; topP?: number; maxTokens?: number };
  stream: boolean;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  headers: Readonly<Record<string, string>>;
  chatPath: string;
  healthPath: string;
  queryParams: Readonly<Record<string, string>>;
  authHeaderName: string;
  authScheme: string;
};

const stringRecordSchema = z.record(z.string());
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const authScheme = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const forbiddenHeaders = new Set([
  'authorization',
  'proxy-authorization',
  'content-type',
  'content-length',
  'host',
  'transfer-encoding',
]);

function parseStringRecord(value: string | undefined, variable: string) {
  if (!value) return {};
  try {
    return stringRecordSchema.parse(JSON.parse(value));
  } catch {
    throw new Error(`${variable} must be a JSON object with string values`);
  }
}

function parsePath(value: string | undefined, fallback: string, variable: string) {
  const path = value ?? fallback;
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\r\n]/.test(path))
    throw new Error(`${variable} must be an absolute path without a query or fragment`);
  const parsed = new URL(path, 'https://provider.invalid');
  if (
    parsed.pathname !== path ||
    parsed.pathname.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error(`${variable} must be a normalized path`);
  return path;
}

function validateHeaders(headers: Record<string, string>, authHeaderName: string) {
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!headerName.test(name) || /[\r\n]/.test(value))
      throw new Error('LLM_HEADERS contains an invalid header');
    if (
      forbiddenHeaders.has(normalized) ||
      normalized === authHeaderName.toLowerCase() ||
      /(api[-_]?key|token|secret|password)/i.test(normalized)
    )
      throw new Error('LLM_HEADERS cannot contain authentication, secret, or transport headers');
  }
}
const integer = (value: string | undefined, fallback: number) =>
  z.coerce
    .number()
    .int()
    .parse(value ?? fallback);
const number = (value: string | undefined, fallback: number) =>
  z.coerce.number().parse(value ?? fallback);
const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : z.enum(['true', 'false']).parse(value) === 'true';

/** The single source of truth for all chat-provider configuration. */
export function loadLlmConfig(input: NodeJS.ProcessEnv): LlmConfig {
  const legacyProvider = input.LLM_PROVIDER;
  const providerType = z
    .enum(['local', 'openai-compatible'])
    .parse(
      input.LLM_PROVIDER_TYPE ??
        (legacyProvider === 'openai' || legacyProvider === 'openai-compatible'
          ? 'openai-compatible'
          : 'local'),
    );
  const providerName =
    input.LLM_PROVIDER_NAME ??
    (providerType === 'local'
      ? 'local'
      : legacyProvider && !['openai', 'openai-compatible', 'local'].includes(legacyProvider)
        ? legacyProvider
        : 'openai-compatible');
  const apiKeyEnv = input.LLM_API_KEY_ENV || 'LLM_API_KEY';
  if (!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv))
    throw new Error('LLM_API_KEY_ENV must be a valid environment variable name');
  const authHeaderName = input.LLM_AUTH_HEADER_NAME ?? 'authorization';
  if (
    !headerName.test(authHeaderName) ||
    (forbiddenHeaders.has(authHeaderName.toLowerCase()) &&
      authHeaderName.toLowerCase() !== 'authorization')
  )
    throw new Error('LLM_AUTH_HEADER_NAME must be a valid authentication header name');
  const configuredAuthScheme = input.LLM_AUTH_SCHEME ?? 'Bearer';
  if (configuredAuthScheme && !authScheme.test(configuredAuthScheme))
    throw new Error('LLM_AUTH_SCHEME must be empty or a valid HTTP authentication scheme');
  const headers = parseStringRecord(input.LLM_HEADERS, 'LLM_HEADERS');
  validateHeaders(headers, authHeaderName);
  const queryParams = parseStringRecord(input.LLM_QUERY_PARAMS, 'LLM_QUERY_PARAMS');
  for (const [key, value] of Object.entries(queryParams)) {
    if (
      !key ||
      /[\r\n]/.test(key) ||
      /[\r\n]/.test(value) ||
      /(api[-_]?key|token|secret|password|authorization)/i.test(key)
    )
      throw new Error('LLM_QUERY_PARAMS contains an invalid or secret query parameter');
  }
  const config: LlmConfig = {
    providerName,
    providerType,
    baseUrl: input.LLM_BASE_URL ?? input.OPENAI_BASE_URL,
    apiKey: input[apiKeyEnv] ?? (apiKeyEnv === 'LLM_API_KEY' ? input.OPENAI_API_KEY : undefined),
    apiKeyEnv,
    model: input.LLM_MODEL ?? input.OPENAI_CHAT_MODEL,
    sampling: {
      temperature: number(input.LLM_TEMPERATURE, 0),
      topP: input.LLM_TOP_P === undefined ? undefined : number(input.LLM_TOP_P, 1),
      maxTokens:
        input.LLM_MAX_TOKENS === undefined ? undefined : integer(input.LLM_MAX_TOKENS, 1024),
    },
    stream: bool(input.LLM_STREAM, false),
    timeoutMs: integer(input.LLM_TIMEOUT_MS, 15000),
    maxRetries: integer(input.LLM_MAX_RETRIES, 2),
    retryBaseMs: integer(input.LLM_RETRY_BASE_MS, 250),
    headers,
    chatPath: parsePath(input.LLM_CHAT_PATH, '/chat/completions', 'LLM_CHAT_PATH'),
    healthPath: parsePath(input.LLM_HEALTH_PATH, '/models', 'LLM_HEALTH_PATH'),
    queryParams,
    authHeaderName,
    authScheme: configuredAuthScheme,
  };
  if (config.timeoutMs < 100 || config.maxRetries < 0 || config.retryBaseMs < 0)
    throw new Error('Invalid LLM timeout/retry configuration');
  if (providerType !== 'local') {
    const missing = [
      !config.baseUrl && 'LLM_BASE_URL',
      !config.model && 'LLM_MODEL',
      !config.apiKey && apiKeyEnv,
    ].filter(Boolean);
    if (missing.length)
      throw new Error(`Missing non-local LLM configuration: ${missing.join(', ')}`);
    const parsedBase = new URL(z.string().url().parse(config.baseUrl));
    if (parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash)
      throw new Error('LLM_BASE_URL must not contain credentials, query parameters, or fragments');
    config.baseUrl = parsedBase.toString().replace(/\/$/, '');
  }
  return config;
}
