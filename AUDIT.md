# Implementation audit

## Architecture

Routes, services, repository, storage, embedding, vector, LLM, and notification concerns are separated with explicit interfaces. SQLite provides relational client/key/domain/conversation/message/lead/usage/audit records. Local providers make tests deterministic. The design favors a single-process first release; JSON vector writes serialize the full index and are not intended for high concurrency.

## Security review

- Tenant keys are random and one-way SHA-256 hashed; admin and public authentication are distinct.
- Tenant resolution comes only from credentials. Exact normalized domain matching prevents substring/suffix bypasses.
- Vector search and mutation always include tenant ID. Isolation has an e2e regression test.
- Strict request schemas, body/upload limits, Helmet, rate limiting, path-safe storage, safe errors, and secret-header log redaction are present.
- API-key hashing is appropriate for high-entropy generated keys; password-style slow hashing is unnecessary. Database compromise still warrants rotating all keys.
- CORS is not treated as authorization; Origin checks happen in tenant authentication. Non-browser callers must supply an allowlisted Origin.
- Local outbox is intentionally non-delivering. Protect filesystem data/backups because leads and transcripts contain PII. Add retention/deletion policy and encryption at rest in deployment.

## Scalability/reliability tradeoffs

SQLite and JSON cosine search are self-contained but single-node. Move to PostgreSQL, S3-compatible storage, and Qdrant before horizontal scale. Qdrant filter isolation should additionally use per-tenant collections for unusually sensitive/high-volume tenants. Notifications are synchronous; a production implementation should use a durable queue, idempotency keys, retries, and dead-letter handling. Rate limiting is in-process; use Redis/edge limits for replicas. Conversation history is persisted but intentionally not sent to the LLM, reducing prompt-injection carryover and token use.

## Remaining external validation

No credentials or external infrastructure were used. OpenAI-compatible embedding/chat network behavior, authenticated Qdrant lifecycle against a live server, SMTP delivery, PostgreSQL migration, and a future S3 adapter require staging validation. Browser fixture is served and asset-tested; full cross-browser visual/accessibility testing remains a deployment task.

## Final browser verification

A real headless Chromium session loaded the served fixture, opened the widget, submitted a tenant-scoped question to the running backend, displayed the retrieved answer (“4 to 6 weeks”), and persisted the conversation session. Evidence is in `browser-widget-result.json`. A separate live API run verified health/readiness, ingestion, retrieval, invalid-key rejection, invalid-origin rejection, lead persistence, and file-outbox notification; see `browser-e2e-result.json`.

## 2026 provider and ingestion refactor

Chat configuration is centralized in a generic typed module and all provider creation crosses an abstraction-only factory. Non-local configuration is validated before the server is built. dotenv uses non-overriding defaults, so deployment injection wins. Provider diagnostics expose no credential/header values. Network calls are aborted per attempt and retries are restricted to transient transport/HTTP classes; total worst-case duration includes every attempt and exponential delay.

The local vector defect that deleted all tenant vectors on every upload is fixed. Source replacement preserves other sources; explicit tenant deletion remains the rebuild/delete path. Qdrant source replacement is delete-then-upsert and should be upgraded to a version/alias strategy where no transient gap is acceptable.

The configured authenticated diagnostic is intentionally stronger than key-presence readiness, but health endpoint behavior varies by provider. Deployment must configure and validate that endpoint and a real completion. No live NVIDIA test was performed and no secret upload was read.

A final local headless Chromium run against the built refactored server created a tenant, uploaded two distinct knowledge files, loaded the real widget, retrieved a correct answer from each source, and persisted the widget session. Evidence is in `browser-provider-refactor-result.json`; the older browser JSON files remain historical evidence.
