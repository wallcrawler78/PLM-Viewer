# Standalone Review Studio implementation plan

Date: November 13, 2026 (Pacific)

Baseline: `516429eea0749c0c7bffbc5744e375de0517c91f`

## Goal

Deliver a Chrome extension that opens authorized Arena STEP, PDF, and Word sources in a universal review workspace. CAD import, document rendering, and deterministic comparison run on the user's device. Core functionality must not require an AI subscription, desktop CAD/Office installation, or remote conversion service. Documents and models remain equal primary views.

This plan follows the production-readiness audit. The baseline provides a working hosted Preview, a Chrome launcher, preconverted STEP meshes, local PDF/DOCX text comparison, and a tested server-side MCP/OAuth foundation. It does not yet provide arbitrary browser STEP import, a bundled viewer extension, verified Arena mappings, legacy DOC rendering, or shared live review persistence.

## Decisions

1. Package all executable viewer code, CAD WebAssembly, workers, document assets, and fonts. No runtime CDN or AI dependency for viewing or comparison.
2. Import STEP with a deterministic CAD engine in a dedicated worker owned by the viewer tab. Preserve source units, assembly transforms, and source provenance. Keep approximate mesh measurements labeled.
3. Keep raw source attachments distinct from derived display geometry and computed properties. A source-only STEP must be accepted without a server-supplied mesh, bounding box, or volume.
4. Keep original bytes and generated geometry in session memory by default. Do not automatically save attachment files or create a persistent source cache.
5. Preserve exact workspace, configuration, item revision, attachment edition/hash, and occurrence identity. A part number is not a geometry key or placement.
6. Keep the existing server-authenticated Arena path until an actual public-client OAuth and file-delivery contract is verified. Direct extension access is the preferred target if Arena supports it. Never ship a client secret or copy an assistant's credentials into the extension.
7. Preview remains explicit, self-contained, and independent of Arena. A failed live connection never substitutes sample data.
8. Retain local deterministic text redlines. Clearly disclose unavailable/partial extraction, formatting/image exclusions, and browser Word layout limits.
9. Legacy binary DOC, OCR, visual page differences, exact CAD-feature measurements, and authenticated shared collaboration require their own acceptance gates. Visual PDF page comparison is now part of the 0.4 implementation below; each remaining capability stays separate from core viewing.
10. Preserve the hosted private Preview and existing repository identity. Package a separately installable extension artifact from the same source.

## Runtime boundaries

| Component | Responsibility | Data lifetime |
| --- | --- | --- |
| Arena attachment integration | Recognize supported source actions and pass exact identifiers before default navigation/download | Launch context only |
| Extension viewer tab | Document/model panes, selection, review state, and worker ownership | Open session |
| Local CAD worker | Validate/import STEP, normalize millimeters, provide geometry/bounds/hierarchy/warnings | Released on source replacement or cancellation |
| Local document runtime | PDF/DOCX rendering, text extraction, bounded comparison and source highlights | Open session |
| Arena adapter | Resolve schema/BOM/revision/attachment data and enforce exact source identity | User/workspace-bound connection |
| Existing optional application server | Per-user OAuth, authorized retrieval, source verification; no required CAD/document conversion | Production session policy |
| Future shared review store | Authenticated comments, anchors, saved views and concurrent edits | Explicit tenant retention policy |

## Milestone 1 — local processing foundation

Status: implemented in this work session, with final verification recorded below and in `standalone-runtime-qa.md`.

### STEP

- Pin a browser-compatible OpenCascade importer and bundle its JavaScript/WASM locally.
- Add typed import inputs/results, cancellation, source-byte validation, limits, geometry validation, and explicit errors.
- Run parsing/tessellation in a worker; terminate obsolete or over-budget work.
- Accept raw-source-only parts and optional imported/computed properties without weakening exact-source validation.
- Load Preview parts from actual STEP bytes so the ordinary 3D workflow exercises the new importer instead of silently choosing preconverted fixtures.
- Preserve selection, repeated occurrence placement, hide/transparency, sections, explosion, bounds, point measurement, and revision comparison.
- Distinguish imported mesh bounds from CAD-derived fixture bounds. Keep engineering material sourced from metadata.
- Preserve and inspect importer assembly hierarchy. Do not guess mappings of ambiguous assembly subcomponents to Arena items.
- Require an explicit source-to-part rigid transform for selected assembly subtrees, then apply the actual BOM occurrence pose once. Bind both hierarchy path and transform to source identity.
- Provide a local file test entry point if it can use the same import path without weakening live content rules.

### Documents

- Package the pinned PDF.js character maps, standard fonts, and WebAssembly assets; configure local resource URLs.
- Replace ambiguous empty extraction with explicit complete/partial/unavailable states.
- Allow valid empty-to-populated and populated-to-empty text comparisons.
- Identify scanned/failed pages and limit claims of comparison coverage.
- Correct the unsupported DOC message so it does not imply a nonexistent conversion service.
- Surface existing Word tracked-change/comment limitations.
- Add measured parsing/extraction limits and expanded ZIP protection where supported, preserving normal document workflows.

### Acceptance

- A real raw fixture STEP is parsed by the bundled CAD engine and produces finite, correctly scaled geometry.
- Rendering does not request a mesh derivative for the raw STEP path.
- Existing geometry and document workflows retain their behavior.
- PDF auxiliary assets exist in the build and are resolved locally.
- Empty revision comparison works and partial text extraction is disclosed.
- Source replacement/cancellation cannot display stale imported content.

## Milestone 2 — installable Chrome viewer

Status: complete package/build path implemented. Installed-extension qualification remains an explicit release gate.

- Build a complete Manifest V3 extension with the local viewer as the default review surface.
- Include local application chunks, CAD/Word/PDF workers and assets, fixture data for Preview, and notices.
- Add an explicit Preview launcher that needs no hosted service or Arena account.
- Preserve the existing configured hosted Arena launcher as a supported integration path while direct authorization is unresolved.
- Implement narrowly scoped, opt-in attachment action handling only when the source context can be validated. Unknown routes stay with Arena and the context-menu fallback remains available.
- Handle SPA navigation through event delegation rather than assuming the page is static.
- Limit permissions to the supported Arena surfaces. Never scrape tokens or use page-provided identity as authorization.
- Use a packaged-code CSP that permits required WASM without unrestricted eval.
- Produce an unpacked extension directory and ZIP with repeatable build/install instructions.

### Acceptance

- Inspect every emitted extension entry point and asset reference for package completeness.
- Exercise the actual extension when supported browser tooling is available; otherwise explicitly record that installed-extension validation remains outstanding.
- Test context extraction, supported click/keyboard actions, opt-out/fallback behavior, and absence of credentials in launch URLs.
- Verify no remote executable code or external font dependency.
- Confirm document and model panes remain usable in the packaged origin.

## Milestone 3 — actual Arena MCP integration

Status: blocked on verified vendor configuration and authenticated catalog access, not on UI work.

| Input or decision | Required evidence |
| --- | --- |
| Production MCP endpoint | Arena-provided environment-specific URL and discovery |
| App registration | Registered client, exact callback, approved scopes; public-client support if direct extension access is selected |
| Trusted user/workspace identity | Verified subject/workspace contract; no guessed claims or shared admin token |
| Read tools and resources | Authenticated catalog and reviewed allowlist |
| Data mappings | Representative schema, BOM, revision, attachment and supplier payloads |
| Raw file delivery | Exact authorized bytes or approved download mechanism, content identities and size limits |
| Attachment launch | Verified Arena action/route with stable source resolution |
| Production session infrastructure | Persistent protected store and stable secrets if using the application server |

The direct extension option needs its own public-client token lifecycle and extension transport design. The existing same-origin server API is not automatically usable from an extension origin. If Arena requires a confidential client, retain a small application server for auth/retrieval while local processing remains unchanged.

### Acceptance

- Retrieve and render a real PDF, DOCX, and STEP without derivative prerequisites.
- Two users with different permissions receive only their allowed sources.
- Revocation, expiry, logout, account/workspace changes, and mid-import cancellation clear protected content.
- Exact frozen revisions, attachment editions, multiple attachments, custom attributes, and repeated occurrences are preserved.
- Verify large-file delivery, pagination, timeouts, and rate limits with the real provider.
- No live failure falls back to Preview or another source edition.

## Milestone 4 — full engineering and team review

Status: incremental delivery. The 0.4 continuation implements local PDF page differences and explicit nested BOM placement composition; 0.5 adds a bounded PDF page overview and runtime hardening. The other gates remain open.

| Capability | Approach | Gate |
| --- | --- | --- |
| Exact CAD-feature measurement | Retain B-rep in an appropriate local kernel build | Controlled face/edge/vertex references and precision labels |
| Nested assembly/BOM mapping | Parent-local BOM placement composition implemented in 0.4; preserve explicit subcomponent/occurrence identities | Representative SolidWorks, Onshape and Creo exports, duplicate names and repeated instances still need qualification |
| STEP metadata | Read supported engineering attributes with provenance | Missing and conflicting Arena/CAD values remain distinguishable |
| Legacy DOC | Evaluate a local browser engine or approved Arena-stored rendition | Actual binary DOC fidelity, packaging and licensing |
| Scanned-page OCR | Optional local worker and bundled language data | Accuracy and coverage labels; no implicit cloud use |
| Visual document differences | Local bounded PDF page-pair comparison in 0.4 and sequential page overview in 0.5, separate from text redlines | Explicit same-number scan coverage, unavailable/unscanned pages, same physical scale, top-left alignment; no automatic registration, semantic page matching or OCR |
| Shared comments/views | Authenticated shared service or authorized Arena write integration | Access checks, exact anchors, concurrent edits and audit history |
| AI review assistance | Optional future capability, independent of core viewing | Explicit provider/entitlement/data policy; absent AI never disables core tools |

Read-only MCP cannot write the proposed hidden Arena JSON field. A hidden field does not establish authorization, transaction safety, or adequate capacity. Those must be verified before choosing that storage design.

## Milestone 5 — production qualification

- Benchmark representative small, medium and large assemblies and documents on supported company laptops, including two revisions open together.
- Measure CPU, memory, load time, cancellation and release of worker/GPU resources; document tested limits rather than promising arbitrary file sizes.
- Test malformed files, oversized sources, ZIP expansion, partial extraction, unavailable metadata, unsupported formats, and WebGL fallback.
- Test the installed production extension, its CSP, packaged workers/WASM, authentication redirects, startup/restart behavior and actual Arena click actions.
- Capture network activity: only approved Arena/auth/content endpoints may be required for core workflows. No third-party conversion, AI or CDN processing.
- Review dependency licenses/notices and distribute the exact pinned binaries and source obligations appropriately.
- Provide an admin setup guide, format/precision matrix, user-facing error states, release artifact checksums and rollback instructions.

## Verification and change discipline

- Run focused behavioral tests during implementation, followed by `npm run check` and `npm run build` at integration.
- Use the supported Sites source workflow; retain the private audience.
- Run browser QA for affected document/model workflows where available.
- Record only checks actually completed. Unit tests and a build do not prove real Arena connectivity or an installed Chrome extension.
- Keep this document updated with delivered scope and remaining gates at the end of each implementation session.

## Session delivery record

### Delivered scope

| Workstream | Result |
| --- | --- |
| Local CAD | Pinned `occt-import-js` 0.0.23, locally packaged WASM/ES module, dedicated cancellable workers, serialized imports, source hash/size/geometry guards and bounded geometry buffers |
| Strict executable policy | Hash-guarded build transform replaces upstream generated-function wrappers with ordinary closures; no unrestricted JavaScript evaluation added |
| Source-only contract | Raw STEP is the default; mesh, bounds and volume are optional. Explicit derivative selection remains available, without silent fallback after raw import failure |
| Assembly mapping | Exact nonoverlapping hierarchy selectors and explicit source-to-part transforms preserve source provenance and avoid applying CAD/BOM placement twice |
| Documents | Packaged PDF resources; complete/partial/unavailable text coverage; real empty revision handling; bounded acquisition/extraction; validated DOCX ZIP expansion/CRC; unsupported Word features disclosed |
| Local file testing | STEP/PDF/DOCX file picker, manual baseline choices, Documents/3D/Together views, source replacement and session URL cleanup, no file upload or invented Arena identity |
| Chrome package | Complete MV3 application, toolbar/Options sample launches, opt-in exact-context attachment bridge, narrow origins, packaged executable policy, ZIP/checksums and installation guide |
| Integration safety | Existing per-user authenticated hosted path retained; original STEP no longer requires server conversion. Actual Arena mappings, direct extension authentication and shared writes remain unclaimed |

### Verification and artifacts

The current run's automated counts, build/package results, browser observations and concrete limits are maintained in [Standalone runtime QA](standalone-runtime-qa.md). Browser testing includes raw STEP rendering and local-file opening, PDF/DOCX source comparison and visible source highlights. The cloud browser uses the software 3D renderer; accelerated rendering and the installed extension remain separate acceptance gates.

Build outputs are `build/extension/`, `dist/developer/review-studio-extension.zip`, its SHA-256 file, and `dist/developer/arena-review-source.zip`. The checked-in [Chrome guide](chrome-extension.md) describes correct installation and the [test guide](test-guide.md) lists repeatable acceptance workflows.

### Next implementation gates

1. Qualify the packaged extension in a clean current Chrome installation and capture its real network activity and memory/load-time behavior.
2. Receive and verify Arena's authenticated MCP catalog, public/confidential client requirements, exact file delivery, user/workspace identities and actual attachment action.
3. Bind a real workspace and verify distinct user permission profiles, revoked/expired sessions, exact source revisions and tenant-specific attributes.
4. Extend the delivered visual document/nested placement tools with optional local OCR, semantic page matching, legacy DOC support, retained B-rep tools, representative CAD/BOM mappings and shared review storage as independently tested capabilities. Core viewing and deterministic comparison remain usable without AI.

## Continuation — version 0.4

Starting source: `744f1c4655de8fe2e34217bd15061bb799f11252`.

### Scope and acceptance

| Workstream | Implementation | Required verification |
| --- | --- | --- |
| Visual PDF review | A third comparison mode reuses the already opened source PDFs; the user chooses one page per revision or an explicitly absent page. Render at a common physical scale, compare color-aware pixels locally in a worker, navigate bounded change regions, adjust overlay/sensitivity, and draft an exact-page review note. | Graphics/color/blank/size-change cases, source-bound results, cancellation/timeouts, bounded rasters, existing text redlines and notes preserved; browser interaction with the real bundled PDF worker. |
| Local runtime qualification | A separate opt-in screen runs fixed synthetic STEP/PDF/DOCX fixtures through the actual bundled engines, verifies source hashes/package versions and checks graphics availability. Open from Settings or extension Options; download a sanitized report. | Cancel/retry/report safety, actual worker use and rendered output. Reports distinguish hosted Preview from an installed extension; hosted success cannot satisfy the installed-extension gate. |
| Nested BOM placements | Shared server/browser composition for explicit `placementSpace: "parent"`; world poses remain the default. Compose rotation and translation through unloaded containers, retain occurrence identities, normalize once, and include inherited motion in configuration comparisons. | Independent Three.js matrix reference, repeated occurrences, nontrivial rotations, local-anchor round trips, invalid graphs/depth/overflow and sanitized server rejection. Real vendor coordinate mapping remains unverified. |
| Release and qualification | Update package metadata, installation/test instructions, release artifacts and the private Preview. | Full checks/build, focused browser regressions, emitted extension asset review, source/package checksums and explicit remaining gates. |

No new runtime AI, cloud conversion, or external content service is introduced. The real Arena MCP connection, its exact per-user file access and direct-extension authorization still require the vendor contract. Shared review writes cannot be enabled through a read-only MCP connection.

### Delivered and verified

Version 0.4 implements all three continuation workstreams. The final automated suite passed **451 tests across 40 files**, the production build passed, and the extension package contains **275 files / 6.69 MiB**. Hosted browser testing exercised real STEP/PDF/DOCX engines, cancellation and downloaded diagnostics, PDF graphics comparison, page pairing, visual notes, retained text redlines and the combined Word/model workspace. Independent review corrected near-singular orientation precision and equivalent-Euler false movement, along with runtime assertion, input, cleanup and accessibility issues.

The complete evidence, screenshot links, extension checksum, recorded limits and still-open production gates are in [0.4 verification](release-04-qa.md). This delivery does not claim an installed Chrome pass or verified live Arena access.

### Next after this continuation

1. Run the packaged extension's Local runtime checks on a supported company Chrome installation, then qualify actual attachment launch, GPU behavior, offline viewing of bundled fixtures and memory/resource release.
2. Bind Arena's verified authenticated catalog and file-delivery contract, test at least two permission profiles, and confirm exact revisions/configurations and revocation behavior.
3. Choose the next independently scoped capability based on real test files: OCR, legacy DOC, precise CAD measurement, broader visual page matching, or authenticated shared review storage.

## Continuation — version 0.5

Starting source: `fd6455682a269b242b3b4e0357b9300ad1679d1c`. The scoped plan is [0.5 plan](release-05-plan.md).

The completed continuation adds a local PDF page overview with sequential same-number pairing, explicit compared/unavailable/unscanned coverage, extra/size-only page changes, pause/resume, filters and drill-down. It shares the bounded source-bound page comparison path with the existing overlay and retains only scalar session summaries. No outside AI or conversion API is introduced.

Specialist review also hardened ordinary PDF rendering/text selection, unified native PDF worker ownership, added cooperative page cleanup, bounded optional mesh acquisition, rejected unusable renderer coordinates/envelopes, and verified emitted extension imports/workers/fonts and the complete resource policy.

The automated check passed **525 tests across 45 files**, including TypeScript. Browser testing exercised the real local engines, overview pause/resume and sensitivity reset, page drill-down and source notes, PDF search and 19 text changes, 13 Word text changes, and the combined model/document workflow. [0.5 verification](release-05-qa.md) records the final build/package and exact evidence.

Installed Chrome qualification was attempted but the browser policy rejected `chrome://extensions/` and prohibited alternate approaches around that restriction. This gate remains open. The next production phase is the installed-package/company-file qualification and Arena contract binding described above; live per-user access and direct-extension authorization cannot be asserted before that evidence exists.

## Continuation — version 0.6

Starting source: `d4b32e008703849f731f6878a02536ebf844c9fe`. The scoped plan is [0.6 plan](release-06-plan.md).

This continuation begins the configuration part of Milestone 3: an administrator [preflight command](arena-preflight.md) reports required MCP mappings/file delivery, OAuth inputs, explicit signing keys and declared production-store guarantees. It separates local configuration completeness from unperformed Arena, company-file and installed-Chrome acceptance. The preflight imports trusted server code but invokes no provider operation, login, store lookup or network probe itself. The read-only MCP provider now requires file delivery before reporting configured, and retains HTTP 429 as an actionable rate-limit state.

The specialist audit also corrected PDF physical page-size changes hidden by raster rounding, released geometry without any successfully placed occurrence, and discarded STEP transport responses that arrive after cancellation. Existing documents, 3D, comparison and combined-workspace capabilities remain in place. Final evidence is in [0.6 verification](release-06-qa.md).

### Next eligible work

| Priority | Phase item | Dependency |
| --- | --- | --- |
| 1 | Installed-package and representative company-file qualification | Permitted company Chrome profile, sample exports and hardware; existing local diagnostics/file sessions support this work |
| 2 | Real Arena deployment acceptance | Verified client/endpoint, authenticated catalog and mappings; preflight establishes only local configuration presence |
| 3 | Reviewer-controlled PDF overview pairing | Independent local feature: explicit insertions/deletions and reordered pairs with exact source binding and preserved scan coverage |
| 4 | Local import timing/coverage reports for representative files | Scoped report design and representative files; avoid implying a small fixture proves large-file capacity |

Direct extension authorization, exact B-rep measurement, OCR, legacy DOC and authenticated shared review storage retain their separate acceptance and design requirements. They are not implicitly enabled by a configuration report.
