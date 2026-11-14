# Review Studio

A universal browser workspace for PDF, Word, and STEP 3D review. Documents and models have equal primary views, with revision comparison and source-bound findings in the same workspace. Raw STEP import, PDF/DOCX rendering, text redlines, and PDF visual differences run locally without an AI service or remote conversion API.

This repository is a **working Preview prototype with a user-bound Arena MCP integration path**. Preview starts with an original synthetic Atlas Drive Module, two frozen BOM configurations, real generated STEP files, and supporting documents. Preview makes no requests to Arena and does not change PLM records. Explicit Arena launches use the separately configured server connection; missing configuration or denied access never falls back to fixtures.

**Source version: 0.8.0 — Playground prototype.** The private [hosted Preview](https://arena-assembly-review.wallcrawler78.chatgpt.site) now includes Playground. [Open Playground directly](https://arena-assembly-review.wallcrawler78.chatgpt.site/?mode=preview&playground=1) to try visual proposals and Preview ECR packages without installing the Chrome extension. AI and live Arena writes remain unconnected on this static test site.

Source repository: [wallcrawler78/PLM-Viewer](https://github.com/wallcrawler78/PLM-Viewer). This checkout supports local development and agent-led Chrome extension qualification. Start with [the agent handoff](docs/agent-handoff.md) for build, installation, and test instructions. It originates from source commit `7c3278877b3a2a35bd52f1b0e9fc77ea2db13408`; the existing hosted Preview is maintained separately.

## Playground in 0.8

Choose **Playground** next to Documents, 3D and Together. It opens the placed components of the current resolved BOM in a separate visual proposal. Select an occurrence, move or rotate it, add a box, cylinder or bracket concept, edit the bracket's hole dimensions, and compare **Original**, **Proposed** and **Overlay**. Undo/Redo records proposed changes; explosion, hiding, opacity, camera and presentation labels remain display controls. Source STEP files and Arena items are not edited.

Draw arrows, rectangles, ellipses, freehand marks, text labels and pins on the model or a PDF page. The camera stays held while drawing. Source-local anchors follow rigid component movement when the geometry still matches; view-only marks retain their camera and scene context. A hole change invalidates an old geometry anchor instead of silently moving its meaning. **Capture intent** preserves the image, original markup text, exact source and proposal version even if you later edit or delete that markup. PDF marks retain the exact file revision, edition, hash and page. Word remains readable and searchable; Playground drawing overlays currently apply to PDFs.

The assistant connection is optional. Local manual tools and the Preview ECR flow work without an AI account. An authorized local development gateway can send typed or dictated instructions, selected scene data and an explicitly attached view to a configured model, then return a bounded suggestion for review. The installed Chrome package intentionally has **no AI transport** under its current connection policy. It contains no provider key. See [AI and Arena boundaries](docs/playground-ai.md) for configuration and the remaining extension transport work.

### Create an ECR: the current six-step flow

| Step | Current behavior |
| --- | --- |
| 1. Create ECR | Open the Playground ECR dialog. |
| 2. Describe the proposal | Enter a title and change description; fields remain intact if preparation fails. |
| 3. Review affected items | Source items currently in view start selected, deduplicated by item and revision. Other source items and the parent assembly can be included explicitly. Unnumbered concepts stay in the report. |
| 4. Include design evidence | Capture the proposed configuration and include up to two saved model/PDF intent images with their original markup snapshots. |
| 5. Prepare the description attachment | Generate a local Word `.docx` containing the description, affected items, accepted changes, assumptions and embedded images, plus a structured manifest and ZIP review package. |
| 6. Show the creation result | Display an explicit **Preview ECR** receipt and download choices. No Arena record is created today. The Arena-link area will show an actual URL only after a future write binding creates and verifies a real ECR. |

Preview proposal drafts save locally to the browser origin; live Arena proposals remain session drafts. Captured images and simulated receipts are session data, so use **Download review package** when you want to retain that evidence. Export/import of proposal JSON preserves scene intent and exact source binding without copying the original STEP/PDF/DOCX attachments.

**Verification:** `npm run check` passed for 0.8.0 with **704 tests in 59 test files**, including TypeScript. `npm run build:extension` also passed for the 0.8.0 package. Browser interaction/layout and installed-Chrome qualification remain **pending manual gates**: automatic approval review blocked the attempted browser validation. No authenticated live AI call or live Arena ECR creation has been tested. Existing historical browser results apply to their recorded release, not to Playground.

Use [the Playground test guide](docs/playground-testing.md) for a concrete local/Chrome walkthrough and [the implementation plan](docs/playground-plan.md) for delivered versus remaining phases.

## Run locally

Use Node.js 22 or later and npm. Start from a repository checkout or an extracted source archive, then run:

```bash
npm ci
npm run dev
```

Open the local address printed by Vite. Chrome with WebGL2 enabled provides the accelerated rendering path. When WebGL2 is unavailable, the app automatically uses its CPU renderer and displays a **Software 3D** badge. Python, Arena credentials, and a desktop CAD application are not required to run the supplied preview.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the application with development updates |
| `npm run check` | Check TypeScript and run the automated tests |
| `npm run preflight:arena -- --provider /absolute/private/provider.mjs` | Inspect local Arena deployment configuration without calling provider operations; see [preflight](docs/arena-preflight.md) |
| `npm test` | Run the automated tests |
| `npm run build` | Check TypeScript, create the static application, and package the portable source ZIP in `dist/developer/arena-review-source.zip` |
| `npm run build:extension` | Build the complete local Chrome viewer in `build/extension/` and its ZIP in `dist/developer/` |
| `npm run prepare:assets` | Verify pinned dependencies and prepare the packaged CAD/PDF runtime assets; runs before dev/build |
| `npm run preview` | Serve an existing production build locally |
| `npm run fixtures` | Regenerate the optional CAD and document fixtures with Python |

The fixture files are already included. Their generator requires the Python packages listed in [Fixture provenance](docs/fixture-provenance.md). Regeneration changes source hashes when file bytes change; preserve those updated identities with the assets.

The build bundles the fonts, PDF character maps/standard fonts/WASM, and the pinned OpenCascade STEP engine locally. It does not request a runtime CDN. CAD asset preparation verifies the upstream loader hash and replaces its generated-function wrappers with ordinary closures for the extension's strict executable policy. The transform, pinned version, and notices are recorded in `scripts/prepare-cad-runtime.mjs` and the generated vendor assets. `npm run build` also runs `scripts/package-source.mjs`; the source archive excludes dependencies, generated vendor assets, build output, Git internals, Site identity, and local environment files. To regenerate only that archive from an installed checkout, run `node scripts/package-source.mjs`.

## Test your own files or the Chrome package

Select the folder icon **Open local test files** in the header, then **Open files**. STEP/STP, PDF, and DOCX sources are accepted, up to eight files, 32 MiB per file and 128 MiB per session. Files are hashed and read through session object URLs; they are not uploaded or retained as source files in browser storage. Closing the local workspace releases those URLs and stops pending CAD work.

Use **Documents**, **3D**, or **Together**. Document baselines are chosen explicitly from other open files of the same format. Select a second STEP as the model baseline to use overlay or side-by-side comparison. Models preserve source coordinates, so comparison assumes a common frame; the viewer does not guess an alignment or an Arena BOM association. Local file notes are unavailable because these files have no verified PLM identity. The sample workspace retains its existing Preview review tools.

For a standalone Chrome test, build with `npm run build:extension`, open `chrome://extensions`, enable Developer mode, and **Load unpacked** from `build/extension/` or the extracted extension ZIP. Do not load the source `extension/` directory. The toolbar opens the fully bundled viewer. See [Chrome installation and qualification](docs/chrome-extension.md), [implementation plan](docs/standalone-viewer-plan.md), and [runtime QA record](docs/standalone-runtime-qa.md).

Version **0.7.0** introduced the earlier performance and preference work: it moves text redlines into a packaged local worker, settles PDF pane resizing, avoids redundant model updates and adds browser-local viewing preferences. Standard/Economy 3D quality changes display resolution while preserving geometry and measurements. Document defaults apply to new comparisons without resetting an open review. See the [0.7 plan](docs/release-07-plan.md), [performance review](docs/performance-review.md), [preference roadmap](docs/user-preferences.md), and [0.7 verification](docs/release-07-qa.md).

**Larger STEP performance:** four public 5.55–25.90 MiB files passed repeated local conversion and browser rendering; a 37.67 MiB source was rejected by the existing cap. Dense models are slow in the measured Software 3D fallback. See [measured results](docs/large-step-performance.md), [source manifest](docs/qa-large-step/corpus.json), and [repeatable benchmark instructions](docs/step-benchmark-method.md). These results do not qualify WebGL2 hardware or an installed extension.

**Find in document** searches the available extracted text of a PDF or DOCX locally, across its pages. Search a word or phrase, then use next/previous or Enter/Shift+Enter to navigate matching passages. Ctrl/Cmd+F opens the search when a reader pane has focus. Matching ignores case and normalizes whitespace; counts describe matching passages rather than individual occurrences. Search feedback identifies partial/unavailable extraction. Image-only text needs an OCR rendition; phrases spanning separate extracted blocks are not joined automatically.

The [Arena configuration preflight](docs/arena-preflight.md), bounded PDF page overview, local STEP/PDF/DOCX processing and combined workspace remain available. Previous readiness and cleanup work is recorded in [0.6 verification](docs/release-06-qa.md).

**Local runtime checks**, introduced in 0.4, opens from Workspace settings in a separate tab or from extension Options. Click **Run local checks** to exercise hash-verified original STEP, PDF, and DOCX fixtures through the actual engines, then **Download report** to retain the result. The report distinguishes hosted Preview from a `chrome-extension:` page. A hosted pass does not qualify the installed package. See [runtime check details](docs/runtime-checks.md) and the preceding [0.5 verification](docs/release-05-qa.md).

### Visual PDF differences

In a PDF comparison, choose **Visual changes** next to **Side by side** and **Redline**. Select a baseline page and open-file page, then press Enter or leave the page field to compare. **No page** explicitly represents an added or removed page. **Sensitivity**, **Blend**, and **Highlights** adjust the local pixel review; previous/next moves between coalesced changed regions. **Source pages** returns to the selected original pages, and **Draft review note** creates an editable note on the exact file/page in a review-enabled workspace.

Choose **Page overview → Scan pages** to scan the opened PDFs sequentially. The overview reports compared, unavailable and unscanned pairs, distinguishes page-size changes and extra pages (including blank pages), and opens any pair in the detailed overlay. **Pause scan** keeps completed summaries; **Resume scan** continues with the next unscanned pair. Filters show all pairs, changes, or unavailable results. Summaries survive movement between the overview and overlay in the same comparison session; a source or sensitivity change starts a fresh overview. Closing comparison, opening another file, or entering Together ends that comparison session.

Both PDFs keep one physical scale and align at the top-left. The overview pairs page 1 with page 1, and so on; it does not discover semantic page correspondence after insertions or reordered pages. The detailed overlay allows manual pairing. Each common raster is bounded to two million pixels, with a maximum of 200 listed regions and all detected differences retained in the mask. An overview run stops after 50 pairs, 60 million compared pixels, or two minutes and can resume; each pair has a 45-second ceiling, and each overview covers at most 300 pairs. Larger sources explicitly retain unscanned coverage. A completed scan can still have unavailable pairs and never implies engineering equivalence.

PDF rendering uses an explicitly owned local worker. Reader tasks have deadlines, selectable text is streamed and bounded, and per-page resources are released cooperatively without destroying another active reader. These are application work/raster bounds, not a total PDF.js/browser memory guarantee. DOCX retains its text/side-by-side tools; use a PDF rendition for visual page comparison. No OCR, AI interpretation or source-document rewriting is involved.

### Viewing preferences

Open **Workspace settings → Viewer preferences**, or the **Viewer preferences** gear in a local-file session. Choose the starting comparison view (Side by side or Text redline), linked scrolling, source highlights and Standard/Economy 3D rendering. These defaults are saved only for this browser profile and viewer origin; hosted and extension installations have separate settings. Preferences contain no files or source identities. If browser storage is unavailable, choices remain usable for the session and the settings screen explains the limitation.

Document choices seed a newly opened comparison; the current pair keeps its toolbar choices. Rendering quality applies immediately, including in an open local-file session. **Reset preferences** affects these defaults only, leaving Preview review notes and saved views intact. Source-specific camera/page/revision state and Arena access are not personal preferences. See the [preference design](docs/user-preferences.md) for planned units, navigation and workspace-column controls.

## First review session

1. The preview opens the revision B specification in **Documents**. PDF and Word files are primary content; 3D controls appear when **3D** or **Together** is selected.
2. Choose **Compare revisions**. The viewer pairs the confirmed document family, renders both editions, and highlights extracted-text changes. Use next/previous change to move through the sources. **Redline** shows word-level insertions and deletions in a continuous reading view.
3. Use **Find in document**, page navigation, zoom, or **Fit**. Switch to the DOCX in **Files** to try the same workflow with Word. Word page numbers follow browser reflow.
4. Choose **Draft review note** on a change. It opens an editable draft with the exact source and page/quote; a removal belongs to the baseline file. **Post note** is an explicit separate action.
5. Choose **Together** to review the document alongside the model. Resize the divider with the mouse or arrow keys. **Files** and **Bill of materials** share a collapsible navigator; **Notes** and **Details** open only when needed.
6. In **3D**, select a part through the BOM or model, inspect its attributes, hide/isolate it, change opacity, measure, section, or explode. **Overlay** and **Side by side** retain the model revision tools.
7. **Save view** preserves the workspace mode, the exact open document and comparison-baseline editions/hashes, source context, and model state. Visiting 3D and returning to Documents keeps the current reader session's page, zoom, and search. A completed model measurement also returns with its endpoints and distance after a Documents → 3D round trip in the same session.

Try direct Preview launches by appending one of these queries to the app URL:

| Source | Query |
| --- | --- |
| PDF | `?mode=preview&fileId=atlas-spec-B-pdf` |
| Word | `?mode=preview&fileId=atlas-spec-B-docx` |
| PDF revision comparison | `?mode=preview&fileId=atlas-spec-B-pdf&compare=true` |
| STEP assembly | `?mode=preview&fileId=step%3Aassembly%3AB` |
| Base model and its drawing | `?mode=preview&fileId=step%3Abase%3AB&view=together` |

These demonstrate the launch contract with synthetic sources. Unknown or mismatched exact sources display an error rather than substituting another file. Live provider selection is implemented. Actual Arena attachment-click interception still needs validation against the supported Arena route or action.

The [Test guide](docs/test-guide.md) gives repeatable workflows and expected results. The [Specialist audit](docs/specialist-audit.md) records the latest document, geometry, performance, UI and MCP review. The [MCP readiness verification](docs/mcp-readiness-qa.md) records the preceding integration checks. Earlier viewer audits remain in [Regression audit](docs/regression-audit.md), [Universal viewer quality check](docs/universal-viewer-qa.md), [Verification](docs/verification.md), and the [previous quality check](docs/quality-check.md).

The navigator and inspector collapse on compact displays. On narrow screens, paired document/model and revision panes stack vertically. The reader stays within the workspace instead of putting the entire BOM ahead of the file.

Document-first sessions defer the 3D engine until a model is opened and the Word renderer until a DOCX is opened. PDF page rasters are bounded while the displayed scale and annotation coordinates remain consistent. A model module failure stays inside the model pane, with document review still available.

## What the prototype supports

| Area | Available behavior |
| --- | --- |
| BOM navigation | Search, item selection, repeated component occurrences, configurable BOM table, and model loading from the same resolved configuration |
| Workspace attributes | Two synthetic workspace schemas with different IDs, labels, types, units, default columns, and item/BOM-line scopes |
| Model inspection | Orbit, zoom, pan, standard views, fit, hide/show, isolate, per-selection opacity, assembly explosion, and X/Y/Z section planes |
| Local STEP import | Pinned CAD kernel in a dedicated, cancellable worker; actual source hashing, units, hierarchy selection, bounded import, and local geometry generation |
| Rendering fallback | Automatic CPU projection of the same STEP-derived triangles when WebGL2 is unavailable, with selection, measurement, anchors, sections, and comparison controls preserved |
| Measurement | Approximate point-to-point distance on rendered surfaces; envelopes from supplied CAD bounds or explicitly labeled imported mesh bounds; completed measurements retained across document/model view changes in the current session |
| Revision review | Transparent A/B overlay, side-by-side views with linked cameras, and a resolved BOM/placement change list |
| Primary document viewing | PDF and DOCX readers, searchable extracted text, page navigation, zoom/fit, source details, collapsible file navigation, and equal document/model panes |
| Document comparison | Automatic source-block highlights, aligned word redlines, next/previous change, full redline reading view, linked page/relative scrolling, explicit baseline choice, and editable review drafts |
| Visual PDF comparison | Same-scale page-pair overlay, sequential page overview with explicit coverage, pause/resume and drill-down, explicit absent pages, sensitivity, bounded regions and exact source-page draft notes |
| Runtime qualification | Separate opt-in checks of actual bundled engines/fixtures, version/hash checks, cancellation, graphics detection and a sanitized downloadable report |
| Local file sessions | Open actual STEP/PDF/DOCX files, manually select baselines, use equal document/model panes, and release source URLs on close without uploading files |
| Review findings | Model occurrence/local-point anchors, document page or quoted-text anchors, replies, and resolve/reopen state |
| Saved views | Source configuration, exact document and selected baseline editions/hashes, workspace layout, comparison mode, navigator/inspector visibility, split ratio, camera, and model selection/loading/visibility/opacity/section/explosion |
| Preview persistence | Browser-local comments and views, separate workspaces, validated JSON import/export, explicit storage errors, and deliberate recovery from a valid backup when stored data is corrupt |
| Playground proposals | Separate source baseline and proposed web 3D representation, occurrence-level transforms, parameterized concepts, original/proposed/overlay, bounded history, exact-source draft export/import |
| Playground design intent | Model/PDF drawing tools, geometry/camera-aware anchors, frozen intent captures, source-bound reference documents, and editable text or browser dictation |
| Preview ECR preparation | Description dialog, affected-item selection, actual rendered images, local DOCX report, manifest/ZIP export and an explicit simulated receipt; no live Arena write |
| Optional Playground AI | Server-only provider adapter, explicit image sharing, typed bounded commands, source/version guards, cancellation and user-reviewed application; installed-extension transport remains unavailable |
| Arena MCP integration | Server-only MCP SDK client, OAuth discovery/PKCE runtime, per-user session bridge, protected exact-source file delivery, schema/BOM/revision/attachment/supplier bindings, live launch loading, access-change clearing, and a Chrome launch extension; verified vendor mappings and production configuration remain required |

## Included test assembly

The Atlas Drive Module uses millimeters in a right-handed, Z-up coordinate system. Parts retain local coordinates; each occurrence supplies its assembly transform. The same fastener file is reused at separate placements.

| Component | Configuration A | Configuration B |
| --- | --- | --- |
| Mounting plate | Part A, 120 mm wide | Part B, 136 mm wide |
| Motor | Part A at X = -42 mm | Same part A at X = -38 mm |
| Gearbox housing | Part A | Same part A |
| Output shaft | Part A | Same part A |
| Ventilated cover | Part A, six slots | Part B, nine slots |
| Mounting fasteners | Four occurrences | Three occurrences |
| Position sensor | Absent | Added at X = 65 mm |

The specification changes the maximum installation width from 125 to 140 mm. Its sensor datum discrepancy and the removed fastener are intentional review cases. These are synthetic fixtures, not manufacturing-ready designs.

The repository includes nine part/revision STEP files, two complete assembly STEP files, nine derived display meshes, five PDFs, and two DOCX documents. The CAD generator exports each STEP, imports it again, validates the solid and volume, and tessellates the imported source. It records source hashes and CAD properties in the manifest. Engineering materials are supplied fixture metadata; display color is not treated as a material specification.

## Code structure

| Path | Responsibility |
| --- | --- |
| `src/domain.ts` | Normalized workspace, part, occurrence, attachment, source identity, and review contracts; validation and snapshot comparison |
| `src/data/previewAdapter.ts` | Fixture-backed implementation of the asynchronous PLM adapter interface |
| `src/data/schemas.ts` | Two deliberately different synthetic attribute schemas |
| `src/integrations/arenaAdapter.ts` | Same-origin HTTP integration boundary with validation, cancellation, and explicit errors |
| `server/` | Read-only MCP provider, OAuth session boundary, bounded tool discovery/pagination, protected content, sanitized errors, and explicit configuration examples |
| `src/integrations/liveWorkspace.ts` | Exact live source bootstrap, explicit baseline selection, and no Preview fallback |
| `src/integrations/protectedContent.ts` | Same-origin file delivery and immediate clearing on expired or changed access |
| `src/cad/`, `src/model-sources.ts`, `src/components/ModelViewport.tsx` and `src/components/model/` | Local STEP worker, exact source mapping, Three.js viewport, scene transforms, interaction, geometry validation, and measurement |
| `src/components/model/SoftwareRenderer.ts` and `softwareGeometry.ts` | Canvas CPU renderer, projection and clipping for the same scene when graphics acceleration is unavailable |
| `src/components/Documents.tsx`, `DocumentWorkspace.tsx`, and `src/document-review.ts` | Source-mapped PDF/DOCX display, search, bounded block/word comparison, redlines, and document anchors |
| `src/visual-diff/`, `src/pdf-page-comparison.ts`, `src/pdf-visual-overview.ts`, and `src/pdf-visual-raster.ts` | Source-bound local PDF pixel comparison, sequential overview, bounded raster/worker ownership and cooperative page cleanup |
| `src/components/VisualDocumentComparison.tsx`, `PdfVisualOverview.tsx`, `src/pdf-reader.ts`, and `src/pdf-worker.ts` | Visual review UI, reader deadlines/selectable text bounds, and explicitly owned package-local PDF workers |
| `src/runtime-checks*.ts` and `src/components/RuntimeChecks.tsx` | Real bundled-fixture diagnostics and sanitized report generation |
| `shared/bom-placements.mjs` | Dependency-free server/browser composition of explicitly parent-local poses, graph validation and physical orientation comparison |
| `src/document-extraction.ts` and `src/document-package.ts` | Extraction coverage, bounded source acquisition, DOCX ZIP/resource validation, and explicit incomplete-comparison states |
| `src/local-files.ts` and `src/components/LocalFileWorkspace.tsx` | Explicit local-file sessions, size/signature/hash checks, manual comparison, and object-URL lifecycle |
| `src/launch-context.ts` and `src/components/FileNavigator.tsx` | Exact document/model launch resolution and source navigation |
| `src/data/reviewStore.ts` and `src/view-state.ts` | Versioned local review persistence and saved-view validation |
| `src/playground/` | Proposal state/history, incremental Three.js scene, concept geometry, source-bound markups, reference documents, assistant client, local draft storage and ECR report/dialog |
| `server/playground*.mjs` | Optional authenticated AI gateway and a separate unmounted ECR orchestration contract for future verified Arena write bindings |
| `src/App.tsx` | Workspace orchestration and user interface |
| `extension/` and `scripts/build-extension.mjs` | Manifest V3 local viewer packaging, exact-context Arena launch bridge, optional click handling, and package validation |
| `scripts/generate-fixtures.py` and `public/fixtures/` | Reproducible synthetic source assets and conversion metadata |
| `tests/` | Behavioral tests for source identity, revisions, transforms, validation, persistence, text comparison, and server failure modes |
| `.github/workflows/check.yml` | Node 22 install, type/test checks, and production build when the source is placed in GitHub |

### Source identity is part of the design

An item number alone does not identify the geometry or its location. The app distinguishes workspace, frozen assembly snapshot/configuration, item revision, attachment ID/edition/hash, and component occurrence. Part A can legitimately appear inside assembly B. Comments and saved views retain their source context instead of silently moving to the latest revision.

A document GUID can identify more than one edition. File navigation, comparison, notes, and new saved views distinguish the item revision, file edition, source hash, and format as well as the GUID. A delivery URL can change without changing that source identity. Restoring a view resolves both the open document and its chosen baseline before changing the workspace; an unavailable or changed source produces an error. Older views that stored only a file ID open only if one edition is unambiguous, with a notice to save the view again.

Attribute IDs are opaque. The UI renders labels, types, units, and scope supplied by the workspace schema. A real workspace should supply that schema from its API rather than hardcoding a customer's field names.

### Recovering a local review

If saved review data is corrupt, the viewer preserves the original stored content and explains that new work is retained only for the session. In **Workspace settings → Review data**, use **Download original stored data** to keep a copy, then **Import & replace** with a valid exported backup for the same workspace. Recovery validates the backup and verifies that the original stored content has not changed since the warning. Invalid backups, changed data, and failed storage writes leave the original content intact. Import replaces the local comments and views; export session work you want to keep before replacing it.

## Connecting Arena MCP

Start with [Arena MCP setup](docs/arena-mcp-setup.md) and the [configuration preflight](docs/arena-preflight.md), then [Arena integration boundary](docs/arena-integration.md) for source identities, workspace attributes, and the review-store discussion. [MCP readiness verification](docs/mcp-readiness-qa.md) separates automated/browser checks from actual Arena observations.

The browser-facing contract is `/api/viewer/v1`. These are viewer-owned endpoints. `npm run dev` serves the Node BFF in-process for local development; without a provider, its status explicitly reports unconfigured. `node server/index.mjs` runs the same service independently on loopback port 4100 for a same-origin reverse proxy. Set the server-only `ARENA_PROVIDER_MODULE` to a trusted deployment module based on `server/provider.example.mjs`.

Explicit `?mode=arena&workspaceId=...&itemId=...&revision=...` launches now resolve the real connection and source data. A missing revision presents a choice from accessible revisions. `baselineRevision` selects an explicit comparison source. The application displays actual revision labels, keeps per-user connection guards on file URLs, and clears protected source panes on access or session changes.

The app’s OAuth login is separate from a developer assistant’s MCP login. Tokens remain on the server. The supplied Arena notes identify the sand26 development endpoint; it returned the expected unauthenticated discovery response during verification. Production endpoints, a registered client or usable CIMD setup, verified identity/tool mappings, and a production session store are still required. The hosted Site is a **static Preview** and does not deploy the Node BFF or an OAuth callback service.

The Chrome extension's toolbar opens the packaged local viewer. Live Arena launches currently open the separately configured hosted viewer/BFF. An optional content bridge handles supported links with complete, exact source context on the four declared Arena origins; real tenant routing remains unverified. Opaque or incomplete links retain normal behavior. The extension stores no OAuth tokens. Direct extension-to-MCP authentication remains conditional on Arena's actual public-client and file-delivery contract. Live annotations and saved views stay disabled until a shared review store is configured; Preview retains its local review tools.

## Current limits

| Topic | Practical limit |
| --- | --- |
| STEP import | Raw STEP works locally, including files chosen by the user. Imports are limited to 32 MiB source, two million vertices, one million triangles, and a two-minute worker deadline. The geometry-buffer budget is 96 MiB per engine, not a hard total browser/WASM/GPU memory cap. Representative SolidWorks, Onshape and Creo exports still need qualification. |
| Prepared mesh/scene limits | An explicitly selected derivative has a 32 MiB streamed-byte limit and a shared 30-second header/body deadline. Float32 attributes must remain finite; local, occurrence and transformed geometry/CAD envelopes must stay within ±1e9 mm. This is an overflow guard, not a guarantee of fine measurement precision at extreme coordinates. |
| Software rendering | The fallback uses simplified lighting, no GPU shadows, and painter-sorted depth/transparency. Intersecting transparent surfaces can have ordering artifacts, and large assemblies will be slower. The cloud browser lacked WebGL2, so browser verification exercised this fallback; the accelerated path still needs a test on a WebGL2-enabled machine. |
| Measurement precision | Picked points lie on display triangles. Exact face/edge distances require a future retained B-rep implementation, which could also run locally. Transformed CAD part boxes or mesh bounds form an envelope; this is not a minimum-volume oriented bounding box. |
| Geometry comparison | The change list compares resolved BOM records, source revisions, and placements. Overlay is visual; automated surface difference heat maps and interference analysis are not implemented. |
| Word fidelity | DOCX is reflowed in the browser and may differ from Word pagination. ZIP entries, expansion, CRC and rendering resources are bounded. Unsupported tracked changes, comments and embedded document parts produce notices; supported embedded fonts are source-isolated. Some parsing/rendering work remains synchronous. Legacy binary `.doc`, native tracked-change editing, and source-file rewriting are not implemented. |
| Document comparison | Extracted text coverage distinguishes complete, partial and unavailable results; missing/scanned/limited pages cannot silently become “no differences.” Genuine empty revisions can produce all-added/all-removed changes. PDF visual review supports selected pairs and a bounded same-number overview, at up to 108 dpi and two million common pixels per pair, without automatic registration or semantic classification. Overview results disclose failed/unscanned coverage. There is no OCR. Suggested notes are deterministic review prompts, not validated engineering conclusions. |
| Collaboration | Demo reviewer identities are simulated. Comments and saved views are local to this browser/origin, with same-browser tab updates. This is not authenticated multiuser collaboration or a transactional shared review service. |
| Review import | Import replaces the current workspace's local comments and views. Export anything you want to keep first. |
| Session continuity | Reader page/search/zoom and completed measurement graphics persist during applicable mode switches in the open session. They are not serialized in saved views. Changing model source/configuration, comparison mode, resetting the scene, or restoring a saved view clears measurements. |
| Assembly scale | The fixture is a small, flat assembly. Explicit `placementSpace: "parent"` snapshots are composed through their hierarchy; omitted/`world` retains world poses. Exact hierarchy selectors and source-to-part transforms are still required when mapping placed CAD subtrees to BOM parts. Placement metadata is bounded to 50,000 occurrences and 256 levels, which is not a rendering-capacity promise. Large-model streaming and representative customer imports remain qualification work. |
| File control | The app avoids automatic downloads of attachments. Display data is still received by the browser; hiding a model, a UI field, or a download button is not a confidentiality boundary. |
| Playground scope | Visual mesh/primitive proposals, not CAD authoring, automatic drawing reconstruction, physical simulation, manufacturing validation or source-hole editing. PDF page drawing is implemented; a Word drawing overlay is not. The AI interpretation path is optional and has not been tested against a live provider. |
| Playground capacity | Up to 2,000 nodes, 250 markups, 512 points per markup and 40 history steps; source geometry retains its local import limits and 96 MiB engine geometry budget. Proposal storage/import is bounded to 4 MiB. These are application bounds, not measured capacity promises. |
| Playground persistence and captures | Preview drafts are local; live drafts, captured intent images and preview ECR receipts are session-only. Source delivery URLs/credentials and original file bytes are excluded from proposal exports. ECR captures are limited to three images of up to 2 MiB each; the review payload is capped at 12 MiB. |
| Assistant and voice | Local web development can use an explicitly configured server-side AI gateway. The installed extension has no external AI transport. Browser dictation may use the browser vendor's speech service and is not guaranteed offline; it inserts editable text and never submits a prompt or ECR itself. |
| PLM workflow | ECR creation is simulated: the app prepares a local Word report, images, manifest and ZIP. It does not create an Arena request, write a hidden field, attach files to Arena or submit an approval. Live writes need verified tools, user permissions, durable retry handling and record/URL readback. |

See [AGENTS.md](AGENTS.md) for development conventions. No Arena credentials, API session tokens, or customer files belong in this repository or client bundle.
