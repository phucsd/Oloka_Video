# Oloka Mov · LLM Connection Manager

Deployed: https://oloka-mov-llm-admin.phucsd.workers.dev

This folder is a standalone, version-controlled implementation connected to the **existing** Oloka Mov Supabase project. It does not modify the legacy Oloka Video app's existing UI or rendering source. Branch: `feature/oloka-mov-llm-connection-manager`.

## Components

- `cloudflare/worker.js` — Cloudflare Worker serving the Admin HTML and a same-origin proxy for the gateway API.
- `supabase/functions/oloka-llm-gateway/index.ts` — Admin-authenticated model/connection CRUD, dynamic model discovery, provider verification, and generation endpoint.
- `supabase/functions/oloka-llm-admin/index.ts` — original self-hosted HTML source (Supabase Edge currently serves HTML with text/plain, so the Cloudflare Worker is the usable frontend).
- `supabase/migrations/...` — database migration already applied to project `oloka-mov`.

## Sign in and configure

1. Open the Cloudflare URL. Sign in with an existing Supabase Auth user whose **auth user ID** appears in `public.mov_admins`.
2. Add connection: descriptive name, provider slug (any lowercase slug), protocol, full public HTTPS Base URL, models path and chat path.
3. Save API key (Vault stores the secret; it is never sent back to the browser). Multiple connections per provider are supported.
4. Use **Tìm models** when the provider supports model discovery, or enter a model ID manually.
5. Use **Test kết nối** for that model. Only after a successful test is it marked enabled. **Dùng thử** sends a normal generation request.
6. Editing a connection URL/protocol or replacing a key invalidates previous verification, requiring another test.

Supported protocols:
- OpenAI-compatible: e.g., base `https://api.example.com/v1`, models `/models`, chat `/chat/completions`.
- Anthropic native: e.g., base `https://api.anthropic.com/v1`, chat `/messages`.
- Gemini native: e.g., base `https://generativelanguage.googleapis.com/v1beta`, chat `/models/{model}:generateContent`.

Providers can override these paths; model discovery requires a provider-compatible list endpoint. New APIs that do not follow one of the three protocols require an adapter.

## Gateway contract

All routes except `GET /config` and `GET /` require:
`Authorization: Bearer <Supabase Auth access_token>`, and the user's ID must be in `public.mov_admins`.

Example: `GET /functions/v1/oloka-llm-gateway/api/connections`
returns only public connection metadata, `has_api_key`, and model metadata — never key contents.

Example completion:

```http
POST /functions/v1/oloka-llm-gateway/api/connections/<connection_id>/complete
Authorization: Bearer <Supabase Auth access_token>
Content-Type: application/json

{"model":"qwen-plus","messages":[{"role":"user","content":"Outline a 60-second cooking video."}],"max_tokens":1200}
```

Use the **Cloudflare Worker origin** for browser requests. Responses include `text`, `model` and `connection_id`. Only enabled, verified models may be used. Output token budget is capped at 2048 for this first release.

## Security and guardrails

- Backend verifies the Supabase access token with Auth and separately checks `mov_admins` on every protected operation.
- Public Edge Function `verify_jwt=false` is necessary for its unauthenticated `/config`; admin operations still enforce explicit authorization in code.
- Secrets are managed by existing privileged `mov_connection_key_set/get/delete` RPCs via Supabase Vault. Privileged RPCs are not callable by anon/authenticated roles.
- Provider URLs must use HTTPS with a public hostname; IP literals, localhost, internal domains, alternate ports, credentials, URL fragments and redirects are blocked.
- Requests use a 12-second timeout; errors do not expose the API key. This first version does not protect against all DNS rebinding scenarios; use hostname allowlisting for high-trust environments.
- All model usage is currently **admin-only** to limit unintended spend. A user-level usage policy/rate limit is needed before opening the feature to all Oloka Mov creators.

## Verification performed

- Supabase database migration succeeded.
- Three Edge deployments were created successfully; Cloudflare Worker deployed and workers.dev enabled.
- Browser smoke (Chromium/Chrome): page 200, `text/html`, visible login form, no JavaScript console errors.
- API unauthenticated calls return 401.
- Supabase Vault temporary-key roundtrip: set, retrieve, delete, remove test connection in a single SQL run.

## Not yet verified / next integration

- An actual provider's key and model have **not** been tested because no custom keys were configured before deployment.
- The admin UI has not been integrated into the current Oloka Mov video-creation frontend because that frontend's up-to-date source/deployment has not been located in the connected GitHub and Cloudflare environments.
- Connect the current video pipeline's storyboard/planning/edit LLM calls to `/complete` (or internal same-security equivalent) and add a model dropdown once the active app repository is identified.
- Perform authenticated browser CRUD E2E and real-provider model test, then generate/inspect one video end-to-end.
