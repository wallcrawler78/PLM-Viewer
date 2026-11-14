# Universal viewer regression audit

November 12, 2026. Scope: the working Preview prototype after the universal Documents / 3D / Together update. Three parallel source reviews covered documents, 3D/BOM behavior, and integration/review persistence. The primary review combined those findings with interactive browser checks and fixes.

This audit distinguishes implemented Preview behavior, source-level integration scaffolding, and capabilities still awaiting a live Arena implementation. No Arena account, customer file, or PLM record was accessed or changed.

## Defects corrected

| Area | Defect | Result after correction |
| --- | --- | --- |
| Document identity | File navigation and comparison treated a file GUID as an edition identity, collapsing separate editions with the same GUID. | Selection, deduplication, source pairing, and note matching use item, item revision, file ID, edition, hash, and format. Delivery URL rotation does not change the source identity. |
| Saved document reviews | A view stored only a file ID and did not retain the selected baseline. | Views store exact references for the opened document and baseline. Restore resolves both before changing the UI; missing or changed sources produce an error. A deliberately empty baseline stays empty. |
| Older saved views | ID-only restoration could choose an arbitrary source. | An older view opens only one unambiguous available source and displays an explicit legacy notice. Ambiguous or unavailable files are rejected. |
| Word note navigation | A located Word note could replay its scrolling command when the user moved to another page. | Ordinary DOCX page navigation does not rerun the note location command. |
| Linked document navigation | Compared documents with different page heights could echo programmatic scroll events and pull each other to the wrong page. | Linked navigation transfers page number and within-page progress. Only a reader receiving real user input publishes scroll updates. |
| Search and redline navigation | An old highlighted change could reclaim the page after a search result, manual navigation, or closing search. | Focus ownership follows the latest explicit user action. A new change command can locate a change; an old command cannot undo page navigation. |
| Word comparison styling | Global document styles could leak from one comparison pane into the other. | Each Word reader has its own generated style prefix. |
| Baseline markups | Add comment worked only on the opened/right document. | Either source pane accepts a markup and retains its own exact source context. |
| Document anchors | Markers were filtered by file ID alone; clicking between Word pages could create invalid page coordinates. | Marker ownership checks revision, edition, kind, and supplied item/hash. Word gaps are ignored. Page-only notes do not invent a point. |
| Model camera | A delayed camera callback could miss the most recent orbit or standard view when Documents unmounted 3D. | Camera updates publish synchronously before the layout changes or a view is saved. |
| Measurement continuity | A completed point measurement disappeared when a user consulted Documents and returned to 3D. | Completed endpoints and their line are restored after the same geometry reloads. Reset, missing/hidden endpoints, and changed source/placement prevent restoration. |
| Baseline bounds | Selecting a removed component could produce no bounds even though its baseline geometry was displayed. | The bounds tool uses the selected baseline source, labels it, and draws the box in the baseline pane in side-by-side mode. |
| Empty model states | Help text referred to a nonexistent Show all control; an all-hidden comparison could remain blank. | Empty states identify Reset view, Add from BOM, or a component's Load control and account for comparison geometry. |
| Adapter metadata | Incomplete attachment records reached readers and source-detail panels. | Both attachment-list and BOM boundaries validate required file metadata before use. Duplicate exact identities are rejected. |
| Frozen configurations | The adapter accepted the right item/revision but a different requested configuration. | A requested configuration must match exactly. |
| Same-origin BFF path | A backslash-containing path could normalize to another origin. | The adapter rejects origin-changing paths, whitespace/control characters, and query/fragment injection before network access. |
| Legacy launch parser | Oversized or duplicate identifiers could be silently dropped or accepted. | Invalid or ambiguous item/file/revision/parent context is rejected explicitly. |
| Local review recovery | A corrupt saved review made valid backup import inaccessible. | An explicit backup import validates data and replaces only the exact corrupt payload inspected. The original bytes can be downloaded first. Stale data, invalid backups, workspace mismatch, and quota errors preserve the saved payload. |
| Import lifecycle | A delayed backup read could finish after a workspace switch or a newer import. | Import completion is scoped to the captured workspace and request, and stale completion is discarded before any persistent write or UI replacement. |
| Malformed saved views | String coercion accepted array values as enum settings, allowing an imported section axis to crash restoration. | Revision, comparison mode, section axis, workspace layout, and panel settings require actual strings from their supported enums. |

## Coverage and verification

The baseline suite passed 93 tests before corrections. The final `npm run check` passed TypeScript validation and **136 tests across 17 files**. `npm run build` passed and produced the production app and portable source archive. The dependency lockfile and original synthetic fixture sources remain unchanged.

| Browser workflow | Observed result |
| --- | --- |
| Open Word B and compare with A | Both DOCX files rendered with distinct style scopes; 13 extracted-text changes were available. Numeric width changes appeared in redlines. |
| Mark the baseline document | Posting from the left pane created a note for assembly/item A, edition 1, page 1. Locating the note and opening its referenced document selected the A source. |
| Navigate after locating a Word note | Next page reached page 2 without returning to the note. |
| Linked Word navigation | Both readers stayed on page 2 after page navigation. Manual reader navigation no longer produced scroll feedback. |
| Search followed by page/change navigation | Searching for Maximum, moving to page 2, and closing search retained manual position. Choosing the next change intentionally returned both readers to the relevant page 1 change. |
| Save and restore document comparison | A saved Word review restored Documents mode, the exact B source, baseline A, and the 13-change comparison after clearing the baseline and switching to 3D. Exported JSON contained both exact source references and hashes. |
| PDF launch and comparison | The Preview PDF launch opened A/B comparison with 19 text changes. Next page displayed page 2 in both readers, with their revision-specific attachment sheets rendered. |
| Removed component bounds | Selecting the removed HW-3001 occurrence in split comparison showed Baseline selection bounds of 12.4 × 12.4 × 16.0 mm, with the box on the left source. |
| Current component bounds | Isolating the B mounting plate showed 180.0 × 136.0 × 8.0 mm. |
| Measurement and camera continuity | A completed 85.95 mm mesh-point measurement, its line, selected plate, and top view remained after switching to Documents and back to 3D. |
| Model display controls | Opacity changed to 0.1, explosion to 100%, and changing the section to X at −120 mm visibly clipped the model. Reset restored the normal display. |
| Hide/reset and load/unload | Hiding the isolated selection displayed the all-hidden explanation; Reset restored nine visible components. Unloading the cover reduced the visible count to eight and exposed its Load action; reloading restored its geometry. |
| Together mode | Keyboard resizing moved the divider from 50% to 55%. Enabling Follow selected BOM item and selecting GBX-2002 opened its exact A inspection PDF alongside the highlighted model in assembly configuration B. |
| Workspace attributes and isolation | Switching to Medical Device Lab showed its material specification, risk, patient-contact, and verification columns. The Precision workspace's local QA note and saved view were absent from the Medical workspace. |
| Unavailable source | A launch with a missing file displayed an unavailable-source explanation and did not open a substitute attachment. |
| Arena-mode launch | An Arena-mode launch containing a Preview-like file ID displayed the unconfigured live-connection screen. The sample workspace opened only after explicitly choosing its button. |

Malformed API payloads, exact-source mismatch and ambiguity, recovery under corrupt/stale/quota storage, and asynchronous import cancellation are exercised by automated tests. Corrupt browser storage was not injected through the browser UI. The exported review JSON was inspected successfully; the subsequent browser file-picker import check stalled and was abandoned, so an import round trip is not claimed as browser-verified. Browser QA used the supplied synthetic files; it does not establish behavior for arbitrary customer documents or production Arena data.

### Captured browser evidence

Word comparison and source-bound baseline note (historical screenshot omitted from this source export)

Measurement and top view retained after a document detour (historical screenshot omitted from this source export)

## Stub and incomplete-functionality inventory

| Capability | Actual current state |
| --- | --- |
| Active document controls | Real PDF/DOCX rendering, source-bound markup, text search, page/zoom tools, automatic extracted-text differences, redlines, and draft notes. No placeholder success handlers were found. |
| Active 3D/BOM controls | Real STEP-derived mesh rendering, BOM/model selection, visibility/isolation, opacity, explosion, sectioning, approximate point measurement, CAD-bound envelopes, revision overlay/split, and loading from the resolved BOM. |
| Attribute flexibility | Schema-driven attribute IDs, labels, types, units, visibility, and item/BOM-line scope; two synthetic schemas remain available. |
| Live Arena connection | Browser adapter and read-only BFF/provider contract exist. Provider implementation, application live-provider selection, protected source assets/conversion, and permission acceptance tests are still required. Arena mode fails closed. |
| Chrome launch | Manifest V3 context-menu/manual launch scaffolding and Preview launch examples. Actual Arena attachment-click interception has not been implemented or tested against a real tenant. |
| Arbitrary STEP ingestion | Supplied genuine STEP files are preconverted to display meshes. Arbitrary upload/import/conversion is not implemented. |
| Engineering precision | Mesh-picked distances are approximate; CAD part envelopes are available. Exact B-rep face/edge metrology, automated surface-difference heat maps, and interference analysis are not implemented. |
| Word/PDF depth | Browser-reflowed DOCX and extracted PDF text. Legacy binary .doc, scanned-page OCR, formatting/image/drawing difference classification, native tracked-change editing, and rewriting attachments are not implemented. |
| Collaboration | Local comments, replies, resolve/reopen, views, import/export, and same-browser tab updates. Authenticated simultaneous multiuser review and server annotation writes remain unimplemented. |
| Arena hidden JSON field | A possible future persistence provider only. No hidden field has been created or written. Capacity, permissions, lifecycle, and concurrency require tenant-specific verification. |
| Large/deep assemblies | A small flat synthetic assembly is tested. Deep placement composition, streaming, and representative customer exports need separate integration acceptance tests. |

The intentional error in `server/provider.example.mjs` is a guard against pretending an unimplemented provider is configured. An older unused `DocumentComparison` export remains compatibility code; it is not an active UI action. The unused document-workspace callback has been removed.

## Practical verification limits

The managed Chrome environment exercises the Software 3D fallback. WebGL2 rendering on the user's hardware, touch devices, representative SolidWorks/Onshape/Creo exports, and live Arena behavior are separate acceptance work. Tests of adapter failures use controlled responses and do not establish a live integration.

Saved views retain exact source editions, comparison choice, workspace layout, camera, and model display state. Page/search/zoom, the selected redline, and measurement graphics remain session state rather than serialized view fields. A completed measurement survives a document detour while its source remains unchanged.

Preview review records created during browser QA remain local to the test origin. They are not published as shared notes and do not change the fixture files. Publication status is supplied by the deployment result in the handoff.
