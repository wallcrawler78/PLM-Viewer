# Playground 0.8 implementation and remaining phases

## Product boundary

Playground is a separate proposal workspace inside the universal viewer. It edits interactive web 3D representations while retaining the exact source BOM, component occurrences and source geometry as a baseline. Original Arena files, released revisions and STEP bytes remain unchanged. Camera, explosion, hiding, opacity and presentation labels are display state; they do not imply proposed BOM changes.

The source is version **0.8.0** on `feature/playground`. The separately maintained hosted Preview remains **0.7.0** and has not been redeployed with this feature. Documents, 3D inspection and Together remain the primary review workspaces; Playground adds design exploration and a preparation path for an ECR.

## Delivered implementation

| Phase | Implemented behavior | Verification boundary |
| --- | --- | --- |
| Scene and proposal foundation | Local STEP loading, source-bound occurrences, incremental component transforms, parameterized box/cylinder/bracket concepts, editable concept holes, original/proposed/overlay and reversible history | Automated tests cover state and geometry behavior; interactive rendering still needs the manual browser gate. |
| Visual design intent | Arrows, highlights, freehand, text and pins on model views and PDF pages; camera lock while drawing; source-local anchors with geometry identity; view-only camera/scene identity; editable labels and deletion | Snapshot and anchor guards are tested. Drawing, selecting, dragging and layout still require browser interaction checks. |
| Reference documents | PDF and Word reading beside the scene; PDF page markup with exact edition/hash/page; original universal document comparison and search remain available outside Playground | Browser regression checks remain pending for the new combined workspace. |
| Optional assistant | Editable text/dictation input, opt-in image attachment, server-only provider connection, bounded packaged scene operations, atomic validation, cancellation, stale-version guards and review before Apply | Tests use synthetic provider responses. No authenticated live model request has been performed. The installed extension has no AI network transport. |
| Proposal retention | Preview browser-local autosave, exact-source JSON export/import, corruption/quota/stale-write handling; live Arena drafts remain session-only | Automated persistence tests; browser restart/cross-tab behavior remains part of manual qualification. |
| ECR preparation | Title/description dialog, visible-item affected selection, actual scene/intent images, local Word report with embedded images, manifest/ZIP and an idempotent simulated receipt | Automated package and orchestration tests; no Arena write occurs. Word layout inspection is a separate artifact check, not browser UI evidence. |

## Six-step ECR workflow

1. Select **Create ECR** in Playground.
2. Enter a title and describe the requested change and its reason.
3. Review the affected items. Source items in view start selected and repeated occurrences share one item/revision entry. Hidden items, proposed removals and the parent assembly can be included explicitly. New unnumbered concepts are documented without inventing Arena item identities.
4. Capture the proposed configuration and retain up to two intent images. A saved image keeps its original markup text, camera/document context, presentation state and proposal version. It survives later markup editing or deletion. A historical anchor for an undone concept remains historical evidence; it does not authorize an Arena item mapping.
5. Generate `change-summary.docx`, actual captured PNG/JPEG images, `proposal-manifest.json`, and a ZIP review package. The Word document includes the user's description, affected items, accepted changes, assumptions and embedded views. Original source attachments are not copied into the package.
6. Display a **Preview ECR** receipt and download choices. The current implementation does not create an Arena request or return an Arena URL. A future verified write provider must create the draft, attach the files, set affected items and read the record back before exposing its actual URL.

Creation errors keep the user's description and selection. A retry of the same prepared package reuses its bytes and simulated receipt. Captures and receipts remain session data; they are retained outside that session only by an explicit export/download. Preparing the package does not automatically download files.

## Integration and fidelity rules

| Topic | Rule |
| --- | --- |
| Source permissions | Preserve the existing human user/workspace authorization boundary. Reading an item does not by itself authorize external AI processing or ECR writes. |
| Source identity | Retain exact configuration, item revision, source hash and CAD mapping. A denied or unavailable live source never becomes Preview data. |
| Scene commands | Apply fixed parameters to packaged functions. The assistant cannot send JavaScript, executable modules, arbitrary shaders, arbitrary API URLs or an open-ended interpreter. |
| CAD and dimensions | Source geometry can be positioned as a component, but its STEP holes/features are not edited. A separate concept bracket can express a proposed hole layout. Concept dimensions and meshes are design intent, not manufacturing evidence. |
| Markups | A 2D arrow does not establish unknown 3D depth. Surface anchors retain local points while the geometry matches; changes to the underlying shape invalidate that correspondence. PDF anchors retain exact page identity. |
| Document-derived concepts | The optional assistant can use an explicitly shared PDF-page image and instruction to suggest supported concept shapes. There is no verified automatic engineering drawing reconstruction, OCR pipeline or complete product generator. Unknown dimensions remain assumptions or questions. |
| Storage | Preview draft storage is browser-local and bounded. It is not shared team storage or a transactional Arena annotation service. Live drafts are not automatically persisted to local storage. |
| Captured evidence | ECR images come from the local rendered scene or PDF page and are paired with frozen markup snapshots. A generated illustration is not substituted for engineering evidence. |
| Chrome | Local viewer and Playground operations are packaged. The current extension CSP intentionally has no outside AI transport; AI configuration belongs to the local/hosted web gateway. |

## Verification recorded for 0.8

`npm run check` passed: **704 tests in 59 test files**, including TypeScript. `npm run build:extension` also passed for 0.8.0. The generated Word test report was rendered to three pages and inspected; a table-row split was corrected and the report rerendered. Report layout QA is separate from browser interaction QA.

Automatic approval review blocked the attempted browser validation, so **Playground visual/interaction QA and installed-Chrome QA remain pending manual gates**. No successful browser screenshots or extension installation are claimed for this release. Historical 0.7 browser/performance records retain their original scope. No authenticated live AI request, tenant attachment-click flow or live Arena ECR write was tested.

Use [Playground testing](playground-testing.md) for the pending manual checks. The [AI/ECR connection document](playground-ai.md) describes configuration and the exact provider boundary.

## Remaining phases

| Phase | Work required before claiming completion |
| --- | --- |
| Manual browser and Chrome qualification | Exercise drawing/selection, transform handles, PDF/model layout, captures, ECR dialog, actual DOCX downloads, cancellation, renderer behavior, and the installed Manifest V3 package in the user's authorized Chrome profile. |
| Configured AI trial | Use an approved model account and server-side key; verify model access, request/response behavior, latency, bounded costs, sharing policy and useful drawing-to-concept prompts. Keep human review before Apply. |
| Arena read integration trial | Verify the actual tenant tool catalog, user access, schema attributes, exact source bytes/editions, placements, session expiry and supported launch actions. Existing read scaffolding is not proof of a working tenant binding. |
| Arena ECR write trial | Map actual create/affected-item/attachment/readback tools, verify per-user rights, supply a durable shared retry journal, recover lost/partial responses, and validate the actual Arena request URL. The existing server orchestration seam is not publicly mounted. |
| Optional assistant inside the extension tab | Add a narrowly scoped approved gateway transport, appropriate extension authentication and declared connection origins. Preserve server-owned keys and user/workspace policy; qualify the resulting CSP and permissions in Chrome. |
| Shared team proposals | Define approved persistence, revision lifecycle, concurrent editing and permissions. A hidden Arena field is only a possible storage mechanism after its capacity and authorization semantics are verified. |

These phases do not require replacing the local STEP/document engines. The next testable result is the local 0.8 package, followed by the explicit manual and live-service gates above.
