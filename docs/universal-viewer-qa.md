# Universal viewer quality check

Completed November 11, 2026 for the document-focused update to Review Studio. This record describes the synthetic Preview application and the checks actually performed. The existing Site keeps its private audience.

## Outcome

Documents, 3D, and Together are peer workspace views. A document launch opens the full document reader; a STEP launch opens the model workspace. The file navigator, notes, and details are available on demand. Comparison is part of the document workspace rather than a modal over an assembly.

**TypeScript and 93 tests across 12 test files passed. The production application and portable source ZIP built successfully.** The dependency lockfile is unchanged. Publication status is confirmed by the native deployment result in the handoff.

Document-first workspace (historical screenshot omitted from this source export)

## Implemented review behavior

| Area | Behavior |
| --- | --- |
| Universal layout | Documents, 3D, and Together have equal navigation priority. The active content determines its tools. The BOM and model tools are absent from the primary document reader. |
| File navigation | Search by file, type, item identity, or part number. Files are grouped by their owning item. Other revisions are explicitly labelled without assuming revision labels have chronological ordering. |
| Revision review | Confirmed same-item, same-format document families can pair automatically when there is exactly one alternative. Ambiguous or unrelated files require a deliberate baseline choice. |
| Source highlights | Both actual source editions render. Extracted blocks with differences are highlighted as removed or added. The current change is outlined. |
| Word redlines | Aligned modifications show removed and inserted words, preserving numbers, tolerances, punctuation, and units. The continuous Redline view provides a reading list of changes. |
| Reader tools | PDF and browser-reflowed DOCX page navigation, zoom/fit, text search, next/previous matching passage, and next/previous change. Paired documents can link page and relative scroll navigation. |
| Notes | Comments remain editable drafts until explicitly posted. Removed-text suggestions point to the baseline; added/modified requirements point to the opened file. Page and quote are retained; point coordinates are only recorded when known. |
| Continuity | Switching to 3D and back keeps the current reader session mounted, preserving page, zoom, search, and comparison detail state. Saved views retain workspace layout and source/model settings, not all transient reader state. |
| Related content | Together gives the document and model comparable space. Its divider supports pointer and keyboard resizing. Opening it from a part document highlights matching component occurrences. Optional follow-selection opens the selected BOM item's exact document. |
| Launch boundary | Preview resolves exact file/item/revision context and rejects unknown, conflicting, or ambiguous sources. Arena mode remains an explicit unconfigured state and never substitutes Preview data. |

Automatic revision comparison (historical screenshot omitted from this source export)

## Browser checks observed

| Workflow | Observed result |
| --- | --- |
| Default launch | Revision B PDF opened in Documents, with a file navigator and no 3D canvas. The document text rendered from the actual fixture. |
| Direct Word launch | `fileId=atlas-spec-B-docx` opened the requested Word document as primary content. |
| Direct STEP launch | `fileId=step:assembly:B` opened 3D. Selecting Word from Files opened that exact Word source rather than a default PDF. |
| PDF comparison | Actual A/B specification PDFs produced **19 changes**. Next-change navigation outlined matching source blocks and displayed the **120 → 136 mm** and **125.0 → 140.0 mm** redlines. |
| Word comparison | Actual A/B DOCX renderings produced **13 changes**, including changed table requirements. |
| Full redline view | Removed and added content appeared with strikeout and insertion styling. Source-page links and draft-note controls were present for each change. |
| Word search | Searching `sensor` returned three matching passages. Navigating to the third result selected the requirement on browser page two. |
| Reading continuity | Visiting 3D and returning preserved the Word search `sensor` and page two. |
| Linked page navigation | Moving the baseline Word document to page two also moved the opened edition's page control to two. Both actual pages displayed. |
| Removed-text note | A removed baseline requirement generated an editable draft, then an explicit post recorded **assembly A / item A / edition 1 / page 1**. Locating the note opened the baseline PDF. |
| Typed child-document note | A note typed while reading the mounting drawing used a document anchor with the child file's source. After switching to Word, Show referenced document reopened the drawing without a source-validation error. |
| No invented point location | File-level notes no longer create a marker at the center of a page. Page/quote-only anchors locate text or a page without fabricating point coordinates. |
| Together | The drawing and actual STEP-derived assembly rendered side by side; PLT-1001 was selected. The source retained its own revision and edition. |
| Bounds and divider | The selected base displayed **180.0 × 136.0 × 8.0 mm**. The keyboard divider moved the document share from **50% to 55%**. |
| Follow BOM selection | Selecting the gearbox opened its revision A inspection PDF inside assembly B. Selecting the motor replaced the previous document with an empty document state. |
| Saved document view | Saved a document comparison, switched to 3D, and restored it. Documents and the comparison workspace returned with the navigator/inspector state. |
| Missing source | A launch with `fileId=missing-file` displayed an explicit unavailable-source message and did not render another source. |
| Arena launch | A request with Arena workspace/item/file context showed the unconfigured connection screen, with an explicit action to open samples. |
| Compact layout | Desktop and approximately **1,085, 448, and 334 CSS-pixel content widths** were checked using normal Chrome zoom. The narrow comparison/redline layout remained horizontally contained and its lower controls remained reachable after a clipping fix. |

Document and model reviewed together (historical screenshot omitted from this source export)

The browser notes and saved view created during QA remain local to that testing origin. They do not publish as shared review records or change the fixture files. Browser metadata errors from the test environment's extension were present; they were not presented as application errors.

## Concrete defects found and corrected during integration

- A file selected from an initially empty model launch could be overwritten by the layout's fallback PDF selection. The exact chosen file now wins.
- Typed document notes previously combined document source metadata with a general assembly anchor. They now use a document anchor and resolve correctly.
- Removed-text drafts initially referred to the opened revision. They now carry the baseline source and precise page/quote metadata.
- Entering document comparison from Together bypassed camera capture. It now preserves the model camera before the model unmounts.
- Selecting a BOM row or model finding while comparing documents could leave two comparison panes squeezed beside 3D. Those transitions now return to a single document in Together.
- Old saved views could restore an unintended document or an open notes panel. Legacy reference panels map to Together; model-only layouts remain model-only.
- Hidden document panes could trigger zero-width re-renders. The reader ignores zero-width observations and keeps its session state.
- At narrow widths, a minimum-height comparison could extend below a clipped workspace. The narrow shell now permits enough height and page scrolling to reach all controls.

## Comparison scope and remaining integration work

The comparison engine is deterministic and operates on extracted text. It does not classify formatting-only edits, drawing geometry, images, or scanned pages. PDF extraction can combine neighboring labels or split a paragraph at line breaks; changed wrapping or extraction order can therefore appear as additions/removals. The bounded engine reports when limits affect completeness. Its highlights are review aids, not a certification that two documents are equivalent.

Word documents are browser-reflowed DOCX. Pagination and styling can differ from Microsoft Word. Binary `.doc` conversion, OCR, native tracked-change editing, and rewriting original attachments are not implemented.

Saved views currently serialize the workspace/document-comparison mode and model/source state. They do not serialize every search, page, zoom level, selected redline, or arbitrary baseline selection. Those reader settings persist only while the mounted session remains open.

**Historical note:** The paragraph above describes the November 11 document-focused build. The subsequent [Regression audit](regression-audit.md) adds exact document and selected-baseline edition/hash references to saved views, including explicit empty baseline selection. Page/search/zoom and selected redline remain transient reader state; the earlier test counts and observations in this record have not been rewritten.

The cloud browser used Software 3D because WebGL2 was unavailable. The accelerated renderer, real touch devices, large customer models, and representative customer exports need separate acceptance checks. The updated Chrome options demonstrate Preview launches; actual Arena attachment-click interception, authenticated live file access, workspace permissions, and shared review persistence remain integration work.

See [the test guide](test-guide.md), [Arena integration boundary](arena-integration.md), and [earlier verification](verification.md) for the broader acceptance scope.
