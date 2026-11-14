# Playground AI and Arena ECR connection

The Playground works locally without AI: model viewing, visual proposal editing, labels, drawing, Undo/Redo, comparison, and the Preview ECR workflow do not need an AI service. The assistant is an optional server connection. An unconfigured connection is displayed as unavailable; the app does not substitute a canned response and call it Fable.

## Implemented connection

| Boundary | Current behavior |
| --- | --- |
| `GET /api/viewer/v1/playground/status` | Viewer-owned capability response, scoped by `sourceMode` and `workspaceId`; never claims live ECR support |
| `POST /api/viewer/v1/playground/propose` | Accepts a bounded scene description and design intent; returns a proposed transaction for user review |
| Anthropic adapter | Calls the official Messages API using a server-only key and a fixed endpoint; supports configurable Claude model ID |
| Browser | Validates the entire transaction again and checks proposal ID, version and exact source key before applying it |
| Chrome package | Local editing remains available; assistant reports that the authorized hosted viewer is required. No outside AI host is added to the extension CSP. |
| Live Arena | Requires the existing authenticated user/workspace connection and a separately configured external-AI sharing policy |
| Live ECR | Disabled. A server-only orchestration seam is tested with simulated bindings, but no Arena write MCP tool is mapped or exposed. |

The assistant returns fixed parameters for packaged operations: transform, resize a concept primitive, add a box/cylinder/bracket concept, remove/restore a proposed component, change display color, or rename a label. Explosion, label visibility, original/proposed/overlay selection and hidden components are separate display instructions. No JavaScript, remote modules, `eval`, arbitrary tool names or arbitrary API URLs are accepted. The existing STEP parser continues to run locally; source STEP geometry is never rewritten.

Source meshes cannot have a hole relocated by the assistant. The assistant can interpret that markup, describe the requested change, or propose a separately named approximate concept bracket. Unknown dimensions or ambiguous 2D-to-3D depth should produce questions. Imported source identities remain immutable. Added concepts carry AI provenance and assumptions assigned at the gateway. An optional image carries its exact model camera/presentation or document file/revision/edition/hash/page identity. Model screenshots can be exploded or show original/overlay geometry; their display offsets must not be interpreted as installed proposed positions.

## Local development configuration

Use Node.js 22 or later. Put these values in the checkout's ignored `.env.local`, or supply them as server process environment variables. The values below are placeholders. Do not use `VITE_` for a secret.

```dotenv
PLAYGROUND_AI_ENABLED=true
PLAYGROUND_ANTHROPIC_API_KEY=YOUR_SERVER_ONLY_API_KEY
PLAYGROUND_MODEL=claude-fable-5-2
PLAYGROUND_ALLOWED_ORIGIN=http://localhost:5173
PLAYGROUND_ALLOW_LOCAL_PREVIEW=true
PLAYGROUND_ALLOW_IMAGES=false
```

Run `npm run dev`, then open **exactly** `http://localhost:5173`. If Vite chooses another port, update the allowed origin and restart. The Preview opt-in works only for a loopback origin and a request arriving from a loopback address. It cannot enable anonymous hosted AI spending. Use `PLAYGROUND_ALLOW_IMAGES=true` only when sending explicitly attached screenshots is appropriate. The UI must still request an image attachment for each prompt; the flag does not automatically upload images.

`node server/index.mjs` reads process environment variables directly; it does not load `.env.local`. Production must mount that BFF behind the viewer's same origin. A standalone static build has no API key or AI execution service.

The default model ID was checked against [Anthropic's Fable 5.2 documentation](https://platform.claude.com/docs/en/models/fable-5-2/overview) on November 14, 2026. The adapter uses `output_config.format` with a constrained JSON schema as documented in [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). It omits forced tool choice and unsupported sampling parameters. Array lengths, numeric bounds and transaction semantics are checked locally because schema adherence alone does not establish engineering correctness. No authenticated live Anthropic request was performed during this implementation; a deployment's model access and billing must be tested with its own approved account.

The model receives the prompt, compact original/proposed component data, source identity metadata, annotations and any expressly attached image. The baseline lets it describe actual accepted changes without inferring them from the current view. It does not receive original STEP/PDF/DOCX files automatically. Anthropic currently documents a 30-day retention requirement for Fable 5.2 unless it explicitly grants an exception; administrators should choose a model and account appropriate for their engineering information. This is separate from permission to read a file in Arena.

## A future assistant inside the packaged Chrome tab

The current extension intentionally keeps `connect-src 'self' blob:` and does not embed an AI credential. To add remote assistant access while keeping the UI in that extension tab, use a packaged extension service worker as a narrowly scoped transport to an administrator-approved HTTPS gateway. That gateway still owns the model key, user/session authorization, external-processing policy, budgets and ECR bindings. A future extension build must declare the approved gateway origins in both its connection CSP and optional host permissions; it should request only the particular configured origin when that feature is enabled. Host permission alone does not override the current restrictive connection CSP. It must not accept arbitrary fetch URLs or expose a generic proxy to content scripts. See Chrome's official [cross-origin request guidance](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) and [permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions).

Authenticate the human user with an extension-appropriate supported OAuth flow and retain only short-lived connection state, not the AI vendor key. The gateway will need an explicitly registered extension client and validated token audience/user/workspace; its current cookie-authenticated same-origin route cannot simply be reused by removing the Origin check. Validate messages on both ends and bind results to the same proposal/source guards used here. These are planned changes requiring installed-extension authentication/CSP qualification; this release does not claim them as implemented. Ordinary local Playground operations remain fully packaged today.

## Live user and source authorization

The server reuses `provider.authorize(request, { signal })`. It checks the resulting human user, workspace and current `X-Viewer-Connection` guard. It additionally requires this trusted provider hook:

```text
authorizePlaygroundAI(context, details) -> { allowed: boolean, allowImages: boolean }
```

This is a viewer-owned integration hook, not an Arena MCP tool name. `details.phase` is `status` or `propose`. A proposal authorization includes source context, component identities, annotations, image context and whether an image is attached. The tenant binding must verify permitted external processing and the exact referenced source access. It must not interpret ordinary read access as permission to export information to an AI provider. If the hook is absent, live AI remains unavailable.

POST requests require the exact configured Origin and the non-simple `X-Playground-Request: 1` header. The service exposes no CORS wildcard. The provider key, cookies and session tokens are never sent to the assistant or stored in proposal data. Errors exposed to the browser use a fixed public vocabulary rather than upstream response bodies.

Requests are bounded to 200 components, 100 marks, 40 returned commands, a 4 MiB body, and a 2 MiB optional screenshot. A server request has a 90-second deadline and observes browser cancellation. The default instance allows one in-flight request per user, four total, six per minute and twenty per hour per user. These local process budgets are a development safeguard, not a distributed billing quota; a scaled deployment needs shared quotas. No partial response is applied. A stale, canceled, malformed or rejected response leaves the existing proposal unchanged.

## ECR integration seam

The UI currently uses `SimulatedEcrAdapter`. It produces a clearly labeled Preview receipt with no Arena URL and sends no network request. A real URL must come from a successful write and readback in the authorized workspace.

`server/playground-ecr.mjs` provides `createEcrDraftService` for binding tests. It is deliberately not mounted as a public route and does not change `liveEcr: false`. It requires a reviewed server provider, an explicit HTTPS Arena origin allowlist and a durable journal. The following names are internal contracts; an administrator must map each to actual supported Arena MCP operations after their catalog and schemas are available.

| Provider method | Required behavior |
| --- | --- |
| `authorize` | Resolve the current human user, workspace and connection |
| `validateReview` | Validate the complete normalized package, exact source permissions, affected revisions, create/edit rights and attachment rights; return true only when all checks pass |
| `findDraft` | Find the draft for an exact operation key and package digest, including recovery after a lost create response |
| `createDraft` | Create an ECR draft idempotently with its reviewed title and description; return verified draft identity and digest |
| `setAffectedItems` | Set the selected exact item/revision identities idempotently |
| `attachFile` | Upload bytes idempotently by operation key and verified content hash |
| `readDraft` | Return draft state, workspace, title, description, affected items, attachment names/hashes and actual Arena URL |

The required journal exposes `runExclusive`, `get` and `put` and must be durable, atomic and shared across server processes. The repository intentionally supplies no in-memory production fallback. Every retry reauthorizes, verifies the package digest and file hashes, resumes completed steps and reads back the resulting record. An uncertain creation is recovered through `findDraft` before another create is attempted. The returned URL must use an allowed HTTPS Arena origin. Failed or partial operations do not produce a success receipt; the journal retains enough state to resume. No step submits, releases or approves a change request.

Before enabling a public live route, finish the actual tenant bindings and durable journal, verify their permission/idempotency semantics with Arena, and add the same origin/session protections used by the assistant route. This is the remaining live integration work, not a capability claimed by the Preview.

## Verification

`tests/playground-gateway.test.js` exercises origin checks, loopback opt-in, exact user/workspace guards, sharing policy, optional images, bounded input, provider timeout, request budgets and public error handling. `tests/playground-assistant.test.ts` covers the extension's no-network path, missing static backend, source/version guards, atomic validation and cancellation. `tests/playground-ecr-service.test.js` covers idempotent draft orchestration, lost-create recovery, changed attachment bytes, access revocation and verified URL readback using synthetic bindings. Existing Arena read-route tests continue to protect the original read-only integration behavior.
