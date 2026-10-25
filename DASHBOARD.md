# Admin dashboard

Open `/admin/` (or `/admin/index.html`). `dashboard/` is a React 19 + TypeScript + Vite + Tailwind 4 project; `npm run dashboard:build` emits deployable assets to `public/admin/`.

## Authentication and browser security

Login validates against `POST /admin/auth/validate`. The admin key is kept only in `sessionStorage`, attached as `x-admin-api-key`, and cleared on logout; it is never returned by an API or placed in URLs/localStorage. Admin auth does not use cookies, so ambient browser credentials cannot authorize cross-site requests and conventional cookie-CSRF is mitigated. Production CORS uses the explicit `CORS_ORIGINS` allowlist; development additionally allows loopback origins. Use HTTPS and a long random key.

## Live features

The UI reads persisted APIs for overview totals/audits, client CRUD/suspension/duplication/key lifecycle/domains, prompt autosave/version restore/reset/preview, knowledge multi-upload/replace/delete/rebuild, widget configuration/embed, lead workflow/export, analytics, provider staging/test/env generation, system diagnostics and polled health. Empty datasets render honest empty states. API keys are shown once on create/rotate.

Provider changes are staged as **non-secret** settings and require an environment update/restart. Test Connection uses the supplied one-request configuration without changing the running provider. Secrets are write-only request values and are neither persisted nor returned. Generated env output contains a placeholder, never the submitted secret.
