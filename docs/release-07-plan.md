# Version 0.7 — performance and viewing preferences

Starting source: `f703a3c20641f0bdac2c6af3458d937dc508b0a0` (0.6.0).

## Goal

Reduce avoidable interface work in document and 3D review, and introduce a small browser-local preference layer. Preserve deterministic comparison, exact source/session boundaries, meaningful coverage warnings and the current universal workspace.

## Bounded implementation

| Work | Intended behavior | Acceptance |
| --- | --- | --- |
| Text comparison worker | Run the existing block/word comparison in a packaged local worker | Exact source pair binding, bounded request/result validation, cancellation/timeout/termination, explicit unavailable state, no false zero changes or synchronous fallback |
| PDF resize scheduling | Coalesce repeated width changes while dragging a divider | Preserve readable content, commit the final width and keep annotation/text geometry consistent; cancel stale scheduled work |
| Model updates | Refresh callbacks without repeating scene work for unrelated React/status renders | Zero geometry/bounds/draw work for callback-only updates; selection, visibility, camera, measurement, anchors and newly imported objects still update |
| Bulk BOM lookup | Index exact item/revision pairs once per snapshot operation | Preserve source identity, repeated placements and missing-revision behavior; no global or cross-user cache |
| Viewing preferences | Browser-local defaults for comparison layout, linked scrolling, source highlights and 3D raster quality | Closed versioned scalar schema, no write on initial read, no source/identity data, explicit session fallback, separate reset, new-comparison defaults and immediate display-quality application |
| Document search follow-up | Verify and polish the existing local PDF/DOCX word and phrase search | Reuse normalized passage indexes, normalize query whitespace, show honest partial/unavailable coverage, consistent close/focus behavior, pane-scoped Ctrl/Cmd+F and cross-page next/previous/Enter navigation |

The standard graphics setting keeps existing raster density; economy caps raster density at one device pixel per CSS pixel. This affects presentation only, not imported geometry, stored coordinates, picking or measurement values. It does not alter PDF comparison resolution/sensitivity.

Document defaults apply to newly opened comparisons. Changing defaults must not reset the active source pair, page positions, overview or in-session overrides. Explicit file launches and saved source views remain authoritative. Preferences do not change Arena permissions, safety limits or shared review data.

## Review and follow-up scope

Document the measured synchronous text hotspot and code-confirmed large-data risks. Treat worker offloading as a responsiveness improvement, not a promised computation speedup. Large-model batching, BOM/document virtualization, demand-driven indexing, document-handle reuse and software-renderer memory changes need their own representative-file acceptance work.

The preference backlog includes length display units/precision, fit policy, input/navigation presets, contrast/theme, schema-scoped columns, and account synchronization. These must use consistent formatting and verified scope rather than silently modifying source data. Existing reduced-motion support remains in place.

The user explicitly added document text search while release verification was underway. Existing search already covers extracted passages across pages; this slice improves its presentation, indexing and keyboard behavior. Search counts passages rather than individual word occurrences, and does not perform OCR or join phrases across independent extracted blocks. Those boundaries must remain clear.

## Verification

Use specialist review, focused behavioral tests, the full type/test check, supported build, emitted extension resource validation and browser checks of preference persistence/default precedence, PDF/Word redlines, source switching/resizing and 3D interactions. Publish matching private Preview/source/extension artifacts. Installed Chrome, WebGL2/company-file benchmarks and actual Arena access remain separate gates.

## Completion

The bounded implementation and search follow-up are complete. The integrated result is 614 passing tests across 50 files, a successful production build/package validator, and the browser checks recorded in [0.7 verification](release-07-qa.md). Larger-workload and installed/live qualification work remains in the [performance review](performance-review.md) and [preference roadmap](user-preferences.md).
