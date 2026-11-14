# Review Studio 0.4 verification

Date: November 13, 2026. Starting source: `744f1c4655de8fe2e34217bd15061bb799f11252`.

This record covers the second local-runtime delivery: visual PDF page comparison, real engine diagnostics, and explicitly parent-local BOM placement composition. It separates observed behavior from production release gates. No customer files or live Arena account were used.

## Automated and package results

| Check | Observed result |
| --- | --- |
| `npm run check` | TypeScript passed; **451 tests passed across 40 files**. Final suite completed after the runtime/UI review fixes. |
| Supported Site build helper | Production TypeScript/Vite build passed; 1,705 modules transformed. |
| Extension packager | **0.4.0**, **275 files**, **6.69 MiB** ZIP. Manifest V3 entry points, local executable policy and required assets validated. |
| Version consistency | Application, extension manifest and runtime asset manifest all report **0.4.0**. |
| Packaged workers | PDF, STEP and visual-diff workers exist under `build/extension/assets/`. |
| Portable source | Includes the new `shared/bom-placements.*`, `src/visual-diff/`, runtime checks, integration tests and documentation under the `arena-assembly-review/` archive root. |
| Whitespace/source audit | `git diff --check` passed. No TODO/FIXME/stub/placeholder markers found in the new implementation modules. |

Extension ZIP SHA-256 for this package:

```text
75636b452e1236d25584c1f6ead47c44b955a938908a2f14b45ccd3939016d5b
```

The ZIP's sibling `.sha256` file and the unpacked package's `checksums.sha256` are emitted by the build. The portable source is regenerated after these QA records are added. Unit tests and package validation do not establish installed Chrome behavior.

## Specialist review and corrections

Three specialists implemented and cross-reviewed the visual worker, document UI/raster provider, and runtime qualification flow. Root integrated and checked the server/browser placement contract and release.

| Finding | Correction and evidence |
| --- | --- |
| Rotation conversion lost precision close to gimbal lock | Replaced the coarse angle snapping branch with a quaternion factorization. Tests compare independent Three.js matrices and transformed points near both singularities and across an 80-level hierarchy. |
| Equal physical orientations could look moved when represented with different Euler angles | Configuration comparison now uses stable quaternion equivalence, including angle wrapping and equivalent singular orientations; tests retain detection of small real changes. |
| Unloaded parent containers still need to place their children | Normalize the full hierarchy before selecting loaded scene parts. Test parent rotation/translation, repeated children, input preservation and idempotence. |
| Invalid hierarchy could invent or corrupt a pose | Reject missing/duplicate parents, cycles, unresolved ancestor placement, sparse/nonfinite vectors, unknown coordinate frame, excessive depth and numeric overflow. Server failures expose a sanitized upstream error. |
| Document fixture assertions expected punctuation absent from real tables | Inspected the original PDF text and DOCX XML and matched real table boundaries while retaining the exact item, revision, envelope and width assertions. |
| Word report counted generated CSS/font text | Count only sanitized document-page text, excluding style/script/font data; final real browser result is 2,019 characters. |
| Page inputs rejected intermediate edits | Keep editable page input text and commit valid values on Enter/blur; the result labels the actual compared pages. |
| Truncated pixel-region list description was inaccurate | Explain that the largest regions are retained, while the full mask and aggregate counts cover every detected changed pixel. |
| Keyboard navigation could traverse 200 region outlines | Only the selected region is a tab stop; previous/next controls navigate the complete retained list. |
| Report download setup failure could retain temporary objects | Release the temporary link and Blob URL on failure. Keep progress announcements outside a busy subtree. |

Graph traversal is iterative and linear in occurrence count. A specialist's bounded synthetic 50,000-row check took 67 ms for world validation and 133 ms for relative composition in this executor. These numbers are not customer-device rendering benchmarks or a guarantee of assembly capacity.

## Real browser runtime report

Executed through the managed preview in the cloud Chrome session, reported browser major **156**, on a **hosted-preview** origin. The final downloaded report is runtime-report.json (historical raw report omitted from this source export). The actual screen is runtime-checks.jpg (historical screenshot omitted from this source export).

| Engine/check | Observed evidence | Final recorded time |
| --- | --- | --- |
| Packaged assets | Runtime versions match; all three original fixture SHA-256 values verified; 170,348 source bytes | 172 ms |
| STEP import | Actual worker imported 4,424 vertices / 4,412 triangles; **180 × 136 × 8 mm** envelope | 933 ms |
| PDF | Explicit native worker opened a two-page PDF, checked 1,151 characters and rendered 13,083 visible pixels | 367 ms |
| DOCX | Validated package and sanitized two-page layout, 2,019 document characters, 127 elements | 279 ms |
| Graphics | WebGL2 unavailable; actual software render produced 1,402 visible pixels | 85 ms |

The run was repeated after canceling an earlier run during STEP import. Cancellation marked the in-flight STEP check and all remaining checks appropriately; **Run again** then completed all five checks. The downloaded JSON contains the closed report schema, versions, surface and bounded metrics; it contains no credentials, document content, workspace IDs or source URLs. Opening the check screen from Workspace settings used a separate tab and retained the review workspace.

These are single-run sample observations. They are not a throughput benchmark, package attestation, or an installed-extension pass. PDF auxiliary font/codec coverage, main-thread Word work and garbage collection retain their documented limitations.

## Browser document/model regression

| Workflow | Observed result |
| --- | --- |
| PDF page 1 A/B visual comparison, Standard | **8 regions**, **1.18%** changed pixels, **108 dpi**, same physical scale. |
| PDF page 2 A/B visual comparison, Standard | **6 regions**, **2.36%** changed pixels. Drawing geometry and revised dimensions appear in the overlay. |
| Explicit blank baseline | Baseline “No page” versus B page 2 produced an addition view. The opposite No page control was disabled so both sides could not become absent. |
| Page editing and source return | Page 2 committed on Enter; Source pages returned both original readers to page 2. |
| Display controls | Sensitivity changed to Low; keyboard Blend controls reached 50%; Highlights toggled off/on; previous/next region navigation selected and scrolled to a new region. |
| Visual draft notes | Drafts were labeled with the exact revision B and selected page. A second suggested note preserved the existing draft and showed the expected notice. Drafting page 2 then labeled page 2 correctly. No note was posted; temporary QA drafts were cleared. |
| Compact document pane with Notes open | Controls remained visible and usable; comparison and note text fit their panes. Screenshot: visual-notes.jpg (historical screenshot omitted from this source export). |
| Existing PDF text tools | Side by side and Redline remained available, reporting **19 extracted-text changes** across both source pages. |
| Existing Word tools | Two rendered pages per source, **13 text changes**, side-by-side controls and the explicit PDF-rendition requirement for visual comparison. |
| Combined review | Word source and actual STEP-derived assembly rendered together. Assembly Bounds reported **212 × 136 × 84 mm** with the existing envelope precision label. Screenshot: together.jpg (historical screenshot omitted from this source export). |

Final PDF comparison screenshot: visual-comparison.jpg (historical screenshot omitted from this source export). Browser screenshots showed a rendering delay in one capture and one capture timeout; later captures and DOM interactions completed. No application error was inferred from that screenshot-tool timeout.

## Processing and coverage boundaries

- Visual PDF comparison uses already opened, exact-source PDF proxies. It adds no second source download, AI provider, remote conversion or OCR dependency. Worker input/output identity includes source, page and physical scale.
- Pages align at the top-left. There is no automatic registration, rotation compensation, semantic change classification, or whole-document visual report. Page pairing is deliberate.
- The common raster is capped at two million pixels, 8,192 pixels per axis and 200 retained region descriptions. All changed pixels remain in the bounded mask. Large pages reduce resolution; source render tasks and comparison workers have cancellation/deadline cleanup.
- DOCX visual fidelity remains browser reflow; legacy binary DOC, OCR and source-file tracked-change writing remain unimplemented. Visual comparison requires PDF sources/renditions.
- Nested BOM composition requires `placementSpace: "parent"`. Omitted/`world` retains world coordinates. Source-to-part normalization, vendor axes/units and CAD component-to-item mapping remain explicit responsibilities; no placement is inferred from quantity or part number.
- The 50,000-occurrence and 256-level guards bound placement metadata. They do not establish model-rendering performance at that size.

## Gates still open

1. Install this exact package in the target Chrome environment and run its diagnostics under `chrome-extension:`. Qualify the real MV3 policy, GPU path, worker/WASM/resource loading, offline fixture operation, startup/restart and network activity.
2. Obtain and verify Arena's authenticated MCP catalog, app registration/authentication model, exact raw-file delivery, workspace/subject claims and real attachment action. The current published Site is still a static private Preview; it does not deploy the Node auth/BFF service.
3. Test two real permission profiles, revoked/expired sessions, exact revisions/configurations/editions, supplier items, tenant-specific attributes and representative SolidWorks/Onshape/Creo files.
4. Measure large-file CPU, memory and resource release on company laptops, including simultaneous revisions. This browser run used software 3D and does not qualify the accelerated renderer.
5. Choose and authorize a shared review store. Read-only MCP cannot write an Arena JSON field; hidden fields are not permission or concurrency controls.
6. Scope legacy DOC, local OCR, exact B-rep measurement, broader visual page matching and other advanced tools as separate capabilities with their own evidence.

The delivery plan and remaining order are maintained in [standalone-viewer-plan.md](standalone-viewer-plan.md).
