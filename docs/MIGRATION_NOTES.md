# Migration Notes

## From legacy chat variables

Preferred variables are `LLM_PROVIDER_TYPE`, `LLM_PROVIDER_NAME`, `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`. Legacy `LLM_PROVIDER=openai`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_CHAT_MODEL` remain accepted for chat migration, but generic values take precedence. `OPENAI_*` remains the embedding adapter configuration. Remove legacy chat values after validating the generic deployment. Standard compatible providers need no transport settings beyond the defaults. For Azure OpenAI or another non-default layout, migrate path/query/auth details to `LLM_CHAT_PATH`, `LLM_HEALTH_PATH`, `LLM_QUERY_PARAMS`, `LLM_AUTH_HEADER_NAME`, and `LLM_AUTH_SCHEME`; keep the key only in the environment variable named by `LLM_API_KEY_ENV`.

Changing providers requires a process restart. It does not require knowledge reindexing when embeddings remain unchanged. Changing `EMBEDDING_PROVIDER` or embedding model requires rebuilding every tenant index.

Local vector uploads now replace only chunks from the same source filename and preserve all other tenant files. Rebuild explicitly clears and reconstructs that tenant's index. Existing indexes need no migration; run rebuild once if prior uploads were lost under the old tenant-wide replacement behavior.
