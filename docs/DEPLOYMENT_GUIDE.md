# Deployment Guide

1. Use Node 24+, run `npm ci`, `npm run build`, and start `node dist/src/server.js`.
2. Inject secrets from a secrets manager. `.env` is for controlled single-host use and is never copied by the Dockerfile.
3. Choose local or compatible chat settings from the provider guide. Restart/recreate after configuration changes.
4. For Compose, all generic LLM, embedding, vector, notification, and SMTP variables are passed through. Quote JSON `LLM_HEADERS` and `LLM_QUERY_PARAMS` in the shell or Compose env file. The sample Compose file forwards `AZURE_OPENAI_API_KEY` for its Azure example; for another secret name, add that secret to the deployment environment rather than placing it in headers or query parameters.
5. Gate traffic on `/ready`; `/health` exposes safe diagnostics and process metrics. Restrict health/metrics at the edge if infrastructure details are sensitive.
6. Use PostgreSQL, S3-compatible private storage, and authenticated TLS Qdrant before horizontal scaling. Local SQLite/files/vector JSON require one persistent app replica.
7. Apply TLS, WAF/shared rate limits, log/PII retention, encrypted backups, credential rotation, and least privilege.
8. Validate one authenticated staging chat for the selected account/model. A successful health probe is not proof of model entitlement.

Backup local mode while quiesced with `npm run backup -- /secure/backups`; restore to an empty target with `npm run restore -- BACKUP_PATH (with DATA_DIR set to the restore target)`, then verify checksums and run readiness/RAG smoke tests.
