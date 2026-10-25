# Design

The service is a modular Fastify application. Routes enforce boundaries and call domain services; services depend on repository/provider interfaces rather than infrastructure implementations.

```text
widget -> public auth (hashed key + exact Origin) -> ChatService -> embedding -> tenant-filtered vector search -> LLM
admin  -> admin auth -> Client/Knowledge services -> SQLite + object storage + vector provider
lead   -> repository -> notification provider
```

Tenant identity is resolved once from the SHA-256 API-key digest and is never accepted from a public request body. Every vector operation receives that resolved tenant ID. Metadata foreign keys cascade on deletion. Files are rooted under a validated tenant segment.

Local mode uses SQLite, local object files, deterministic embeddings, JSON/cosine vectors, an extractive LLM, and a JSON outbox. Production adapters include OpenAI-compatible embeddings/chat, Qdrant, and SMTP.

## Generic LLM boundary

`config/llm.ts -> createLlmProvider(config) -> LlmProvider` isolates vendor naming and settings from services/routes. The compatible adapter supports configurable endpoint paths, query parameters, authentication header/scheme, non-streaming or SSE response aggregation, bounded timeout/retry, and safe authenticated diagnostics. Standard providers use Bearer authentication and `/chat/completions`; Azure-style deployment paths and `api-key` authentication are configuration-only changes. `ChatService` remains unaware of vendor or transport.

Knowledge upload calls `replaceSource`, so source A and B coexist while a new A supersedes only old A. Rebuild deliberately deletes the tenant index and upserts every stored source. All searches retain the resolved `clientId` filter.
