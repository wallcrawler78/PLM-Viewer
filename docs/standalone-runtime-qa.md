# Standalone runtime implementation and QA

Date: November 13, 2026. This record covers the first implementation session under [the standalone viewer plan](standalone-viewer-plan.md).

## Result

The viewer now imports actual STEP files locally and packages the entire application as a Chrome Manifest V3 extension. PDF/DOCX rendering and deterministic text comparison remain local. A user-selected file workspace permits testing STEP, PDF and DOCX sources before Arena MCP is available. Core viewing and comparison require no AI account, remote conversion API or desktop CAD/Office installation.

The existing private hosted Preview remains a separate delivery of the same viewer. Live Arena launches currently use the configured hosted viewer and its authenticated application service. Direct extension-to-MCP authentication, real Arena tool mappings, installed-extension qualification and shared live review storage are not established by this work.

## Implemented changes

| Area | Behavior and evidence |
| --- | --- |
| Local STEP | The pinned OpenCascade importer reads original source bytes in a module worker. Preview now exercises this path by default; a derivative is used only when explicitly requested. |
| Source-only models | Mesh URL, CAD box and volume are optional. The content service can return an exact original STEP when server `sourceConversion` is false. Wrong edition/hash or denied access still fails. |
| Source identity | Actual SHA-256, subtree selector and source-to-part transform are included in import, cache and restored-measurement identity. A failed raw source is never replaced silently by a mesh. |
| Assembly frames | Every selected raw subtree requires `cadNodePath` and an explicit rigid `sourceToPart` transform. Placed source vertices are normalized into part-local coordinates before the existing BOM occurrence pose is applied. Overlapping subtrees and absent/invalid frames fail closed. |
| CSP compatibility | The upstream loader used generated-function wrappers. A pinned-version and SHA-256 guarded build transform replaces those paths with ordinary closures. The real importer was tested in a Node VM with string code generation disabled. This is not a substitute for installed-Chrome CSP testing. |
| PDF resources | Character maps, standard fonts, PDF WASM and the PDF worker are packaged locally, with URLs resolved against the viewer origin. |
| Text coverage | Extraction distinguishes complete, partial and unavailable text. True blank revisions can produce all-added/all-removed comparisons. Scanned, failed, unprocessed and limited pages receive explicit coverage notices. |
| Document acquisition | A 30-second total header/body deadline aborts transport and cancels the body. Late responses are disposed. Actual streamed bytes are bounded even when Content-Length is absent or wrong. |
| Word protection | ZIP structure, entry count, expansion, resource sizes and CRC are checked before rendering. Native tracked changes/comments and unsupported embedded document parts are disclosed. Binary `.doc` reports unsupported without claiming a conversion service. |
| Local file workspace | File signature/hash/size checks, eight-file/session limits, manual baselines, Documents/3D/Together views, object-URL release and cancellation. Local labels avoid implying an Arena revision or item association. |
| Pane continuity | Visited local readers and models stay mounted across content-view switches. New model identities reset visibility/opacity and camera fit; changing comparison layout reuses the engine where its source set permits. Document comparison uses the full reading area. |
| Chrome package | Complete app, local executable assets and workers, fixtures, Options, toolbar action, opt-in narrow-origin source bridge, install guide, ZIP and SHA-256 manifests. The source `extension/` directory is not the install target. |

## Automated verification

`npm run check` completed successfully with **382 tests across 35 files**, including TypeScript checking. The production application build and actual extension packaging also completed successfully. The extension is version **0.3.0**, with **265 packaged files**, approximately **6.6 MiB compressed**. Its exact SHA-256 is written next to the ZIP; per-file checksums are inside the package.

The tests include the following substantive behaviors, in addition to the existing review, source-resolution and MCP failure-mode suite:

| Test family | What was exercised |
| --- | --- |
| Real CAD imports | Actual fixture STEP parsed by the pinned engine, equivalent meter/millimeter/inch units, finite geometry and real assembly locations |
| Assembly frame regression | Actual selected OCCT child with nonzero translation and rotation about all three axes; source-to-part conversion followed by Three.js occurrence placement reproduces world vertices/normals and occurrence-local anchor roundtrips |
| Worker lifecycle | Success/error/abort/timeout cleanup, serialized imports, queue cancellation before source allocation, mismatched source/frame rejection |
| Raw source contract | Missing optional derivatives/properties accepted, original source preferred, explicit derivative path, nonoverlapping subtree mapping, stale exact source rejected |
| Geometry identity | Repeated occurrences, prepared-geometry sharing, transform-sensitive cache identity and rejection of measurements from another source frame |
| Documents | Empty revision semantics, complete/partial/unavailable coverage, limits, DOCX expansion/CRC rejection, source deadlines, cancellation and late-body cleanup |
| Local file ownership | Supported format signatures, actual hashes, oversized input rejection, abort before object-URL creation, URL cleanup |
| Extension | Correct local launch, stale context removal, supported/unsupported exact link actions, origin boundaries, keyboard/modifier/opt-out behavior, package asset/CSP validation and a real ZIP packaging exercise |

The CAD specialist's final focused pass covered 183 tests across 10 files. The document specialist's focused pass covered 68 tests across six files. These are overlapping subsets of the complete suite, not additional counts to add to 382. The extension reviewer independently verified the assembly-frame fix after identifying the original defect.

## Browser observations

Executed in the managed local preview using the cloud Chrome browser. The browser reported **Software 3D**, so these observations exercise the CPU renderer. They do not qualify accelerated WebGL rendering or an installed extension origin.

| Workflow | Observed result |
| --- | --- |
| Default sample PDF | The exact B PDF rendered with two pages and its source identity. |
| Sample raw STEP assembly | The assembly rendered after local import. Selecting the B mounting plate and enabling bounds displayed 180 × 136 × 8 mm, labeled as an envelope of supplied CAD part bounds. |
| Sample PDF comparison | A and B rendered together, with 19 text changes, source highlights and a continuous redline view containing the width, datum, fastener and sensor changes. |
| Sample DOCX comparison | Both Word sources rendered with tables and two browser pages; 13 text changes were displayed. |
| User-file input path | Six synthetic source files were selected through the actual file chooser: two assembly STEPs, two PDFs and two DOCX files. The workspace listed all six and opened the B model and PDF together. |
| Raw whole-assembly local import | The B STEP rendered without a derivative URL and displayed a 212 × 136 × 84 mm mesh envelope. The multi-body mapping limitation was visible. |
| Local model revisions | Choosing A as the B baseline displayed the transparent overlay and linked side-by-side model panes. |
| Local reader continuity | Page 2 remained selected after switching Documents → 3D → Documents. |
| Local explicit baselines | Comparison initially requested a deliberate baseline. Selecting PDF A produced 19 changes; the choice survived visiting 3D. Switching to DOCX reset the incompatible PDF baseline; selecting DOCX A produced 13 changes. |
| New model visibility | After hiding B, selecting A reset hidden state and began importing the newly selected model. |
| Local source language | Document headers/footers identify File N, local source and session-only status; they do not claim an authenticated Arena item/revision. |

Screenshots from the run:

Local source model and document together (historical screenshot omitted from this source export)

PDF source comparison (historical screenshot omitted from this source export)

Word source comparison (historical screenshot omitted from this source export)

Browser automation latency is not an application load-time benchmark. No claim of large-assembly throughput or peak browser memory is inferred from these checks.

## Current runtime bounds

| Resource | Implemented bound |
| --- | --- |
| Individual STEP/PDF/DOCX source | 32 MiB |
| Local file session | Eight files, 128 MiB combined source size |
| STEP acquisition / import | 30-second retrieval deadline, two-minute worker deadline, one active import per module |
| Imported geometry | Two million vertices and one million triangles per source import |
| Prepared geometry cache | 96 MiB buffer budget per engine; not a total WASM/GPU/browser memory limit |
| Detailed model edges | Omitted above 120,000 triangles with a notice |
| CAD subtree metadata | At most 64 indices; each index from 0 through 19,999 |
| Document acquisition | 30 seconds total for headers and body |
| PDF text extraction | 300 pages, 500,000 characters, 6,000 blocks, 100,000 text items per page, 20-second extraction budget |
| DOCX expanded package | 2,000 entries, 64 MiB total expansion, 16 MiB per resource and 8 MiB XML part |
| DOCX rendered tree | 300 browser pages and 200,000 elements |

Limits are defensive bounds, not tested production capacity promises. DOCX parsing/rendering and some comparison operations still contain synchronous work that cannot be forcibly interrupted mid-operation. The model importer produces display triangles; it does not retain an exact-measurement B-rep service.

## Remaining production gates

| Gate | Required next evidence or implementation |
| --- | --- |
| Installed Chrome | Load the emitted package in a clean supported Chrome profile and verify workers/WASM, final CSP, toolbar/Options, local files, cancellation and startup/restart behavior |
| Accelerated rendering and scale | Representative laptops, WebGL2, two revisions, larger vendor STEP exports and documents; measured load time/memory/cancellation |
| Real Arena access | Verified MCP catalog, client registration, scopes, identity/workspace bindings, exact authorized source bytes and tenant field mappings |
| Attachment opening | Actual supported Arena action/route; synthetic exact-context link tests do not prove that every Arena attachment click is intercepted |
| Direct MCP from extension | Decide against Arena's actual public-client redirect/token contract. Until then, the current live destination remains the hosted authenticated service |
| Permission acceptance | Two real user profiles, inaccessible sources, expiry/revocation/logout and mid-load account/workspace changes |
| Engineering fidelity | Real SolidWorks/Onshape/Creo files, nested transform flattening, exact child mapping, metadata provenance and desired precision |
| Additional formats/tools | Legacy DOC, local OCR, pixel/visual page comparison, exact CAD-feature distances, native Word tracked-change editing and source rewriting |
| Shared review storage | Authenticated authorship, source-bound anchors, concurrency/audit history and an authorized write path; read-only MCP cannot update the proposed Arena JSON field |
| Distribution | Final license/source-obligation review, stable extension identity, store or managed enterprise distribution and rollback |

Rendering needs source bytes on the user's device. The viewer avoids automatically saving attachment files, but it cannot guarantee that browser/OS memory, screenshots or authorized user copying never produce copies. That distinction should remain explicit in the product's deployment policy.
