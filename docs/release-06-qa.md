# Version 0.6 verification

Session: November 13, 2026 (Pacific); runtime report timestamps use November 14 UTC.

Starting source: `d4b32e008703849f731f6878a02536ebf844c9fe` (0.5.0). Scope: [0.6 plan](release-06-plan.md).

## Outcome

The configuration preflight and confirmed regression fixes passed the full automated check and production build. The matching Manifest V3 package was generated and its emitted asset graph validated. Hosted browser testing passed the existing document, model and combined workflows and all five actual local engine diagnostics.

These results do not qualify an installed extension, a real Arena connection, company CAD/document fidelity or production session infrastructure. The checked-in Arena example remains deliberately unconfigured.

## Independent review and repairs

Three specialist reviewers covered documents, integration, and model/extension behavior. They implemented bounded repairs and ran focused regressions. The integration reviewer also independently reviewed the new administrator preflight.

| Finding | Delivered correction | Evidence |
| --- | --- | --- |
| Physically different PDF page sizes could round to identical raster dimensions | Preserve the actual page-dimension comparison alongside the validated pixel result | The new 8.1-point versus 8.2-point blank-page case failed before the fix. Both produce 13 × 9 pixels; detail and overview now retain the size change, with zero changed pixels correctly retained. |
| Rejected model placements retained otherwise unowned geometry and budget | Release assets after placement validation when no successful current/baseline occurrence uses them | Two failing-before regressions cover disposal, ownership, corrected-placement reload, and preservation of healthy shared uses. |
| A non-cooperative STEP fetch could deliver an unowned response after abort/timeout | Discard late source bodies and prevent a late CAD worker | Two failing-before streaming-response cases cover timeout/source replacement, stalled cancellation and cleared timers. Limits are unchanged. |
| MCP 429 was flattened into generic 502 | Preserve sanitized `RATE_LIMITED` through transport, actual SDK wrapping and BFF | Synthetic-wire/BFF regressions; no upstream body forwarding or automatic retry. |
| A metadata-only provider could report configured without file delivery | Require `readContent` for the bundled MCP provider | Missing bytes binding keeps status unconfigured, blocks live data and makes no MCP request. |
| Configuration fields could be mutated after construction | Snapshot MCP binding functions and connection-key bytes; freeze the report and limits | Mutation and connection-guard regressions pass. |
| An initial preflight sanitizer could validate and later copy different getter values | Accept only own data fields; snapshot known scalars once and enforce numeric bounds | Independent reproduction now rejects the accessor, executes it zero times, and rejects oversized numeric limits. |

No additional stubbed implementation was identified in the reviewed paths. Declared gaps such as legacy DOC, OCR, exact B-rep measurements and shared live notes remain explicitly unimplemented.

## Automated verification

| Gate | Result |
| --- | --- |
| `npm run check` | **561 tests passed across 46 files**, including successful TypeScript checking |
| Production build through the supported build helper | Passed; local runtime assets verified; 1,711 modules transformed |
| `node scripts/build-extension.mjs` | Passed emitted import/worker/resource and policy checks; 275 packaged files |
| Example administrator preflight | Expected exit **2**, `state: "blocked"`, 24 configuration blockers; actual Arena/network checks unperformed |
| Closed report tests | 24 cases cover no-operation inspection, missing mappings, development sessions, absent keys, CIMD scope, opaque/malformed reports, accessor rejection, secret omission, arguments and redacted load errors |
| Whitespace/diff checks | Passed |

The final total adds 36 cases to 0.5's 525 tests. Specialist focused runs are subsets of the same full suite and are not added to that total.

The example's actual preflight report (historical raw report omitted from this source export) demonstrates the blocked state. A configuration-complete fixture is tested synthetically; no deployment or user is represented as live-qualified. The [administrator guide](arena-preflight.md) explains trusted module execution, exit codes, declared store guarantees and remaining acceptance.

## Browser regression

The supported managed Preview ran in Chrome 156. This phase adds no controls to the main review workspace.

| Workflow | Observed result |
| --- | --- |
| PDF reading | Revision B rendered as two source pages with its requirement text |
| Visual PDF overview | Both pairs completed, zero unavailable/unscanned; pair 1 reported 1.18% changed pixels and pair 2 reported 2.36%, at 108 dpi |
| Overview drill-down | Pair 2 opened baseline page 2 / open-file page 2, with six navigable regions and the draft-note control available |
| PDF text redline | 19 changes shown in context with original add/remove values |
| Word side-by-side and redline | Both DOCX editions rendered; source highlights and 13 text changes remained available |
| Together | Word remained readable beside the fully loaded raw STEP fixture assembly; software 3D and model controls were visible |
| Engine diagnostics | All five fixture checks passed; the sanitized report downloaded successfully |

The screenshots show the established document/3D hierarchy without administrator clutter. Automation-extension metadata messages appeared in browser logs; they originated in the browser's injected extension and are not evidence that Review Studio's emitted extension was installed or qualified.

PDF overview (historical screenshot omitted from this source export)

Word redline (historical screenshot omitted from this source export)

Word beside the STEP assembly (historical screenshot omitted from this source export)

Additional evidence: Word source comparison (historical screenshot omitted from this source export), runtime screen (historical screenshot omitted from this source export).

## Actual local runtime report

Downloaded runtime-report.json (historical raw report omitted from this source export), started `2026-11-14T01:25:15.516Z`, finished `2026-11-14T01:25:18.728Z`. Environment: **hosted-preview**, viewer **0.6.0**, Chrome **156**. These are single-run fixture timings, not a capacity benchmark.

| Check | Observed result | Elapsed |
| --- | --- | ---: |
| Packaged assets | Three source hashes and pinned versions verified; 170,348 source bytes | 191 ms |
| STEP | Actual local CAD worker; 4,424 vertices, 4,412 triangles; 180 × 136 × 8 mm | 1,203 ms |
| PDF | Actual local PDF worker; two pages, 1,151 characters, 13,083 nonwhite rendered pixels | 1,446 ms |
| Word | Validated DOCX, two reflowed pages, 2,019 characters and 127 elements | 310 ms |
| Graphics | Software render produced 1,402 pixels; WebGL2 unavailable | 59 ms |

STEP/PDF/Word rendering and comparison still run locally. No AI service or remote conversion capability was added. MCP supplies authorized source data; it does not replace local processing.

## Release artifact

| Field | Value |
| --- | --- |
| Application / extension version | `0.6.0` |
| Unpacked extension | `build/extension/` |
| Extension ZIP | `dist/developer/review-studio-extension.zip` |
| Packaged files | 275 |
| ZIP bytes | 7,020,900 (6.70 MiB) |
| SHA-256 | `c849f0df96233824a8d7698261a0daefbb82b2f670a7a41108db1c0495c3a6dd` |
| Source ZIP | `dist/developer/arena-review-source.zip`, regenerated after documentation/evidence collection |

The source ZIP excludes credentials/private deployment modules, Git internals, dependencies, generated build output and Site identity. Publication uses the supported source workflow and preserves the existing owner-only Site audience. The final handoff records the resulting source commit and deployment outcome.

## Remaining gates and recommended sequence

| Priority | Work | Status / dependency |
| --- | --- | --- |
| 1 | Installed Chrome and company-file qualification | Open. The earlier browser policy rejected `chrome://extensions/` and forbade alternate workarounds. This round did not retry or bypass it. Use the emitted package on a permitted company profile. |
| 2 | Real Arena MCP acceptance | Actual endpoint/client, identity, tool schemas, BOM/file mappings, two differing user permissions, revocation and supported launch route are required. Preflight now makes missing local configuration reviewable. |
| 3 | Explicit PDF overview page pairing | Best next independent document capability: user-controlled insertions/deletions/reordered pairs, bound to exact files and preserving scan coverage/cancellation. Not started in this release. |
| 4 | Representative-file diagnostic reports | Useful performance/fidelity phase using local sessions; company exports and an agreed report scope are needed. |

The current live architecture opens a separately deployed hosted viewer/BFF. Direct extension-to-MCP authentication is not implemented; the static Preview does not deploy the BFF. Read-only MCP cannot save a hidden Arena JSON field. Shared review writes require their own authorized storage/lifecycle/concurrency contract.
