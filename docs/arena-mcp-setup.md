# Arena MCP setup

This guide separates the working viewer integration from the remaining Arena deployment configuration. Preview remains the default. A configured connection uses each person's Arena grant; it never falls back to an administrator token or sample BOM.

## Current implementation and verification

The application includes a server-only MCP client, a same-origin browser API, protected file delivery, a live workspace loader, OAuth discovery/PKCE/session plumbing, and explicit connection states. Exact Arena tool names and response mappings are intentionally unset because no authenticated tool catalog has been retrieved.

The server uses the installed `@modelcontextprotocol/client` 2.4.0 SDK with Streamable HTTP. The SDK handles MCP initialization and protocol negotiation. Synthetic-wire tests exercise the actual SDK; the browser does not implement MCP or invoke arbitrary tool names. The supplied notes use the earlier `@modelcontextprotocol/sdk` package as an implementation sketch; the current code follows the installed SDK's verified API instead.

The app's OAuth login is independent of any coding assistant connection. Connecting Claude, Codex, or another assistant does not provide runtime credentials to this application.

## Development endpoint evidence

| Setting | Value or status |
| --- | --- |
| Documented sand26 MCP endpoint | `https://mcp-dev.srv.aws.bom.com/sand26/mcp` |
| Other development example in the supplied notes | `https://mcp-dev.srv.aws.bom.com/mcp`; routing equivalence has not been established |
| Production MCP endpoint | Not verified; no production URL is assumed |
| Actual unauthenticated sand26 probe | HTTP 401 with a `WWW-Authenticate` discovery header |
| Resource metadata URL returned by that probe | `https://mcp-dev.srv.aws.bom.com/.well-known/oauth-protected-resource/sand26/mcp` |
| Actual protected-resource metadata response | HTTP 200 |
| Resource identifier returned by metadata | `https://mcp-dev.srv.aws.bom.com/sand26/mcp` |
| Advertised authorization server | `https://oauth.sand.bom.com:8261` |
| Advertised scope list | Empty; no scope names are invented |
| Advertised bearer method | HTTP authorization header |
| Authorization-server metadata probe | Timed out from this development environment; authorization/token endpoints were not verified |
| Actual Arena login, tool catalog, file retrieval | Not completed |

These observations were made during the November 12, 2026 Pacific development session. The runtime must rediscover metadata: the observed values are diagnostic evidence, not substitutes for discovery. An initial 401 is expected. An authorization-server timeout is a separate connectivity problem and is not evidence that an authenticated request succeeded.

## Runtime structure

The Chrome launcher opens a viewer URL containing source identifiers. The browser calls only `/api/viewer/v1` on the viewer's origin. The server verifies the viewer's OAuth session, obtains that user's Arena token, and calls the configured Arena MCP endpoint. Normalizers turn verified tool responses into the viewer's stable domain contract. Protected file requests repeat authorization and source verification before returning bytes.

| Layer | Responsibility |
| --- | --- |
| Chrome viewer | Package local CAD/document processing; pass exact live context to the configured hosted service; keep credentials out of extension storage |
| Browser adapter | Enforce workspace, revision, edition, source hash and connection guards; render supplied schema labels |
| OAuth runtime | Discover endpoints, perform PKCE, retain tokens on the server, verify identity through an injected trusted binding, expire or disconnect sessions |
| MCP provider | Isolated client for each operation, current user's token per HTTP request, approved read tools, bounded pagination, sanitized errors |
| Arena mappings | Use actual discovered input schemas; normalize BOM, schema, revision, document and supplier responses |
| Content service | Reauthorize exact item-file relationship; verify original/derivative hashes and MIME before returning same-origin content |
| Arena | Enforce the authorized user's workspace and object permissions |

No language model is needed in the normal file/BOM retrieval path. Model conversion and document rendering are separate from MCP transport.

## Configure the server

Use Node.js 22 or later. `npm ci` installs the pinned dependencies. `npm run dev` serves the app and the BFF together during local development. Without configuration, `/api/viewer/v1/status` and `/api/viewer/v1/auth/status` report their unavailable state explicitly.

Copy `server/provider.example.mjs` into a private deployment location and complete its configuration with verified Arena data. Update its imports to point to the deployed viewer's `server/mcp-provider.mjs` and `server/oauth/index.mjs`; the example's relative imports assume it resides in the server directory. Point `ARENA_PROVIDER_MODULE` at the absolute path of your private module. Keep the completed module and secrets outside the source ZIP/repository; never use a `VITE_` prefix for credentials. The module exports `createProvider()`.

For an independently hosted BFF, run `node server/index.mjs`. It binds to `127.0.0.1:4100` by default. Mount `/api/viewer/v1/*` behind the viewer's same-origin HTTPS reverse proxy, with auth callbacks reaching this service. The currently published Site is static; it serves Preview and the source handoff, not this Node runtime.

| Required deployment input | Why it is needed |
| --- | --- |
| Verified environment-specific MCP endpoint | Choose sand26 deliberately; do not turn an audience identifier into a guessed production route |
| Registered client or usable CIMD document | Establish the application's own OAuth identity |
| Exact HTTPS callback URI | Must match registration and the app's server route |
| Approved discovery/authorization origins | Bound server-side metadata/token requests to reviewed destinations |
| Trusted identity resolver | Establish actual Arena subject and workspace from verified identity data; do not guess JWT claim names |
| Server session store and secret keys | Retain and refresh grants without putting tokens in browser storage; production persistence is a deployment concern |
| Actual discovered read-tool allowlist | No wildcard tools and no assumed coverage of every REST operation |
| Verified response normalizers | Map vendor payloads into `src/domain.ts`, including custom attribute GUIDs/types/labels |
| File-content and conversion binding | Retrieve the exact attachment; optionally supply verified CAD display derivatives |

The checked-in example stays unconfigured until the necessary values and functions are supplied. A configured OAuth service can be available before the BOM/file normalizers are complete; the UI keeps sign-in availability separate from data-provider readiness.

Before live testing, run `npm run preflight:arena -- --provider /absolute/private/provider.mjs` on the server. Version 0.6 reports required mappings, exact file-delivery presence, OAuth setup, explicit keys and declared production-store guarantees. It invokes no provider operation. A `configuration-complete` report still leaves actual Arena and installed-Chrome acceptance untested. See [configuration preflight](arena-preflight.md) for JSON output, exit codes and the trusted-module import boundary.

## OAuth behavior

The runtime follows the configured MCP endpoint's unauthenticated `WWW-Authenticate` challenge to its protected-resource metadata. It obtains the resource identifier and authorization server from that response, then obtains authorization and token endpoints from server metadata. It does not derive a resource identifier from the hostname, assume a callback port from a CLI example, or hardcode an OAuth hostname from the notes.

Sign-in uses Authorization Code with PKCE S256, an unpredictable state value, and an exact redirect URI. The discovered `resource` is included in the authorization and token requests. The callback validates and consumes the pending transaction before creating the viewer session. The browser receives a session cookie; OAuth access and refresh tokens stay in the server store.

Two client modes are supported by configuration: a manually registered confidential client with a supported client-authentication method, and a CIMD public client whose client ID is a public HTTPS metadata URL. The supplied notes report a historical sand26 outbound-network limitation that could prevent fetching a new CIMD URL. Its current status was not verified. Use a manually registered client when that limitation applies; do not claim that a known assistant client's successful login proves custom CIMD onboarding works.

`resolveIdentity(tokens, discovery, { signal })` is trusted deployment code. It must validate identity using the actual Arena-issued identity contract or an authorized identity/profile operation. Decoding a JWT without signature/issuer/audience verification is not sufficient. The implementation does not invent user/workspace claim names. The result must bind the viewer user, Arena user and selected workspace. Refresh may renew the same grant but cannot silently switch user or workspace.

The runtime exposes explicit login, status, callback and logout routes. It does not automatically navigate users into sign-in from a status probe. Logout requires a same-origin POST and ends the viewer connection. It does not claim to sign the user out of Arena everywhere or revoke every independently issued Arena grant.

Use a production-capable server store and stable secret keys for a real deployment. The injected store must implement the following asynchronous interface:

| Store member | Required behavior |
| --- | --- |
| `get(key)` | Read an unexpired value or return no value |
| `set(key, value, expiresAt)` | Persist the value with an absolute expiry in milliseconds; values contain tokens and require encryption |
| `delete(key)` | Remove the value, including an already absent value |
| `consume(key)` | Atomically read and remove a pending transaction so a callback cannot be replayed |
| `withLock(key, asyncOperation)` | Serialize refresh and logout for that session across all deployment replicas |

Production requires `productionReady`, `encrypted` and `shared` to be explicitly `true`, plus a stable `cookieKey` containing at least 32 secret bytes. These flags declare the deployment's store guarantees; they do not implement encryption or distributed locking. The separate MCP provider `connectionKey` should also remain stable across replicas. Keep both keys in server secret management.

The included `createDevelopmentMemoryStore()` is accepted only with `development: true`. It loses sessions on restart and is unsuitable for a production or multi-replica deployment. HTTPS is still required for OAuth callbacks and secure cookies. The deployment owns storage encryption, key rotation, expiration and atomic/replay guarantees.

## Read operations and tool mappings

`createArenaMcpProvider()` requires `endpoint`, `resolveSession`, explicit `approvedReadTools`, and bindings for `getSchema`, `resolveBom`, `listRevisions`, `listAttachments`, and `readContent`. File retrieval is required for a configured viewer; metadata-only mappings cannot report ready. `listSupplierItems` remains optional. It has no write binding and exposes no browser endpoint for arbitrary MCP invocation. Upstream HTTP 429 is preserved as a sanitized `RATE_LIMITED` response without automatic retries or forwarding the upstream body.

A binding receives `(readApi, query, publicContext)`. The context contains the user/workspace and an opaque connection guard, with no bearer token or session secret. `readApi` provides approved `callTool`, `listTools`, explicitly authorized `readResource`, result unwrapping with `data`, bounded business pagination with `collectPages`, protected `contentUrl`, and a cancellation signal.

Discover the actual tool catalog after successful authentication. Review the real tool names, input schemas and operations before adding the read allowlist. The server's generated OpenAPI surface can be constrained by Arena's own allowlist. Tool annotations alone do not grant permission. Interactive input requests, unexpected tool-directed HTTP header annotations, unknown tools and unapproved resource URIs fail closed. The app does not send `X-PLATFORM-AUTH`; that belongs to Arena MCP's internal REST integration according to the supplied notes.

Catalog pagination and paginated BOM/file responses are separate. The implementation detects repeated cursors, respects limits, and rejects an incomplete result rather than returning a partial assembly as complete.

## Exact source and protected bytes

A live URL can carry `mode=arena`, `workspaceId`, `itemId`, `revision`, `fileId`, `edition`, `sourceHash`, `configurationId`, `baselineRevision` and `baselineConfigurationId`. When opening a child in a parent assembly, supply `parentItemId` and the explicit `parentRevision`; `revision` still identifies the requested child file. `baselineRevision` selects the root assembly's baseline. The UI does not infer which released/latest revision was intended.

Each document retains its file GUID, item revision, edition, format and source SHA-256. A `modelSources` entry retains the actual CAD file GUID and the occurrence IDs it represents. Original STEP bytes can now be processed locally without `meshUrl`, CAD properties, or server `sourceConversion`. A verified mesh remains an optional explicitly selected derivative (`displaySource: 'mesh'`). Each derivative and original STEP must refer to the same source identity. Quantity alone is not placement information.

When one root STEP supplies multiple logical child parts, raw import requires exact, nonoverlapping `cadNodePath` selectors and explicit `sourceToPart` rigid transforms. Imported assembly vertices already contain their STEP placement; normalize those vertices into part-local coordinates before applying the BOM occurrence pose. See [source-frame details](arena-integration.md#raw-step-and-optional-derivatives). Nested BOM poses may be supplied as world coordinates (the default), or explicitly declared `placementSpace: "parent"` with each occurrence's `parentId`. The shared normalizer composes the latter into world poses once, including unloaded containers. Mixed/unknown frames, unresolved ancestors and invalid hierarchies are rejected. Neither part names nor quantities establish placement.

Only same-origin protected URLs reach the browser. Every URL includes the workspace and an opaque `connectionId` guard; that guard is not a credential. The server still requires the authenticated session on every request. A changed user/workspace/grant invalidates previous URLs. Successful responses include the matching connection header. Metadata and file responses use `Cache-Control: no-store`.

Hashes are canonical lowercase 64-character SHA-256 digests. Original bytes are checked against `sourceHash`; a mesh retains the original source hash and has its own required `contentHash`. MIME/format and exact returned identity are checked before delivery. The default maximum file is 32 MiB; adjust content and MCP response limits together for the chosen deployment and base64 overhead. This implementation buffers a bounded file for verification before returning it; large-assembly streaming is a separate performance task.

Private file bytes are not written to local review storage. The browser still receives display data in memory, so this avoids routine Downloads-folder copies without promising that displayed content cannot be captured. On 401, 403, connection mismatch or disconnect, the app clears source panes; background/focus session checks also detect invalid connections. In-flight work is cancelled and a previous user's results cannot populate the next session.

## Notes, review data and capability limits

Read-only MCP can retrieve source records and attachments. It cannot write the proposed hidden `viewer data` JSON field. Live notes, imports/exports and saved views remain unavailable until an authenticated shared review store is connected. Preview retains all its local review functionality. A future review store must record server-verified commenter identity, recheck source access and preserve exact revision/anchor identity.

Retrieval support does not implement CAD conversion, OCR, legacy `.doc` conversion, or exact B-rep measurement automatically. Those continue to require their own verified processors/services. Supplier retrieval has a normalized server/adapter contract; a dedicated supplier browsing workflow is not added to the main viewer UI in this update.

## Remaining Arena acceptance work

Complete an app login with an eligible workspace and verify the token resource, callback and identity binding. Retrieve the real tool catalog, implement/validate normalizers against representative items/BOMs, and test attachment bytes, supplier associations and denied sources with at least two users. Verify large files, custom attributes, repeated occurrences, configuration pinning, refresh/expiry, workspace switching and conversion fidelity. Confirm the actual Chrome launch action against Arena's supported route.

Useful protocol references: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/). Arena-specific behavior above comes from the supplied connection notes and the explicitly identified unauthenticated observations; it is not a claim of completed production validation.
