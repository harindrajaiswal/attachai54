# Technical provider verification

This report is based on the source currently present in `/tasklet/agent/home/multi-tenant-ai-backend`. I inspected the implementation rather than relying on the README or prior test reports.

## Important repository fact

There is **no `.env` file in this checkout**. The only matching root file is `.env.example`. Therefore I cannot inspect the `.env` mentioned in the question or the effective environment of the server that produced the reported `/health` response. The code-level cause of that response is nevertheless conclusive, as shown below.

## 1. LLM provider selection

The selector is in `src/app.ts:51-54`:

```ts
const llm =
  env.LLM_PROVIDER === 'openai'
    ? new OpenAILlm(env.OPENAI_BASE_URL, env.OPENAI_API_KEY, env.OPENAI_CHAT_MODEL)
    : new LocalLlm();
```

`LLM_PROVIDER` is declared and defaulted in `src/config/env.ts:11`:

```ts
LLM_PROVIDER: z.enum(['local', 'openai']).default('local'),
```

It is read from `process.env` by `loadEnv()` in `src/config/env.ts:27-35`. `src/server.ts:3-4` calls `loadEnv()` and passes the parsed object to `buildApp()`:

```ts
const env = loadEnv();
const app = await buildApp(env);
```

`LocalLlm` is instantiated only by the false branch in `src/app.ts:54`. `OpenAILlm` is instantiated only by the exact equality branch in `src/app.ts:52-53`.

For the reported running instance, **LocalLlm is selected**. That follows from `/health` returning `local-extractive`, which is the literal `LocalLlm.name` in `src/providers/llm.ts:12-13`:

```ts
export class LocalLlm implements LlmProvider {
  name = 'local-extractive';
```

The repository’s default is also local. This checkout does not contain the claimed `.env`, and no running process/container was available here to inspect.

## 2. Environment loading

The application does **not load `.env` at all**. There is no `dotenv` dependency in `package.json`, no `dotenv` import, and the start command is simply `node dist/src/server.js` (`package.json:9`).

`src/config/env.ts:27` reads the process environment:

```ts
export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
```

It copies it, applies three aliases, validates it, and returns a new object (`src/config/env.ts:28-35`):

```ts
const compatibleInput = {
  ...input,
  OPENAI_API_KEY: input.OPENAI_API_KEY || input.LLM_API_KEY,
  OPENAI_CHAT_MODEL: input.OPENAI_CHAT_MODEL || input.LLM_MODEL,
  OPENAI_EMBEDDING_MODEL: input.OPENAI_EMBEDDING_MODEL || input.EMBEDDING_MODEL,
};
const e = schema.parse(compatibleInput);
return { ...e, DATA_DIR: path.resolve(e.DATA_DIR) };
```

It is called once in `src/server.ts:3`. The parsed `env` object is retained in the application context (`src/app.ts:69-76`), while provider constructor arguments are retained in provider instances—for example, `OpenAILlm` stores `base`, `key`, and `model` in private constructor fields (`src/providers/llm.ts:36-40`). There is no reload watcher or later call to `loadEnv()` in the server path.

Consequences:

- A plain `.env` file has no effect on `npm start` or `npm run dev` with the current scripts.
- Variables must be injected into the process by the shell, service manager, deployment platform, or Compose.
- Changing `.env` requires restarting/replacing the process even after a loader is added.
- With Docker Compose, the Compose CLI can read `.env` for `${...}` interpolation, independently of application code.

## 3. Why `local-extractive` is active

The exact code reason is that this expression evaluated false when the app was constructed:

```ts
env.LLM_PROVIDER === 'openai';
```

There is no fallback from `OpenAILlm` to `LocalLlm`. A missing key does not select local; `OpenAILlm.answer()` instead throws `OPENAI_API_KEY is required` (`src/providers/llm.ts:47`). An upstream error also does not select local; it throws at line 65.

Therefore `/health` showing `local-extractive` proves the running process did not have the exact parsed value `LLM_PROVIDER=openai` at startup. If the value exists only in a `.env` file and the server was started with `npm start`, the immediate reason is that the application never reads that file. Other operational possibilities—an old process, a different working directory, or a different container environment—cannot be distinguished from this checkout because the reported process is not available for inspection.

Compose has its own default at `docker-compose.yml:13`:

```yaml
LLM_PROVIDER: ${LLM_PROVIDER:-local}
```

Thus Compose also passes `local` when its interpolation environment does not contain the variable.

## 4. NVIDIA Integrate API

**Yes, the existing chat provider is structurally OpenAI-compatible and can target NVIDIA Integrate without changing `src/providers/llm.ts`.** “OpenAI” is only the selector/adapter name; the endpoint and model are configurable strings.

`OpenAILlm.answer()` sends (`src/providers/llm.ts:50-66`):

```ts
const r = await fetch(`${this.base}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: this.model,
    temperature: 0,
    messages: [
      { role: 'system', content: `${i.prompt}\nUse ONLY the supplied context...` },
      { role: 'user', content: `Context:\n${context}\n\nQuestion: ${i.question}` },
    ],
  }),
});
const j = (await r.json()) as { choices: { message: { content: string } }[] };
```

With these effective process values:

```dotenv
LLM_PROVIDER=openai
OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
OPENAI_API_KEY=<NVIDIA API key>
OPENAI_CHAT_MODEL=moonshotai/kimi-k2.6
```

it calls `POST https://integrate.api.nvidia.com/v1/chat/completions`, sends a Bearer token, sends `model: "moonshotai/kimi-k2.6"`, and reads `choices[0].message.content`.

`LLM_API_KEY` and `LLM_MODEL` work as aliases, but there is **no `LLM_BASE_URL` alias**. Use `OPENAI_BASE_URL` unless code is changed.

This verifies adapter shape only. The code does not verify NVIDIA model entitlement/catalog availability until an actual chat call. It supports non-streaming chat completions only; it has no streaming parser, tool-call handling, timeout/abort, retry policy, or upstream error-body diagnostics.

## 5. Startup and request trace

1. `src/server.ts:3`: `loadEnv()` parses `process.env` once.
2. `src/server.ts:4`: `buildApp(env)` creates the Fastify server.
3. `src/app.ts:40-64`: repository, storage, embedding, vector, LLM, and notification providers are instantiated.
4. `src/app.ts:51-54`: the exact `LLM_PROVIDER === 'openai'` selection occurs.
5. `src/app.ts:66-68`: services are created; the selected `llm` object is injected into `ChatService`.
6. `src/app.ts:120-122`: system routes are mounted, admin routes under `/admin`, and public routes under `/v1`.
7. `src/routes/public.ts:19-25`: `POST /v1/chat` validates the body and calls `c.chat.chat(...)` after API-key/domain middleware.
8. `src/services/chat.ts:21-27`: the question is embedded and tenant-filtered vector retrieval runs.
9. `src/services/chat.ts:28-33`: the retrieved context is passed to the selected provider’s `answer()` method.

There is no provider selection in the route and no per-request provider recreation.

## 6. Mixed local/openai/local configuration

This is a supported combination:

```dotenv
EMBEDDING_PROVIDER=local
LLM_PROVIDER=openai
VECTOR_PROVIDER=local
```

The actual flow is:

- `src/app.ts:43-46` creates `LocalEmbedding`.
- `src/app.ts:47-50` creates `LocalVector`.
- `src/app.ts:51-54` creates `OpenAILlm`.
- Knowledge upload uses the same injected embedding and vector objects (`src/services/knowledge.ts:16-27`).
- Chat embeds the question with `LocalEmbedding`, searches `LocalVector` by `clientId`, then gives the retrieved chunks to `OpenAILlm` (`src/services/chat.ts:21-33`).

RAG therefore works correctly when documents and questions are embedded with the same local provider. If existing vectors were produced by a different embedding provider/model, rebuild the knowledge index before switching; otherwise dimensions/semantic spaces are inconsistent. The local embedder produces 128-dimensional deterministic vectors (`src/providers/embedding.ts:8-20`). The local vector store applies tenant filtering before cosine scoring (`src/providers/vector.ts:31-37`).

One behavior to know: if retrieval returns no chunks, `OpenAILlm.answer()` returns the tenant fallback message without calling NVIDIA (`src/providers/llm.ts:48`).

## 7. Health endpoint

`src/routes/system.ts:4-15` returns the health result from the already-instantiated objects:

```ts
app.get('/health', async () => ({
  status: 'ok',
  providers: {
    database: { provider: 'sqlite', connected: true },
    storage: { provider: 'local', connected: true },
    vector: await c.vector.health(),
    embedding: await c.embedding.health(),
    llm: await c.llm.health(),
    notification: await c.notification.health(),
  },
  ...c.metrics.snapshot(),
}));
```

`LocalLlm.health()` returns `provider: this.name`, where the name is `local-extractive` (`src/providers/llm.ts:13,30-32`). `OpenAILlm.health()` returns `openai-compatible` (`src/providers/llm.ts:35,69-74`).

The openai-compatible health check only tests `Boolean(this.key)`; it does not call NVIDIA. Thus `openai-compatible / connected: true` means configured, not externally verified. `/ready` similarly relies on these health methods (`src/routes/system.ts:16-24`).

## 8. Deployment readiness

For the intended NVIDIA deployment, **do not deploy this repository unchanged using its documented copy-`.env` plus `npm start` path**.

Required before deployment:

1. **Fix environment loading or deployment injection.** Either load `.env` before `loadEnv()`, change startup to a supported `--env-file` invocation, or inject variables through the platform/service manager. The current application does not read `.env`.
2. **Fix Compose variable pass-through if using `docker compose`.** `docker-compose.yml` passes `LLM_PROVIDER` and `OPENAI_API_KEY`, but does not pass `OPENAI_BASE_URL` or `OPENAI_CHAT_MODEL`. Without them, the code defaults to `https://api.openai.com/v1` and `gpt-4o-mini`. `OPENAI_EMBEDDING_MODEL` should also be passed if remote embeddings may be enabled.
3. **Restart/recreate the service** after setting the effective variables; provider instances are fixed at startup.
4. **Perform one authenticated staging chat call** and confirm the model identifier is accepted by the NVIDIA account. `/health` cannot prove this.
5. **Re-index knowledge** if changing an existing installation from a different embedding model/provider to local embeddings.

Production-safety changes required before treating the NVIDIA integration as resilient rather than merely functional:

6. Validate at startup that an API key exists whenever `LLM_PROVIDER=openai`; currently the server can start and `/ready` becomes false, while chat throws later.
7. Add an abort timeout around LLM/embedding/Qdrant fetches. Fastify’s request timeout does not itself make these provider calls robust against a stalled upstream.
8. Make readiness perform a bounded upstream probe if readiness is expected to represent NVIDIA availability; currently it only checks key presence.
9. Add sanitized upstream diagnostics and an explicit retry policy for retryable failures.

Additional implementation issue found during inspection: `LocalVector.upsert()` removes all existing rows for the client before adding the current upload (`src/providers/vector.ts:27-29`). Because each knowledge upload calls it separately, uploading a second document replaces that tenant’s vectors from the first document. Fix this before production if multiple knowledge files per tenant must coexist. Rebuild is also not replacement-safe because it uses the same method, although it submits all current files together.

The local SQLite, local object storage, and JSON vector store are single-node components. They can be deployed as one persistent instance, but are not appropriate for horizontal replicas without moving to shared production services. This is an operational architecture limitation rather than a requirement for a single-node launch.

## 9. Final decision

**B. `.env` + small code/deployment modifications are required.**

The NVIDIA chat adapter itself does not require a major redesign. The mandatory gaps are environment loading/injection, Compose pass-through for base URL/model, service restart, staged API verification, and the local-vector multi-file replacement bug if the advertised multi-file knowledge behavior is required. Major backend architecture changes are not required for a single-node deployment.

## 10. Bottom line

The provider-selection logic is simple and deterministic. `local-extractive` can only come from a `LocalLlm` instance, and that instance is created only when the parsed startup value is not exactly `openai`. A `.env` file by itself does not affect the current Node start command. Configure the actual process, correct the Compose mapping or add explicit `.env` loading, restart, and verify a real NVIDIA chat request. Do not use `/health` as proof that NVIDIA is reachable.
