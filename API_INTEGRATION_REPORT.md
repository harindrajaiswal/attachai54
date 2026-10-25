# Dashboard API integration report

All visible data comes from persisted backend APIs; empty states are not replaced with fixture values.

| Family           | Endpoints/use                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Auth/overview    | `POST /admin/auth/validate`, `GET /admin/overview`                                                             |
| Clients          | list/search/filter/page, create/get/patch/delete/duplicate; key rotate/disable/enable; allowed domains         |
| Prompts          | history, restore, reset and preview under `/admin/clients/:id/prompts/*`                                       |
| Knowledge        | list metadata, multipart multi-upload/replace, delete and rebuild                                              |
| Widget           | client config persistence plus public `GET /v1/config`; embed uses `/widget.js`                                |
| Leads            | list/search/filter/page, detail/conversation, patch workflow and CSV export                                    |
| Analytics        | daily/weekly/monthly persisted series, conversion, latency, knowledge usage/questions; honest empty `topPages` |
| Providers/system | non-secret stage/display, ephemeral connection test, env generation, redacted system settings and health       |

All `/admin/*` routes require constant-time `x-admin-api-key` validation. Tenant secrets are hash-only and create/rotation responses are copy-once. Provider secrets are accepted only for ephemeral tests and are never persisted or returned.
