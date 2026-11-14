# Version 0.5 — document overview and runtime hardening

Starting source: `fd6455682a269b242b3b4e0357b9300ad1679d1c` (0.4.0).

## Goal

Make a complete PDF revision review practical without an external conversion or AI service, while closing the concrete runtime and packaging gaps identified by independent document, geometry, and extension reviewers. Preserve the current universal workspace, exact source identities, local STEP processing, text redlines, and per-user integration boundary.

## Scope

| Workstream | Planned behavior | Acceptance |
| --- | --- | --- |
| PDF page overview | Explicitly scan the opened PDFs in page-number order, one pair at a time. Show changed, no detected pixel change, extra baseline/open-file page, and unavailable outcomes. Open any pair in the existing detailed overlay. | Same physical scale, explicit coverage and source binding, page-size and blank-page changes retained, cancellation/resume, bounded time/pixels/pairs, no retained full-document rasters, no false clean result after a failed page. |
| PDF reader reliability | Bound page lookup, raster rendering, and selectable text work; preserve a readable page when its text layer fails. Allow page-field edits before committing. | Stalled/oversized/malformed text, timeout and cleanup tests; reader and text redline browser regression. |
| Packaged PDF runtime | Use an explicit native packaged worker in normal reading and diagnostics, and parse relative content URLs using the full page URL at an extension origin. | Worker ownership/cleanup, opaque-origin URL and protected-content tests; no fake-worker success. |
| CAD derivative boundary | Bound optional mesh downloads and reject unusable Float32/world geometry. Keep raw STEP as the default without fallback. | Stalled header/body, byte limit, cancellation, malformed coordinate and transformed-envelope cases. |
| Extension artifact | Verify the emitted JavaScript asset graph, not only HTML entries. | Missing CAD/PDF/visual worker or imported chunks fail packaging. No remote executable dependency is introduced. |

## PDF overview decisions

The scan pairs page 1 with page 1, page 2 with page 2, and so on. It does not infer page correspondence after an insertion or register shifted scans. Surplus pages are labeled as extra pages on their respective side, including blank pages. A reviewer may open a pair and choose different page numbers in the existing overlay.

The overview uses the reader-owned PDFs and the existing local raster comparison worker. Each common canvas is limited to two million pixels at a shared physical scale. A run is limited to 50 pairs, 60 million compared pixels, and two minutes; each pair has a 45-second ceiling. A document overview contains at most 300 page pairs. Larger sources disclose unscanned pages. Results contain small numerical summaries, not page images or text. Completed summaries can be resumed only for the same exact sources, page counts, and sensitivity in the current session. Changing sources or sensitivity starts a fresh overview.

An unavailable pair is a coverage gap. Cancellation or a run budget keeps completed summaries and explicitly marks the remainder as unscanned. The detail overlay and overview scan do not run concurrently. No overview state is written to Arena or automatically downloaded.

## Verification and open gates

Run focused behavioral tests, then `npm run check`, the supported production build, and extension packaging. Use the supported browser Preview for real PDF/Word/STEP workflow regression and visual inspection. Keep the existing private Site audience.

The environment's browser policy rejected `chrome://extensions/` and prohibits alternate routes around that restriction. The actual installed-extension gate therefore remains open; package verification and hosted browser checks cannot replace it. Real Arena MCP discovery, its OAuth/file-delivery contract, actual attachment launch, two-user permission checks, and revocation still require vendor access. This phase does not enable shared review writes through a read-only MCP service.

Final results and any changes to this plan will be recorded in `release-05-qa.md`.

## Delivered

All scoped 0.5 workstreams are implemented. Independent follow-up review added post-worker source validation, allowlisted resume summaries, and cooperative PDF page cleanup to keep the new document-wide workflow consistent with exact identity and memory limits. The full check passed **525 tests across 45 files**, TypeScript and the production build passed, and the emitted extension is **0.5.0 / 275 files / 6.70 MiB**. The observed browser workflows, downloaded runtime report, package checksum and remaining gates are recorded in [release-05-qa.md](release-05-qa.md).
