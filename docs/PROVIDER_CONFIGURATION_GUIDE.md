# Provider Configuration Guide

Chat configuration is centralized in `src/config/llm.ts`; construction is through `createLlmProvider`, which returns only `LlmProvider`.

## Local

Set `LLM_PROVIDER_TYPE=local` and optionally `LLM_PROVIDER_NAME=local`. No key, URL, or model is required.

## Standard OpenAI-compatible endpoints

Set `LLM_PROVIDER_TYPE=openai-compatible`, a diagnostic name in `LLM_PROVIDER_NAME`, `LLM_BASE_URL` including the API version, `LLM_MODEL`, and `LLM_API_KEY`. NVIDIA Integrate, OpenAI, OpenRouter, Groq, Together, and DeepSeek retain the safe defaults: `LLM_CHAT_PATH=/chat/completions`, `LLM_HEALTH_PATH=/models`, no query parameters, `authorization`, and `Bearer`.

`LLM_API_KEY_ENV` can point to a differently named injected secret (uppercase environment variable names only). `LLM_HEADERS` is a JSON object for extra **non-secret** headers. It cannot override authentication, content type, or transport headers. The configured authentication header is always generated from the value of `LLM_API_KEY_ENV`; do not put a key in `LLM_HEADERS` or `LLM_QUERY_PARAMS`.

## Azure OpenAI and other non-default layouts

`LLM_CHAT_PATH`, `LLM_HEALTH_PATH`, `LLM_QUERY_PARAMS`, `LLM_AUTH_HEADER_NAME`, and `LLM_AUTH_SCHEME` configure transport without source changes. Paths must be normalized absolute paths (not URLs, queries, or fragments). Query parameters are a JSON string map and are URL-encoded by the adapter; secret-looking query names are rejected. An empty `LLM_AUTH_SCHEME` sends the key without a prefix.

Example Azure OpenAI deployment (inject the secret through a secret manager, rather than committing it):

```dotenv
LLM_PROVIDER_TYPE=openai-compatible
LLM_PROVIDER_NAME=azure-openai
LLM_BASE_URL=https://YOUR-RESOURCE.openai.azure.com
LLM_MODEL=YOUR-DEPLOYMENT
LLM_CHAT_PATH=/openai/deployments/YOUR-DEPLOYMENT/chat/completions
LLM_HEALTH_PATH=/openai/models
LLM_QUERY_PARAMS={"api-version":"2024-10-21"}
LLM_API_KEY_ENV=AZURE_OPENAI_API_KEY
AZURE_OPENAI_API_KEY=<injected secret>
LLM_AUTH_HEADER_NAME=api-key
LLM_AUTH_SCHEME=
```

Sampling, stream mode, timeout, exponential retry count/base delay are controlled by the corresponding `LLM_*` values in `.env.example`. Configuration fails at startup if URL, model, or referenced key is absent. `.env` is loaded for `npm start` and `npm run dev`; existing process/platform variables win because dotenv does not override them.

`/health` and `/ready` make a bounded authenticated `GET` at the configured health path, with configured non-secret query parameters. They report configured, reachable, authentication, provider, model, and base URL status only: neither key material nor query parameters are returned. A provider may require a health path other than `/models`; validate both that probe and a completion in staging.
