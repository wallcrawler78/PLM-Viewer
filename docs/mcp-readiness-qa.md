# Arena MCP readiness verification

Development session: November 12, 2026 (Pacific). This is an integration-readiness check, not a claim that production Arena sign-in, permissions or tool mappings have been validated.

## Scope

Implemented a real MCP transport path using the installed SDK, user-bound server authorization, protected exact-source content delivery, an actual live workspace loader, OAuth runtime/controls, and safe Chrome launch context. Preview remains the default and keeps all its document, model and local review tools.

## Automated coverage

The project suite includes existing geometry/document/review regressions and new checks for the following behavior:

| Area | Verification |
| --- | --- |
| Per-user isolation | Concurrent principals keep separate tokens, tool catalogs and protected URLs; mismatched session/workspace guards fail |
| MCP protocol | Actual installed SDK/HTTP transport against synthetic wire responses, modern/legacy negotiation, discovery, output schema checks, per-request token resolution |
| Read-only tools | Explicit reviewed allowlist, unknown/write tools refused, interactive input requests not fulfilled, unreviewed header mirroring excluded |
| Pagination | Opaque/empty cursors accepted; loops, incomplete responses and configured limits rejected |
| Source metadata | Exact workspace/item/revision/configuration/file edition/hash; no remote delivery URLs, duplicate source identities or wrong BOM association |
| File delivery | Source/derivative hash, identity, MIME and size verified before delivery; another connection cannot reuse the URL |
| Errors | 401/403/409 cleared safely; structured feature_not_enabled distinguished; upstream bodies and tokens not shown |
| Live bootstrap | No guessed revision/baseline, no Preview fallback, real revision labels, simultaneous-user separation, cancellation |
| OAuth | Discovery, resource binding, PKCE/state/replay behavior, server-only token handling, refresh identity, cookie/redirect/origin boundaries and store contract |
| Browser auth client | Safe local login/logout routes and return context; disconnect clears source state; normal Preview makes no auth requests |
| Chrome launch | Old context and connection guards removed; source parameters validated; credential-shaped viewer URLs rejected |

Final combined verification: `npm run check` passed TypeScript and **253 tests across 23 test files**. This includes **27 OAuth tests** and **10 actual-SDK wire tests**. No live Arena credentials were used. The production build is run by the supported source/package workflow before publishing.

The independent final review found and fixed a callback/logout race. A pending callback now remains cancellable after its authorization code has been consumed. Two regressions prove both orderings: logout before final identity verification prevents session creation; logout with old cookies after a callback commits also removes the newly created session. The full suite above was rerun with this fix included.

## Browser observations

The live-path browser check used a disposable, explicitly labeled synthetic provider loaded through the same BFF. Its temporary provider and local configuration are excluded from the source/deployment. It does not represent an authenticated Arena account.

| Workflow | Observed result |
| --- | --- |
| Preview DOCX comparison after removing QA configuration | Two rendered source documents, linked scrolling, source highlights and 13 text changes remained available |
| Unconfigured deployment | No inactive sign-in button appeared; Open sample workspace explicitly returned to Preview |
| Exact PDF launch with baseline | Current revision 03 and baseline 02 displayed; 19 document text changes rendered; matching source highlights appeared |
| Model overlay and bounds | Both revisions rendered through protected mesh delivery; actual revision labels appeared; assembled bounds 212.0 × 136.0 × 84.0 mm remained available |
| Combined document/model layout | Both primary panes remained present with the same user-bound source context |
| Missing live revision | Accessible revision picker appeared; choosing 03 opened the selected source |
| No baseline | Document/model comparison controls clearly required an explicit baseline |
| Denied protected file | Whole protected workspace was removed and replaced with the access-denied screen |
| Changed connected user | A subsequent file request triggered CONNECTION_CHANGED and cleared the previous workspace |
| Live review writes | Notes, pins and saved views visibly disabled with the shared-storage explanation |
| OAuth configured before data mappings | Connect action appeared only when server auth status was configured; a synthetic connected identity appeared when data mappings were unavailable |
| Disconnect | Clicking Disconnect Arena removed the synthetic connection and displayed the disconnected state with an explicit reconnect action |

Synthetic live document comparison (historical screenshot omitted from this source export)

Synthetic live model overlay (historical screenshot omitted from this source export)

Access denied clears protected source panes (historical screenshot omitted from this source export)

Preview Word comparison after integration changes (historical screenshot omitted from this source export)

Disconnect clears the live connection (historical screenshot omitted from this source export)

The browser used the existing Software3D fallback. These checks do not replace WebGL2 verification on a supported machine, customer CAD conversion testing or real Arena authorization acceptance.

## Actual Arena observations

The exact sand26 endpoint provided in the user's connection notes was requested without credentials. It returned 401 and a WWW-Authenticate resource metadata URL. Following that returned URL produced 200 with the resource identifier, header bearer method and authorization-server origin. A request for the advertised authorization server's standard metadata timed out from this environment. No login, private tool catalog, BOM or customer file was retrieved.

See [Arena MCP setup](arena-mcp-setup.md) for exact observed addresses and the remaining deployment inputs. The current source includes no assumed production MCP endpoint, copied client credentials, guessed tool names or unverified JWT identity claims.

## Deployment boundary

The published Site is static Preview. The source handoff includes the Node BFF and OAuth runtime for deployment behind an authenticated same-origin route. The private provider configuration, production session store, registered app/CIMD document, verified identity binding, tool response normalizers and content/conversion binding remain deployment integration work. Read-only MCP does not provide a shared annotation write store.
