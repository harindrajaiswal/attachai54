# Delivery report

## 1. What was built

A modular TypeScript/Fastify multi-tenant RAG backend following the supplied PDF: protected client administration, one-way-hashed client keys, exact domain authorization, strict client configuration, prompt/config/knowledge uploads, TXT/MD/PDF/DOCX parsing, chunking and embeddings, tenant-isolated vector search, grounded chat, conversations, leads, notification providers, analytics/audit records, monitoring, backups, and an embeddable browser widget.

Local mode is self-contained: SQLite metadata, path-safe object storage, deterministic embeddings, persistent cosine vectors, extractive grounded answers, and a JSON outbox. Production adapters/configuration are included for OpenAI-compatible LLM/embeddings, Qdrant, and SMTP.

## 2. Repository structure

- `src/routes`: admin, public, and system APIs
- `src/services`: clients, ingestion, parsing, chat orchestration
- `src/providers`: storage, embeddings, vectors, LLM, notifications
- `src/repositories`: repository contract and SQLite implementation
- `src/domain`, `src/config`, `src/lib`: schemas, types, environment, security, metrics, errors
- `public`: widget and browser fixture
- `tests`: unit/integration/end-to-end coverage
- `scripts`: checksum-verified backup/restore
- `dist`: compiled output
- `Dockerfile`, `docker-compose.yml`: deployment packaging

The complete inventory is in `FILES.md`.

## 3. Setup and environment

Copy `.env.example` to `.env`, set a strong `ADMIN_API_KEY`, then select providers. Core variables are `HOST`, `PORT`, `DATA_DIR`, `PUBLIC_BASE_URL`, `EMBEDDING_PROVIDER`, `LLM_PROVIDER_TYPE`, `LLM_PROVIDER_NAME`, `VECTOR_PROVIDER`, and `NOTIFICATION_PROVIDER`. Generic `LLM_*` settings control the chat provider, endpoint paths, model, referenced secret, sampling, timeout, retries, query parameters, and authentication layout. Qdrant, SMTP, and embedding settings are documented separately. Secrets are ignored by Git, redacted from logs, and never returned by diagnostics.

## 4. Run locally

```bash
npm install
npm run build
npm start
```

Open `/demo.html`; create a client through the protected admin API and use the returned embed snippet on an allowlisted domain.

## 5. Test

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

Final result: **36/36 tests passed**, zero failures, and zero known production dependency vulnerabilities. The final local Chromium run passed widget loading, two-file knowledge retrieval, and session persistence. API verification passed health/readiness, ingestion, chat, lead/outbox flow, invalid key/domain rejection, tenant isolation, provider switching, Azure-style transport configuration, timeout/retry handling, dotenv precedence, missing-key fail-fast startup, and checksum-verified backup/restore.

## 6. Deploy

Use the Dockerfile on a VPS, Railway, Render, DigitalOcean, AWS, or Google Cloud. Compose includes the app and Qdrant. For multiple replicas, replace local SQLite/storage/vectors with PostgreSQL, private S3-compatible storage, and authenticated TLS Qdrant; use managed secrets, HTTPS/WAF, centralized rate limiting, a notification queue, and provider-native backups.

## 7. Limitations and follow-ups

The self-contained local providers are production-minded but single-node. PostgreSQL and S3 are documented extension points rather than bundled implementations. Live SMTP, paid LLM endpoints, and authenticated Qdrant require deployment credentials/infrastructure and should be staging-tested before launch. Add durable notification queues, retention/erasure workflows for PII, distributed rate limiting, and full accessibility/cross-browser coverage before large-scale rollout.

## 8. Architecture tradeoff

Fastify was selected over the PDF’s suggested Express because it provides strong schema-driven request handling and low overhead while preserving the same layered architecture. SQLite/local vectors keep development deterministic; provider interfaces prevent that convenience from coupling business logic to single-node infrastructure.
