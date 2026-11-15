# Prototype verification record

The newer document-first universal workspace is covered in [Universal viewer quality check](universal-viewer-qa.md). Historical results below describe earlier builds.

The subsequent UI and functional quality pass is recorded in [Additional prototype quality check](quality-check.md), including the updated **64-test** result, browser regressions, responsive checks, and screenshots. The sections below preserve the initial implementation record.

This record describes the initial synthetic-data prototype and checks actually performed during implementation. It is separate from the broader acceptance workflows in [test-guide.md](test-guide.md). Final automated test totals, final build status, and publication status are reported in the handoff; they are not inferred from the presence of a test or build file.

## Browser environment

The cloud Chrome session did not provide WebGL2. The application used the **Software 3D** fallback: the same STEP-derived indexed triangle meshes, scene transforms, and Three.js raycasting, projected onto a Canvas 2D surface by the CPU. This was a working geometry-rendering path, not a static screenshot or replacement scene.

The fallback preserves scene selection, source mapping, orbit/pan/zoom, comparison, clipping, measurement, and model pins. Its lighting is simplified, GPU shadows are absent, and painter sorting approximates depth/transparency for intersecting surfaces. Performance on large assemblies and accelerated WebGL2 rendering on a local Chrome machine remain separate checks.

## Observed browser workflows

| Workflow | Observed result | Scope or limitation |
|---|---|---|
| Initial assembly and BOM | The synthetic Atlas Drive Module opened with a visible assembly, BOM, revision controls and reference panel. | Preview fixtures only; no Arena request. |
| Actual PDF display | A supplied PDF rendered in the reference pane and remained usable alongside the model. | Document rendering, not just a filename or placeholder. |
| Actual DOCX display | The supplied Word specification rendered as browser content. | DOCX reflow; Word-identical pagination and binary `.doc` conversion are not claimed. |
| Document comparison | Actual editions produced extracted-text differences in the side-by-side comparison. | Formatting-only changes, drawings and scanned-image OCR are not classified. |
| Suggested review note | A changed requirement produced an editable suggested note; it was posted through the explicit review action. | Deterministic review prompt, not an independently validated engineering conclusion. |
| Pinned reference | A reference stayed open while the model selection changed. | Its own revision and edition remained the document's source context. |
| Follow selection | Related attachments changed with the selected item; items without a document had an explicit empty state. | Attachment resolution uses the selected configuration's child item revision. |
| Workspace-dependent attributes | Switching to Medical Device Lab changed the BOM table's field definitions and displayed values. | Two synthetic schemas demonstrate the API-driven contract; no customer's field schema was tested. |
| CAD-derived bounds | The revision B base displayed **180 × 136 × 8 mm**. | This is the envelope of CAD-derived bounds, not a minimum-volume oriented box. |
| Two-point distance | Two points on displayed geometry produced a numeric distance in millimeters through the CPU rendering path. | Mesh-surface distance; no metrology or exact face/edge guarantee. |
| Revision overlay | A/B geometry could be displayed together with transparency controls. | Visual comparison; no automatic surface-difference classifier. |
| Side-by-side review | Both configurations displayed with linked camera behavior. | Same source coordinate frame, not independently centered parts. |
| Exploded view | Occurrences separated through the explosion control and could be restored. | Display state did not change the BOM placement records. |
| Model-to-BOM selection | Clicking the motor geometry selected the corresponding motor item. | Selection used occurrence identity. |
| Model comment anchor | A geometry click created a source-bound model note with occurrence-local coordinates. | Anchors remain tied to their original configuration and source hash. |
| Saved review view | A view was saved and retained in local preview persistence for restoration. | Browser/origin-local storage, not a shared team database. |

## Automated coverage

The repository's automated checks cover the concrete implementation risks below. Use the final `npm run check` output for the executed test total and result.

| Area | Covered behavior |
|---|---|
| Fixture provider | Real manifest editions, repeated occurrences, changed/unchanged child revisions, isolated returned copies, numeric edition normalization, retry and cancellation |
| Dynamic schema | Different opaque field IDs, types, item/BOM scopes, missing values, zero and false |
| Revision comparison | Added/removed/revised/moved occurrences, changed source hash within an item revision, and loading state not being a removal |
| Native browser fetch | The default preview and Arena fetch wrappers preserve the global receiver; regression coverage for `Illegal invocation` |
| Geometry | Coordinate transforms, bounds, point distance, mesh input validation, and software-renderer projection/clipping behavior |
| Review source resolution | Shared child documents prefer the current assembly context; pinned foreign-revision documents retain their owner; unavailable or changed snapshots/hashes/editions cannot be silently located against current sources |
| Local review store | JSON version/size validation, duplicate IDs, valid anchors, workspace isolation, stale sequential edits, source-bound pins, quota/read failures, and preservation of malformed stored data |
| Text and saved views | Extracted text comparison behavior and validation of stored viewer state |
| Arena boundary | Explicit unconfigured state, denied identity/workspace, required item/revision context, no preview fallback, no-store responses, upstream-error redaction, and rejection of unimplemented writes |

## Dependency audit and portability

After dependency patches, `npm audit --json` completed with **zero reported vulnerabilities** across informational, low, moderate, high and critical categories. This records the registry audit result for the checked lockfile at that time; it is not a guarantee against unknown vulnerabilities or future advisories.

The GitHub workflow in `.github/workflows/check.yml` installs the lockfile with Node 22 and runs `npm run check` followed by `npm run build:extension` (which includes `npm run build`). It uses read-only repository permissions and requires no Arena, deployment, or application secrets. The current source repository is the private Sites-managed repository; adding the workflow does not claim that a GitHub workflow run has already executed.

The source ZIP is generated by the production build at `dist/developer/arena-review-source.zip`. Runtime fonts are bundled locally. The archive excludes local environment files, installed dependencies, build output, Git internals and Site identity.

## Checks that remain outside this verification

No live Arena API, tenant-specific attributes, credentials, permissions, hidden field writes, Arena approval actions, real authenticated collaboration, or real workspace file-click interception was tested. The live-mode screen remains unconfigured by design. Representative customer STEP exports, deep assemblies, large-model performance, exact B-rep measurement, arbitrary STEP upload/import, binary Word conversion, and the accelerated renderer need their own integration or platform acceptance checks.

## Final release gate

- `npm run check`: TypeScript succeeded; **56 tests passed across 9 test files**.
- `npm run build`: production build and portable source ZIP succeeded.
- `npm audit --json`: zero reported vulnerabilities, including development dependencies.
- Additional browser checks: section clipping, load/unload distinction (8 visible while all9 BOM occurrences remain), explicit live-launch setup screen, and a posted occurrence-local model comment were verified.
- The source ZIP was inspected: it contains11 STEP files and application source, with no dependency directories, credential files, or Git internals.

These checks verify this prototype and its synthetic fixtures. They do not establish production PLM authorization, engineering certification, or performance on large customer assemblies.
