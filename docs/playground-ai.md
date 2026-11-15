# Playground AI and Arena ECR connection

The Playground works locally without AI: model viewing, visual proposal editing, labels, drawing, Undo/Redo, comparison, and the Preview ECR workflow do not need an AI service. The assistant is optional. In the packaged Chrome extension it uses the user's own Claude API key; in local web development it can use the server gateway described below. An unconfigured connection is displayed as unavailable; the app does not substitute a canned response and call it Fable.

## Implemented connection

| Boundary | Current behavior |
| --- | --- |
| `GET /api/viewer/v1/playground/status` | Viewer-owned capability response, scoped by `sourceMode` and `workspaceId`; never claims live ECR support |
| `POST /api/viewer/v1/playground/propose` | Accepts a bounded scene description and design intent; returns a proposed transaction for user review |
| Anthropic adapter | `shared/playground-provider.mjs` calls the official Messages API at a fixed endpoint with the key it is given (a server environment variable, or the user's key in the extension); supports a configurable Claude model ID |
| Browser | Validates the entire transaction again and checks proposal ID, version and exact source key before applying it |
| Chrome package | Calls `https://api.anthropic.com/v1/messages` directly from the viewer page with the user's own API key saved in the extension options. That host is the only outside origin in the extension's connection policy and host permissions. |
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

## Assistant in the packaged Chrome extension

The extension has no server. A user enables the assistant by saving their own Claude API key under **Connect Claude** in the extension options. This was a product-owner decision; it trades the server-held key for a setup with nothing to host.

| Aspect | Behavior |
| --- | --- |
| Storage | `chrome.storage.local` keys `assistantApiKey`, `assistantModel`, `assistantShareImages`. The service worker sets the storage access level to trusted contexts on every start, so content scripts on Arena pages cannot read it; they get their three launch settings from the service worker by message. |
| Display | The options page never shows the saved key again, only its last four characters. **Remove key** deletes it. |
| Transport | `src/playground/extension-assistant.ts` runs in the viewer page. It validates the request, calls the shared adapter with `anthropic-dangerous-direct-browser-access: true`, validates the returned plan, and the client validates it again against the current proposal. The request carries no cookies and follows no redirects. |
| Reach | The manifest allows `connect-src 'self' blob: https://api.anthropic.com` and host permission for `https://api.anthropic.com/*` only. `scripts/build-extension.mjs` rejects any other host. The API URL is fixed in code. |
| Model | Defaults to `claude-fable-5-2`; any `claude-…` model ID the key can use may be entered. **Test connection** makes one read-only models request that produces no output. |
| Images | Sent only when the user turns on image sharing in the options and also chooses to attach a view to that request. |
| Limits | The same 200 components, 100 marks, 40 commands, 4 MiB body and 95-second deadline as the gateway. There is no request budget: spend is limited only by the key's own limits. |

### Conversation and ECR drafting

- **Follow-up requests.** The Playground keeps the turns of the current session (what was asked, what was suggested, and whether it was applied or dismissed) in memory. Up to 20 earlier turns of at most 2,000 characters are sent with each request so that "a bit more" or "the same on the other side" can be understood. The current scene remains the authority for state. The conversation is not saved with the proposal and is cleared on reload, on **Clear**, or when a proposal is opened from a file.
- **Draft with Claude.** In the Create ECR dialog, in the extension with a saved key, the user can ask for suggested wording. The request sends the product context, the accepted change summaries (source value, proposed value, delta), the numbered markup instructions, stated assumptions and the session's turns. It sends no geometry, images, source hashes or delivery URLs. The reply is a title, a description and open questions, shown as a suggestion that is not used until the user chooses it; it never overwrites typed text on its own and stays editable. Claude is instructed to leave out display-only actions and dismissed ideas and not to invent dimensions or reasons, but the wording must still be reviewed.
- **Applying suggestions.** By default a validated suggestion is applied to the Playground proposal as soon as it arrives. The panel then shows what was applied, with its assumptions and **Undo this change**. A reply that asks a question is never applied. The user can turn on **Review each suggestion before it is applied**, in the assistant panel or the extension options, to see each suggestion and choose **Apply suggestion** instead. Either way only the visual proposal changes; source CAD and Arena records are never edited, and every suggestion passes the same validation and source/version checks first.

What a user should know before saving a key:

- The key is stored unencrypted in the Chrome profile. Anyone who can use that profile, or malware on the machine, can read or use it. Use a dedicated key with a spend limit and revoke it when it is no longer needed.
- There is no administrator control over what is sent. Each request sends the instruction, component names, item numbers, revisions, poses and markup notes to Anthropic. Source STEP, PDF and Word files are not sent.
- A declined request (`stop_reason: "refusal"`) is reported as declined and leaves the proposal unchanged. Server-side model fallback is not enabled.
- No request has been made with a real key during development. The first live test should confirm the model ID, structured output and response time against the user's own account.

The service-worker route described in earlier revisions of this page (extension to an administrator gateway) is not implemented.

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
