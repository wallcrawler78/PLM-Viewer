# Performance review and scaling plan

Reviewed for version 0.7 against starting source `f703a3c20641f0bdac2c6af3458d937dc508b0a0`. Document, geometry, and preference specialists reviewed independent areas; the geometry reviewer also checked the text-worker lifecycle. See [0.7 verification](release-07-qa.md) for checks actually completed and [user preferences](user-preferences.md) for the settings roadmap.

## Assessment

The local architecture is suitable for continued prototype testing. Raw STEP conversion, PDF/Word processing and comparison do not need an AI subscription or remote conversion API. Larger workloads still need qualification: resource ceilings protect the application, but do not establish comfortable interactive capacity. A small fixture passing does not qualify a 300-page document, a large assembly, or an installed extension.

The highest-confidence immediate improvements are removing text alignment from the UI thread, avoiding redundant scene updates, settling PDF width changes, and replacing repeated item/revision scans with snapshot-owned lookup indexes. They preserve source fidelity and existing comparison/measurement semantics.

## Larger STEP measurements, 13 November 2026

The [external STEP performance report](large-step-performance.md) now supplies five public sources, repeatable hash-bound CLI/browser harnesses and measured results. Four 5.55–25.90 MiB sources passed three local conversion repetitions each and rendered in the software browser path. Import medians were 9.79–49.27 seconds; dense-source software camera renders had roughly 1.96–2.02 second medians. The largest accepted sample reached 1,523 MiB reported whole-Node-process peak RSS, not browser peak memory. The 37.67 MiB source was rejected before conversion under the existing 32 MiB cap.

This establishes a starting corpus and exposes an interactive software-rendering limitation. The next qualification priority is the same corpus on target WebGL2 Chrome hardware and the installed extension, followed by software allocation/primitive work and progressive/subassembly loading. Retain current caps. PDF/Word, deep assemblies, large revision overlays, multi-tab and long-session measurements remain outstanding. Source bytes and diagnostic pages are excluded from production packages; the source archive includes reproducible tools and reports.

## Changes in 0.7

| Area | Finding | Change | Practical limit |
| --- | --- | --- | --- |
| Text redlines | Block alignment and word differences ran synchronously during React rendering. | The same deterministic algorithm runs in a packaged local worker. Each request owns its exact before/after identities, with bounded input/result validation, a deadline, cancellation, cleanup and a retryable error. | Worker startup, structured cloning, input/result validation and rendering the returned redlines still have costs. This isolates computation; it does not promise faster total comparison. |
| PDF pane resize | Each observed width could restart the raster and text layer during a divider drag. | First visible width applies immediately; subsequent widths settle for 120 ms. Hidden panes and disposal cancel pending work. | The displayed page uses its last committed size during continuous dragging, then renders at the final width. Raster fidelity and source coordinate mapping are unchanged. |
| Document search | Each keystroke repeated case normalization across extracted blocks. Search feedback also needed to distinguish incomplete text coverage. | Build a normalized passage index once per extracted source, normalize query whitespace, and qualify result status. Keep search local to the current source and its extracted text. | Search remains a bounded scan of indexed passages. It counts matching passages, not individual word occurrences; scanned content requires an OCR rendition, and phrases do not span independent blocks. |
| Model updates | Status/callback-only React updates could walk all models, update bounds and mark the scene dirty. | Callback references refresh independently of scene work. Actual visual inputs still update the scene; newly imported objects explicitly receive current visibility and display state. | A real selection, camera, anchor, section, quality or visibility change still requires work. |
| Scene signatures | Full part arrays were serialized again during viewport status updates. | Serialization is memoized by immutable source-array identity; reload decisions remain value based. Local-file scene props are also memoized. | This relies on the existing immutable React state contract; source objects must not be mutated in place. |
| BOM resolution | Scene construction, comparisons and table cells repeatedly searched the part list. | Snapshot-owned maps resolve the exact opaque item ID and revision. Attribute number formatting reuses one formatter. | Index construction is linear in the supplied part list. These are per-snapshot indexes, not global source caches or account-spanning caches. |
| Display quality | Raster density had no user control. | Standard preserves the existing renderer limits. Economy caps backing pixels at one per CSS pixel, in both sample and local-file workspaces. | It does not reduce triangle count, change STEP tessellation, alter measurement values, or lower PDF comparison resolution. On a 1× display, it may make no difference. |

Relevant implementation: [`DocumentWorkspace.tsx`](../src/components/DocumentWorkspace.tsx), [`text-comparison/`](../src/text-comparison/), [`document-resize.ts`](../src/document-resize.ts), [`engine.ts`](../src/components/model/engine.ts), [`ModelViewport.tsx`](../src/components/ModelViewport.tsx), [`LocalFileWorkspace.tsx`](../src/components/LocalFileWorkspace.tsx), [`domain.ts`](../src/domain.ts), [`model-sources.ts`](../src/model-sources.ts).

## Evidence and interpretation

A reproducible synthetic text case uses 125 blocks over 25 labeled pages per revision. Every block contains 210 shared tokens, a component number, and `revision alpha` versus `revision beta`. Baseline text contains 383,390 characters; revised text contains 383,265 characters. Three synchronous runs on Node v24.22.1 took **509, 448 and 566 ms**, median **509 ms**; all returned 125 changes without truncation. Raw results: `text-comparison-benchmark.json` (historical raw report omitted from this source export).

This is algorithm computation on this test container. It is not a browser responsiveness, worker overhead, Arena latency, customer-document or capacity benchmark. It demonstrates enough synchronous work to justify moving alignment off the interface thread. We have not claimed a browser frame-rate improvement or an end-to-end speedup from these numbers.

Reproduce the input and timing from the repository root:

```js
// node --experimental-strip-types --input-type=module
import { compareDocumentBlocks } from './src/document-review.ts';
const shared = Array.from({ length: 210 }, (_, i) => `requirement${i}`).join(' ');
const source = revision => Array.from({ length: 125 }, (_, i) => ({
  id: `block-${i}`, page: Math.floor(i / 5) + 1,
  text: `${shared} component${i} revision ${revision}.`,
}));
const before = source('alpha'), after = source('beta');
for (let run = 0; run < 3; run++) {
  const start = performance.now();
  const result = compareDocumentBlocks(before, after);
  console.log(performance.now() - start, result.changes.length, result.truncated);
}
```

The model interaction regression submits 20 callback/label-only updates and observes zero render submissions and zero transformed-bound calculations; a subsequent real selection causes a redraw. This verifies avoided work in the engine test harness, not a measured browser FPS gain. Exact-revision lookup tests also cover delimiter-like opaque IDs and 600 repeated placements across two item revisions.

## Next work, in priority order

| Priority | Work | Why it matters | Acceptance before shipping |
| --- | --- | --- | --- |
| Next | Extend the measured corpus and qualify target hardware | Public STEP sources and software-mode baselines are now recorded. WebGL2, installed Chrome, document complexity and compound workloads still need qualification. | Measure first useful content, comparison completion, UI long tasks, peak memory, source switching, cancellation and repeated open/close on specified Chrome/hardware. Include WebGL2 and software mode, high-DPI displays, overlay, Together and multiple tabs. |
| Next | Window large BOM and redline lists | The navigator/table and redline view still render their complete visible datasets; text redlines can contain up to 3,000 change cards. | Keep keyboard navigation, selected-row visibility, change jumps, accessible semantics and source-bound drafts correct when offscreen rows are unmounted. Do not hide comparison coverage. |
| Next | Word page visibility and scroll geometry | Word currently mounts the rendered document and reads page geometry for navigation/scrolling. The hard bound is 300 reflowed pages and 200,000 elements, not an interactivity guarantee. | Cache/invalidate page geometry on width/zoom/content changes and coalesce scroll work. Evaluate page windowing with placeholder heights while preserving anchors, search, copy/selection, tables and reflow page numbering. |
| Next | Demand-driven text indexing and in-session document reuse | Full PDF text extraction starts during simple reading. Switching from a single reader into a comparison currently replaces the reader and opens/parses sources again. | Show the first readable page promptly; start bounded indexing when needed or in cancellable background slices. Reuse exact-source handles with reference ownership and eviction, and recheck access/source identity before reuse. Closing a session must release bytes, workers and object URLs. |
| Next for large assemblies | Batch selectors from one STEP assembly | Identical source-plus-selector requests share geometry, but different subtree selectors can re-import/tessellate the same assembly source separately. | Import one exact source per bounded batch, preserve each CAD-node path and `sourceToPart`, reject overlapping mappings, share geometry where valid, and release unused subtrees. Never substitute a different revision or silently use a remote derivative. |
| Next for large assemblies | Progressive, selected-subassembly loading | The current scene waits for the requested import batch before inserting successfully loaded geometry. A large batch delays the first useful model. | Insert completed, source-correct occurrences progressively with clear loading/failed counts, stable fit behavior and cleanup on source replacement. Keep user-selected loading policy separate from BOM content. |
| Next for software mode | Reuse projection buffers and bound primitive work | `SoftwareRenderer` creates three Float64 XYZ arrays per mesh draw: 72 bytes per vertex before primitive arrays and other geometry. At two million vertices this alone is 144 million bytes of transient storage. | Profile allocation/GC during orbit and comparison, reuse owned scratch buffers, cap working sets, and retain picking, clipping, transparency and anchor alignment. A source validation maximum is not a promise that software rendering can comfortably display that source. |
| Later, after profiling | Accelerate dense-model picking | Hover and point selection can intersect the full visible triangle set. Dense models may need a spatial index even when rendering is acceptable. | Build a bounded, source-owned acceleration structure and verify nearest-hit, clipping, comparison-side, transparency and measurement behavior before replacing the current raycast path. |
| Later, after profiling | Demand-scheduled animation and visibility suspension | Idle drawing is already skipped, but the engine still schedules `requestAnimationFrame` and updates orbit controls each frame. | Stop waking settled or hidden viewers while correctly resuming damping, resize, source completion, fit/restore, context recovery and all interactive edits. Do not introduce stale views merely to lower idle activity. |
| After vendor mapping | Arena retrieval cost and throughput | MCP supports data access; it does not make large file transfer or BOM traversal free. The current provider has request/response bounds, cancellation, pagination and rate-limit handling. | Measure actual vendor calls, page counts, bytes, first-use latency and throttling with two differently authorized users. Use lazy detail/attachment reads and vendor-supported batching. Any in-session cache must include the verified user/workspace and exact source; never cache permission failures as missing data or present a partial BOM as complete. |

Document hotspots are in [`Documents.tsx`](../src/components/Documents.tsx) and [`DocumentWorkspace.tsx`](../src/components/DocumentWorkspace.tsx). Model/import hotspots are in [`SoftwareRenderer.ts`](../src/components/model/SoftwareRenderer.ts), [`engine.ts`](../src/components/model/engine.ts), and [`step-client.ts`](../src/cad/step-client.ts). The integration boundary is [`mcp-provider.mjs`](../server/mcp-provider.mjs).

## Bounds to keep visible

Current acquisition caps include 32 MiB per source, eight user-selected local files and 128 MiB per local-file session. STEP imports are queued one at a time per module/tab; geometry validation permits at most two million vertices and one million triangles. The scene's 96 MiB geometry budget does not account for total browser heap, CAD WASM, source bytes, software projection buffers, PDF canvases, fonts or DOM.

Text extraction is bounded by pages, characters, blocks and time. The worker's transport accepts up to 6,000 blocks and one million retained characters per source because PDF item separators can add characters; the existing comparison still limits each side to 1,500 prepared blocks and 500,000 input characters, with explicit partial-coverage reporting. Alignment and word-cell budgets remain unchanged. The default worker deadline is 15 seconds and abort terminates the owned worker. Browser page rendering and garbage collection on the main thread cannot be forcibly interrupted by that deadline.

PDF visual review keeps its existing two-million-pixel page-pair bound and sequential overview budgets. Economy rendering does not change these values. Hard resource caps, missing-source warnings, comparison coverage and permission enforcement must remain outside ordinary user preferences.

## Qualification sequence

1. Establish repeatable baselines with original, controlled or approved files from common SolidWorks, Onshape and Creo exports, including repeated occurrences, subtree mappings and known physical dimensions. Add long/text-heavy PDFs, graphics-heavy drawings, scanned pages and complex Word tables/images.
2. Profile each operation separately: acquire/hash, import/parse, first render, index/compare, interaction, close/reopen. Record bytes, source complexity, hardware, Chrome version and graphics path alongside timings. Keep raw source content and customer identifiers out of telemetry.
3. Implement the next bottleneck supported by those measurements, with explicit memory/lifetime ownership. Recheck correctness and coverage at every limit, including cancellation, denied access and source replacement.
4. Run the actual packaged viewer under installed Chrome with its Manifest V3 policy, including the new text worker. Hosted Preview and static resource validation are useful evidence but do not replace that test.
5. Qualify live Arena mappings and user permissions after the MCP is enabled. Agree supported workload tiers from the measured results before increasing caps or making performance guarantees.
