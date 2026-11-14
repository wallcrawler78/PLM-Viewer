# Version 0.5 verification

Starting source: `fd6455682a269b242b3b4e0357b9300ad1679d1c` (0.4.0). This record covers the 0.5 changes and checks actually completed. The detailed implementation scope is [release-05-plan.md](release-05-plan.md).

## Audit findings and fixes

Three specialists independently reviewed documents, CAD/BOM behavior, and the Chrome/runtime boundary. The document reviewer also reviewed the new overview implementation after its initial implementation.

| Finding | Implemented correction | Evidence |
| --- | --- | --- |
| Ordinary PDF reader could await page, raster or text-layer work indefinitely | 20-second owned-operation deadlines and cancellation; readable raster retained if selectable text is unavailable | Stalled task/late completion/cancellation tests and ordinary PDF browser use |
| Selectable text bypassed extraction budgets | Streamed text capped at 100,000 items, 500,000 characters and 4,096 font styles | Reader budget, stream cancellation and fallback tests |
| PDF worker setup differed between diagnostics and normal reading | Shared explicitly owned package-local native module worker, including failure/source replacement disposal | Worker lifecycle/URL tests; actual normal reader and diagnostic browser execution |
| A full-document scan could retain PDF page operator/image resources | Cooperative page cleanup after visual raster, reader render and extraction-page work | Actual installed PDF.js test verifies deferred cleanup, concurrent text and later page reuse; final browser scan/search/source navigation |
| Mesh derivative fetch had unbounded JSON acquisition | 32 MiB streamed byte cap and a single 30-second header/body deadline, with late-response/abort cleanup | Header/body stalls, misleading lengths, cancellation and protected-content session tests |
| Finite JSON coordinates could overflow Float32; placed envelopes could escape the renderer range | Finite Float32 validation and ±1e9 mm local/occurrence/transformed actual/CAD envelope boundary | Numeric overflow, rotated bounds and healthy repeated-occurrence tests |
| Extension validation could miss deleted emitted workers/chunks | Parsed static/literal dynamic imports, worker/preload URLs, CSS resources, manifest versions/entries and full policy validation | Missing actual PDF/STEP/visual worker chunks and malformed package tests |
| New overview needed defensive identity and resume boundaries | Recheck exact keys/page counts after worker completion and reconstruct allowlisted scalar resume fields | Source replacement and malformed/resume-state tests |

No unimplemented live capability was turned into a Preview fallback. Raw STEP remains the default. Core viewing and deterministic comparison require no AI service, remote conversion, or desktop viewer.

## Automated verification

| Check | Result |
| --- | --- |
| `npm run check` | Passed: TypeScript and **525 tests / 45 files** |
| New overview/raster/visual groups | Passed: source identity, sequential processing, extra blank pages, size-only changes, failed coverage, cancellation, resume, pair/pixel/run/document budgets, worker lifecycle and existing pixel algorithm cases |
| PDF cooperative cleanup | Passed against installed PDF.js, including a pending operator consumer, concurrent text extraction and re-reading the same page |
| Geometry and protected content | Passed: raw STEP/BOM/placement regression plus derivative byte/deadline/range and session invalidation cases |
| Extension validation | Passed: missing emitted assets, remote imports, stale manifest, altered policy and ordinary entry-point cases |
| Production build | Passed through the supported Sites build helper (`tsc -b`, Vite production output, source packaging) |
| Extension packaging | Passed: **version 0.5.0**, **275 files**, **6.70 MiB** ZIP, local asset graph and policy validation |

These checks are behavioral and source/package checks, not installed-extension or live-Arena qualification.

### Build artifacts

- Complete unpacked package: `build/extension/`.
- Installable archive: `dist/developer/review-studio-extension.zip`.
- Archive checksum: `dist/developer/review-studio-extension.zip.sha256`.
- Per-file checksums: `build/extension/checksums.sha256`.
- Complete handoff source: `dist/developer/arena-review-source.zip`.

Extension ZIP SHA-256:

```text
bf11a8d9062eb18ec0138dd555bb794e4ab852a628ef1935605b0e39dbf25c1f
```

## Observed browser behavior

The supported managed browser Preview used Chrome **156**, with **WebGL2 unavailable**. Browser actions used the real application, PDF/Word renderers and local CAD/comparison workers. No browser automation or extension installation was attempted outside the supported workflow.

| Workflow | Observed result |
| --- | --- |
| PDF page overview | Baseline A / open B specification: **2/2 pairs compared**, 0 unavailable, 0 unscanned, both pairs changed |
| Overview values | Standard sensitivity: page 1 **1.18%**, page 2 **2.36%** changed pixels at **108 dpi** |
| Pause/resume | Paused an active real scan; interrupted pair remained unscanned. Resume completed both pairs |
| Filters and session persistence | Unavailable filter showed a truthful empty state; returning from detailed overlay retained completed summaries |
| Sensitivity change | High sensitivity removed the old summaries and required a fresh scan; Standard scan then completed |
| Drill-down | Opening overview row 2 selected baseline page 2 and open-file page 2; the overlay showed **6 regions** |
| Notes | A selected region created an editable Rev B/page 2 draft. A second suggestion preserved the existing draft and showed the existing warning. No note was posted |
| Original pages and text redlines | Source pages returned both readers to page 2. PDF redlines retained **19 changes** |
| Reader input/search | Clearing/retyping the page number and committing worked. Search `sensor` reported four matches and moved to page 2 with source highlights |
| Word regression | Both DOCX sources rendered, source highlights remained visible and the redline view retained **13 changes** |
| Combined model/document | Actual STEP-derived assembly rendered beside the PDF; revision overlay remained available; visible CAD-bound envelope was **212 × 136 × 84 mm** |
| Compact document pane | Overview remained usable with Files and Notes open. Observed content width 755 px equaled scroll width 755 px; no horizontal overflow |

Screenshots: PDF overview (historical screenshot omitted from this source export), overview with Files and Notes (historical screenshot omitted from this source export), Word redlines (historical screenshot omitted from this source export), model and document (historical screenshot omitted from this source export), runtime checks (historical screenshot omitted from this source export).

### Actual local runtime report

The downloaded runtime-report.json (historical raw report omitted from this source export) identifies **viewer 0.5.0**, **hosted-preview**, Chrome 156, and `outcome: passed`. Its UTC run was 2026-11-14. These are small fixture observations, not performance targets.

| Check | Observed evidence | Duration |
| --- | --- | --- |
| Assets | Three source hashes verified; 170,348 source bytes | 179 ms |
| STEP | 4,424 vertices, 4,412 triangles, **180 × 136 × 8 mm** | 1,020 ms |
| PDF | Explicit local worker; 2 pages, 1,151 checked characters, 13,083 visible pixels | 392 ms |
| Word | 2 rendered pages, 2,019 checked characters, 127 elements | 273 ms |
| Graphics | Actual software render produced 1,402 visible pixels; WebGL2 false | 85 ms |

## Capacity and interpretation

| Boundary | Current behavior |
| --- | --- |
| Overview pairing | Same page numbers, top-left alignment, one physical scale; manual page pairing remains available in the detailed overlay |
| Raster/work limits | 2 million common pixels per pair, up to 108 dpi, 45 seconds per pair; 50 pairs / 60 million attempted pixels / 2 minutes per run; at most 300 pairs in an overview |
| Coverage | Failed pages are unavailable. Interrupted/budget-exceeded/beyond-limit pages remain unscanned. Blank extra pages and page-size changes are retained |
| Resume/lifetime | Only exact same source keys, page counts and sensitivity; scalar summaries stay in the current comparison session. No automatic persistence, file download or Arena write |
| PDF memory | Cooperative cleanup releases per-page resources when active consumers finish. Source bytes/shared fonts/global caches remain until document close. Pixel caps are not a total PDF.js/browser heap guarantee |
| Geometry range | ±1e9 mm is an overflow bound, not a fine-precision promise. Measurements remain approximate display-mesh measurements |
| Acquisition | Original STEP/documents and optional mesh derivatives remain bounded; the derivative path now has the same 32 MiB / 30-second browser acquisition ceiling |

Automatic semantic page matching, scan registration, OCR, legacy binary DOC, retained B-rep measurements and authenticated shared review storage remain separate features. DOCX pagination remains browser reflow.

## Open production gates

1. **Installed Chrome:** the attempt to open `chrome://extensions/` was rejected by the environment's browser security policy. The rejection explicitly prohibited alternate browser surfaces or indirect workarounds; none was attempted. A hosted pass and complete ZIP cannot certify installed CSP, service-worker startup, offline behavior, native workers/WASM, or actual launch interception.
2. **Real Arena:** verify its authenticated MCP catalog, user/workspace identity, OAuth registration, exact BOM/revision/attachment/supplier mappings, raw file delivery and actual supported attachment action. Test two permission profiles, revocation, expiry, denied attachments and configuration changes.
3. **Direct extension access:** the current live launcher opens the separately deployed authenticated hosted viewer/BFF. Direct extension-to-MCP authentication remains unimplemented pending Arena's public-client contract. The static Preview is not the BFF.
4. **Representative files and hardware:** qualify SolidWorks/Onshape/Creo exports, large assemblies/documents, PDF fonts/codecs and DOCX layouts, GPU rendering, peak memory and load/cancel behavior on company laptops.
5. **Collaboration:** the read-only MCP cannot write a hidden JSON field. Shared notes require an authorized write/storage contract with access, capacity, lifecycle and concurrency guarantees.

The next production phase should begin with the exact emitted extension and retained runtime reports on permitted company Chrome profiles, then the verified Arena contract. Core local processing remains usable without external AI while these gates are completed.
