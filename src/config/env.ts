import { z } from 'zod';
import path from 'node:path';
import { loadLlmConfig, type LlmConfig } from './llm.js';
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  ADMIN_API_KEY: z.string().min(16).default('local-development-admin-key'),
  DATA_DIR: z.string().default('./data'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  EMBEDDING_PROVIDER: z.enum(['local', 'openai']).default('local'),
  VECTOR_PROVIDER: z.enum(['local', 'qdrant', 'supabase']).default('local'),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().optional(),
  NOTIFICATION_PROVIDER: z.enum(['outbox', 'smtp', 'supabase']).default('outbox'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  CORS_ORIGINS: z.string().default(''),
  DATABASE_PROVIDER: z.enum(['sqlite', 'supabase']).default('sqlite'),
  REPOSITORY_PROVIDER: z.enum(['sqlite', 'supabase']).optional(),
  STORAGE_PROVIDER: z.enum(['local', 'supabase']).default('local'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_STORAGE_BUCKET: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,100}$/)
    .default('knowledge'),
  SUPABASE_OUTBOX_TABLE: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .default('notifications'),
});
export type Env = Omit<z.infer<typeof schema>, 'CORS_ORIGINS'> & {
  llm: LlmConfig;
  CORS_ORIGINS: string[];
};
export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const compatibleInput = {
    ...input,
    OPENAI_API_KEY: input.OPENAI_API_KEY || input.EMBEDDING_API_KEY,
    OPENAI_EMBEDDING_MODEL: input.OPENAI_EMBEDDING_MODEL || input.EMBEDDING_MODEL,
  };
  const e = schema.parse(compatibleInput);
  const databaseProvider = e.REPOSITORY_PROVIDER ?? e.DATABASE_PROVIDER;
  if (
    e.NODE_ENV === 'production' &&
    (!input.ADMIN_API_KEY ||
      input.ADMIN_API_KEY === 'local-development-admin-key' ||
      input.ADMIN_API_KEY.length < 24)
  )
    throw new Error(
      'ADMIN_API_KEY must be explicitly configured with at least 24 characters in production',
    );
  if (
    databaseProvider === 'supabase' &&
    (!e.SUPABASE_URL || !(e.SUPABASE_SERVICE_ROLE_KEY || e.SUPABASE_ANON_KEY))
  )
    throw new Error('SUPABASE_URL and a Supabase key are required when DATABASE_PROVIDER=supabase');
  if (
    (e.STORAGE_PROVIDER === 'supabase' ||
      e.VECTOR_PROVIDER === 'supabase' ||
      e.NOTIFICATION_PROVIDER === 'supabase') &&
    (!e.SUPABASE_URL || !(e.SUPABASE_SERVICE_ROLE_KEY || e.SUPABASE_ANON_KEY))
  )
    throw new Error('SUPABASE_URL and a Supabase key are required for Supabase providers');
  return {
    ...e,
    DATABASE_PROVIDER: databaseProvider,
    CORS_ORIGINS: e.CORS_ORIGINS.split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    DATA_DIR: path.resolve(e.DATA_DIR),
    llm: loadLlmConfig(input),
  };
}
