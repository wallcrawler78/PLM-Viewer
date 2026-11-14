# Arena integration boundary

The running app defaults to **Preview**. It reads generated fixtures, never requests an Arena session, and stores review notes only in this browser. The two workspace presets demonstrate different schema IDs, names, types, scopes, and visible columns. They are synthetic configurations, not representations of an actual Arena account.

## What is implemented

| Boundary | Code | Behavior |
|---|---|---|
| Normalized data contract | `src/domain.ts` | Item editions, occurrence IDs, transformations, source identity, dynamic attributes, exact document editions |
| Preview provider | `src/data/previewAdapter.ts` | Same asynchronous interface as live provider; frozen A/B configurations; raw fixture STEP import by default |
| Browser live provider | `src/integrations/arenaAdapter.ts` | Same-origin HTTP BFF, timeout/cancellation, authorization errors, validation, identity checks, fail-closed setup |
| Server boundary | `server/index.mjs`, `server/mcp-provider.mjs` | Read-only MCP service with user-bound authorization, bounded discovery, reviewed tool allowlist, safe errors, and no-store responses |
| Live workspace | `src/integrations/liveWorkspace.ts` | Actual provider loading, revision selection, baseline comparison, and source/session isolation |
| Protected files | `server/content.mjs`, `src/integrations/protectedContent.ts` | Exact source identity, original/derivative SHA-256 verification, same-origin delivery, and session invalidation |
| OAuth runtime | `server/oauth/` | Discovery, PKCE, server-side sessions and disconnect; deployment identity verification and store are injected |
| Chrome viewer package | `extension/`, `scripts/build-extension.mjs` | Complete MV3 local viewer, optional exact-context Arena link bridge, and configured hosted live destination |
| Preview review persistence | `src/data/reviewStore.ts` | Versioned JSON, source-bound anchors, validation, workspace isolation, stale-editor detection, import/export, and explicit guarded recovery of corrupt stored data |

The integration code is implemented; vendor-specific configuration is deliberately unset. The user-supplied sand26 endpoint was verified for unauthenticated discovery, while real sign-in, tool catalog and data mappings remain unverified. See [Arena MCP setup](arena-mcp-setup.md) for the current connection contract and [MCP readiness verification](mcp-readiness-qa.md) for evidence.

## BFF contract

The browser calls these **viewer-owned endpoints**, not Arena REST endpoints:

| Method | Path | Query | Result |
|---|---|---|---|
| GET | `/api/viewer/v1/status` | `workspaceId` | `ViewerServiceStatus`; configured false until the provider is ready |
| GET | `/api/viewer/v1/schema` | `workspaceId` | `WorkspaceSchema` with unique opaque attribute IDs |
| GET | `/api/viewer/v1/revisions` | `workspaceId,itemId` | `RevisionDescriptor[]` |
| GET | `/api/viewer/v1/bom` | `workspaceId,itemId,revision,configurationId?` | `BomSnapshot` with resolved exact child revisions and placements |
| GET | `/api/viewer/v1/attachments` | `workspaceId,itemId,revision` | `Attachment[]` for that item's exact revision/editions |
| GET | `/api/viewer/v1/supplier-items` | `workspaceId,itemId,revision` | Optional normalized supplier items and attributes |
| GET | `/api/viewer/v1/content` | Exact source identity, connection guard, optional derivative hash | Authorized original bytes or verified display mesh |
| GET | `/api/viewer/v1/auth/status` | None | OAuth configuration and current session state |
| GET | `/api/viewer/v1/auth/login` | Safe relative `returnTo` | Explicit OAuth sign-in redirect |
| GET | `/api/viewer/v1/auth/callback` | OAuth response | Validate state, exchange code and establish session |
| POST | `/api/viewer/v1/auth/logout` | None | End this viewer connection |

Run `npm run dev` for the app and its in-process development BFF, or `node server/index.mjs` for the standalone service on `127.0.0.1:4100`. Put the standalone service behind the app's same-origin reverse proxy for deployment. The hosted preview is static and does not deploy this Node service.

Complete the trusted configuration example exporting `createProvider()` and use `createArenaMcpProvider()` with the actual discovered read tools and normalizers. Point `ARENA_PROVIDER_MODULE` at its absolute local path in the server environment. Required methods are `authorize(request)`, `getSchema(context)`, `resolveBom(context,query)`, `listRevisions(context,query)`, and `listAttachments(context,query)`. `authorize` must return the authenticated human identity and the workspace they can access. Every method must enforce their actual Arena access. Setting a flag or providing a broad machine account is insufficient.

The bundled MCP provider also requires the `readContent` binding before reporting configured. Version 0.6 exposes configuration-only reports from MCP/OAuth constructors and a server [preflight command](arena-preflight.md). It never certifies Arena mappings, user permissions or installed Chrome; those remain acceptance tests. No new public preflight endpoint or arbitrary tool invocation is exposed.

## Mapping each Arena workspace

Fetch the workspace's attribute definitions and values through its supported API. Map attributes by immutable GUID, retain the API label as display data, preserve type and item-versus-BOM-line scope, and supply units/options where known. UI columns and the properties panel consume `WorkspaceSchema`; the UI must not guess that two labels mean the same attribute. Missing values display as an em dash.

The preview's mass value is explicitly **estimated** using synthetic material density. A real implementation should label the authority of an engineering property and read it from the source where supplied, rather than inventing density or inferring material from GLB color.

Arena's public overview documents BOM lines, revisions, where-used relationships, item/file associations and file editions. Its changelog documents additional BOM attributes and item application/API URLs. Use the selected region's current Swagger for exact fields, endpoints, pagination and error semantics before writing a tenant mapping. Start here:

- [Arena API overview](https://ptc-arena.github.io/arena-dev-help/get-started/overview/)
- [API reference and regional Swagger](https://ptc-arena.github.io/arena-dev-help/reference/api_docs/)
- [Authentication](https://ptc-arena.github.io/arena-dev-help/get-started/auth/)
- [Connection and permissions](https://ptc-arena.github.io/arena-dev-help/get-started/connecting/)
- [API changelog](https://ptc-arena.github.io/arena-dev-help/changelog/)

## Assembly coordinates and source identity

A BOM quantity is not an assembly placement. The provider needs an assembly manifest exported from CAD, a top-level STEP hierarchy, or explicitly maintained transforms. A component instance is identified by its occurrence path/ID, separate from its item GUID. Repeated fasteners share a part edition but have different placements. Never center individual parts to make them look aligned, and never infer matching placement from part number alone.

Normalize models into millimeters, Z up, right-handed coordinates before returning them to this prototype. `position` is in millimeters and XYZ Euler `rotation` is in radians. The optional snapshot field `placementSpace` defines the occurrence coordinate contract:

| Value | Provider supplies | Viewer behavior |
| --- | --- | --- |
| Omitted or `"world"` | World poses for every occurrence | Preserve poses, even when `parentId` exists. Parent IDs alone never imply relative coordinates. |
| `"parent"` | Every occurrence's pose relative to its `parentId`; roots are in world coordinates | Compose parent rotation/translation before child placement, including unloaded containers; return a normalized snapshot marked `"world"` so the transform is applied once. |

The dependency-free shared normalizer runs at the server and browser data boundaries. It retains occurrence IDs/parent IDs, source identities and part-local anchors. It rejects unknown frames, missing parents, cycles, duplicate IDs, nonfinite placements, unresolved ancestor placements and arithmetic overflow. Metadata guards allow at most 50,000 occurrences and 256 hierarchy levels; these are validation bounds, not a measured rendering-capacity promise. Geometry source normalization (`sourceToPart`) remains a separate explicit step. Vendor units, coordinate axes, CAD-to-item mappings and source placement must still be verified; this function cannot infer them from BOM quantity or names.

Freeze `snapshotId`/`configurationId`, item revision, source file edition and SHA-256. Fetch documents for each **resolved child item revision**, not the current/latest attachment. Warn on obsolete/unavailable sources instead of substituting. Model loading state, visibility and transparency are review state and never imply a BOM removal.

A file GUID is not an edition identifier. The normalized `Attachment.id` keeps the provider's file GUID; `attachmentIdentityKey()` combines it with item ID, item revision, file edition, source hash, and format. Keep distinct editions when they share that GUID. Delivery URLs are excluded from identity because an authorized URL can rotate without changing the file. The adapter validates attachment identity, format, name, URL, and optional family metadata before the UI consumes a response. An explicitly requested frozen configuration must also match the returned `configurationId`.

New saved views retain `documentSource` and `documentBaselineSource` references containing `fileId`, `itemId`, `revision`, `edition`, `sourceHash`, and `kind`. Restoration resolves both sources before applying layout or selection changes. It rejects missing/changed sources and a baseline that belongs to another item, uses another format, or is the same exact source. An explicit empty baseline stays empty. Legacy ID-only views can open only one unambiguous available edition and display a notice to save again; they cannot prove the original historical hash. Page/search/zoom and completed measurement graphics are session state, not persisted view fields. A completed measurement is restored when returning from Documents to the same model session, while a model source/configuration change or saved-view restoration clears it.

### Raw STEP and optional derivatives

`PartDefinition.stepUrl` identifies the exact original STEP. The default display source is now raw STEP, parsed by the packaged local CAD worker. `meshUrl`, `bbox`, and `volumeMm3` are optional. The absence of a server conversion capability must not prevent original-source rendering. If a verified derivative is deliberately selected, set `displaySource: 'mesh'` and provide its protected URL/content hash. A failed raw STEP import never silently falls back to the derivative.

The worker checks the actual source hash, imports units into millimeters, and preserves the source coordinates. The provider remains responsible for a consistent Z-up/right-handed frame and world-composed occurrence poses. Sources exported with unrelated origins are not automatically aligned. Material values come from declared metadata; display colors are not engineering material properties.

When multiple logical parts share one original assembly STEP, provide `cadNodePath` for each selected hierarchy subtree. Paths contain child indices from the importer root, not component names; repeated components can share names. Overlapping selectors are rejected to avoid rendering the same child twice. The exact source hash binds the selector to that file edition.

OCCT's imported assembly vertices already include their source placement. A raw subtree mapping therefore requires an explicit rigid `sourceToPart` transform (`position` in millimeters and XYZ Euler `rotation` in radians) from imported source coordinates into part-local coordinates. Declare identity explicitly when appropriate. The worker applies this normalization before the renderer applies the BOM occurrence's world pose. Do not copy a nonzero BOM pose onto already-placed assembly geometry without normalizing it. A missing transform fails validation rather than guessing. Existing independent part files need no subtree selector and keep their ordinary part-local geometry.

Model selection maps to an occurrence and tessellated surface point. Exact face/edge distance needs a future retained B-rep implementation; an outside processing service is not inherently required. Supplied CAD boxes retain CAD provenance; otherwise bounds are computed from imported display geometry and labeled as mesh envelopes. Neither is a minimum-volume oriented bounding box.

## Review data and a possible Arena custom attribute

The domain contract separates `ReviewStore` from PLM reads. The local store has a schema version, a monotonically increasing revision, source-bound comments, document/model anchors, saved view state, workspace checks, bounded payloads, and explicit corrupt/quota/stale-write errors. It detects sequential stale edits; it is not a transactional multi-user server and does not guarantee atomic compare-and-swap between browser tabs.

Corrupt local data is never automatically reset. `captureRecovery()` retains the invalid stored payload for an optional **Download original stored data** action. A user-selected **Import & replace** backup goes through `recoverFromBackup()`: the backup must be valid and belong to the workspace, and the current stored bytes must still equal those captured at the recovery warning. A successful recovery starts a new local revision sequence at 1. Invalid backups, intervening writes, or quota failures preserve the original payload. This is an explicit local replacement operation, not a server transaction or an Arena field write.

An Arena text attribute could be one future persistence provider only after verifying the field's capacity, visibility, revision lifecycle and write rights. A hidden UI field is not an authorization boundary. Do not append comments to released snapshots through an assumed writable field. Prefer a backend review store or supported file/markup workflow when comments need an independent lifecycle. If a whole JSON document is stored in Arena, serialize writes per object on the server and use conditional writes only when the actual API supports them. A JSON version number by itself does not make a write atomic.

Record commenter identity and timestamps at the authenticated server. Do not trust browser-supplied author fields in live mode. Model anchors use occurrence-local coordinates plus source identity; document anchors retain edition, page or quoted text. Do not silently migrate a pin to a newer revision. Saved view reloading must recheck access to every source.

## Chrome viewer and Arena launch

1. Run `npm ci` and `npm run build:extension`, or extract the supplied extension ZIP.
2. Open `chrome://extensions`, enable Developer mode, and **Load unpacked** from `build/extension/` or the extracted package. The source `extension/` directory is not an installable build.
3. The toolbar opens the packaged viewer. Options includes local PDF, DOCX, comparison, STEP and combined-view examples. **Open local test files** accepts actual user-selected files without uploading them.
4. For the current live path, configure the **Hosted Arena viewer URL** and **Arena workspace ID**. Use the context menu or **Open an exact Arena source**. The separate hosted service owns user authentication and protected retrieval.
5. Live requests carry exact item/source context to `?mode=arena&workspaceId=...&itemId=...&revision=...&fileId=...`. Missing configuration and denied access stay explicit errors. A live ID is never resolved through the Preview provider.

See [Chrome build/install instructions](chrome-extension.md) for full settings and qualification steps. A direct extension MCP client is a later option only after Arena's public-client OAuth, redirect, and file-delivery contract is verified. The bundled extension currently grants no remote MCP network access and contains no client secret or user token.

### Preview attachment links

`src/launch-context.ts` validates launch parameters and resolves the selected file before choosing a workspace layout. An exact document opens **Documents**; an exact STEP source opens **3D**; `view=together` requests the model and its related document. An untargeted preview starts with the revision B specification. Unknown IDs, item/revision mismatches, conflicting editions, and ambiguous document requests produce an unavailable-source state instead of substituting another attachment. `revision` refers to the selected item's revision: an unchanged child revision A can belong to the proposed assembly B configuration.

Append these query strings to the configured viewer URL:

| Example | Query |
|---|---|
| PDF specification | `?mode=preview&itemId=assembly&revision=B&fileId=atlas-spec-B-pdf` |
| Word specification | `?mode=preview&itemId=assembly&revision=B&fileId=atlas-spec-B-docx` |
| Automatic PDF revision review | `?mode=preview&fileId=atlas-spec-B-pdf&compare=true` |
| Assembly STEP | `?mode=preview&fileId=step%3Aassembly%3AB` |
| Base model and drawing | `?mode=preview&fileId=step%3Abase%3AB&view=together` |

`step:<encoded item ID>:<encoded revision>` is a synthetic Preview identity, exported by `previewModelFileId`; it is not an Arena file GUID. A live provider must retain actual attachment IDs, editions, hashes, and resolved configuration context. When both supplied frozen configurations contain the same unchanged source, Preview uses configuration B as its assembly context. This rule is specific to the synthetic A/B dataset and is not a generic “latest revision” policy.

The normalized optional `Attachment.seriesId` carries a provider-supplied document family identity so revisions can be paired without guessing from filenames. Preview supplies explicit family IDs separately for the specification PDF, specification DOCX, base drawing, and gearbox inspection. A live adapter must map this identity from verified source relationships; the UI must request an explicit comparison choice when there is no safe pairing. The value is validated in both BOM and attachment-list responses.

The launcher clears all old source context—including file edition/hash, parent revision, current/baseline configuration, and connection guards—from a saved viewer URL before adding the new item context. It rejects recognized credential query parameters instead of storing them. This prevents a previous document launch from accidentally carrying into a later item launch.

Both launch parsers reject duplicate or malformed source parameters. The older exported Arena parser also retains and validates `parentItemId`; it rejects oversized context rather than silently dropping a requested file or revision. The same-origin BFF path check rejects URL forms that browsers could normalize into an external origin.

The optional attachment bridge handles explicit STEP/STP/PDF/DOCX links with unambiguous workspace/item/revision/file/edition/hash context on the four declared Arena origins. Automatic opening is off by default. Opaque or incomplete links retain normal behavior; a recognized launch failure offers an explicit continuation action instead of silently downloading. This contract has synthetic tests, but actual Arena tenant routes remain unverified. The extension does not request access to all websites, cookies, download interception, or credential storage. The current live file path remains the authorized BFF, while rendering and comparison happen in the browser.

## Before enabling a real workspace

Use representative SolidWorks/Onshape/Creo exports to verify units, origins, hierarchy selectors, source-to-part transforms, exact child editions and repeated instances; test API pagination and permission failures; verify original file delivery and local import on representative files; validate browser DOCX fidelity and explicit scanned-PDF limitations; choose a transactional review store; confirm any custom field behavior; and test the actual Arena launch route. These are integration acceptance criteria, not capabilities established by Preview alone.

See the [Regression audit](regression-audit.md) for the latest audit record and the [Test guide](test-guide.md) for repeatable acceptance workflows. Neither substitutes for verification against an authenticated Arena workspace.
