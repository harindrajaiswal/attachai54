# Test report

Final validation on 2026-08-02:

| Check                                       | Result                   |
| ------------------------------------------- | ------------------------ |
| Prettier                                    | PASS                     |
| ESLint                                      | PASS                     |
| Backend TypeScript                          | PASS                     |
| React/Vite production build + backend build | PASS                     |
| Vitest unit/integration/API                 | PASS — 4 files, 40 tests |
| Playwright Chromium desktop/mobile          | PASS — 2 tests           |
| Root npm audit                              | PASS — 0 vulnerabilities |
| Dashboard npm audit                         | PASS — 0 vulnerabilities |

Machine-readable Playwright output: `browser-e2e-result.json`. Responsive captures: `playwright-desktop.png` and `playwright-mobile.png`.

The API suite covers authentication, tenant isolation, client/key/domain lifecycle, prompt versions, analytics, settings/provider staging, health, widget configuration, RAG, uploads, leads and security validation. Browser coverage validates login, protected rendering, navigation/empty state, desktop/mobile menu behavior, screenshots, logout and protection after reload. It does not automate every UI mutation path; those flows have API integration coverage.

Vite reports a non-failing 680 kB main-chunk warning. Route-level splitting is a future performance improvement.
