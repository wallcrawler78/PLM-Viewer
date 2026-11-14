# Version 0.7 verification

Date: 2026-11-14. Starting source: `f703a3c20641f0bdac2c6af3458d937dc508b0a0` (0.6.0). Scope: [performance and preferences plan](release-07-plan.md), including the user's follow-up request for document text search.

## Result

The bounded implementation is complete. The final logic check passed **614 tests across 50 files**, TypeScript passed, the production build passed, and the complete Manifest V3 package passed its resource/policy validator. Managed Chrome Preview checks exercised the real local text worker, PDF/DOCX search, preference persistence and precedence, PDF resizing, and local STEP display. No Arena connection or external AI/conversion service was used.

This is prototype verification on original synthetic files. It is not installed-Chrome, WebGL2, large-company-file, or live-Arena qualification. Those limits remain explicit below.

## Automated and package evidence

| Check | Actual result |
| --- | --- |
| `npm run check` | Passed: TypeScript project build and 614/614 tests in 50/50 files. This includes the final search logic and dialog keyboard fix. |
| Supported production build | Passed through the Sites build helper (`npm run build`, including asset preparation, TypeScript, Vite and portable source packaging). Rebuilt after the final four-pixel search-status spacing adjustment. |
| Complete extension package | Passed `node scripts/build-extension.mjs`: 276 files, about 6.70 MiB. Local imports, worker/assets, pinned runtime manifests and strict resource policy were validated. |
| New text worker | Emitted as `assets/text-comparison.worker-22hT79vK.js` (about 9.12 kB uncompressed); present in the extension ZIP. Browser Preview also ran the actual worker through PDF and Word comparisons. |
| Source/whitespace check | `git diff --check` passed. Documentation and screenshot additions were included when regenerating the portable source archive. |
| Specialist review | Separate document, model and preferences reviews; model reviewer independently checked document-worker lifetime and search source/keyboard boundaries. No remaining blocker was reported in those reviewed paths. |

The final extension's exact size and SHA-256 are recorded in `extension-package.json` (historical raw report omitted from this source export). Its SHA-256 is `a0879ce01ff4aab6e69fc223c9b176256f03fbaf0498d612b7c83cdc09e3d275`. The original prototype archive retains this record. This public source export omits historical raw QA reports.

Focused coverage includes exact-source and request ownership; timeout/error/abort cleanup, including falsy abort reasons; malformed/omitted worker results; partial comparison accounting; PDF resize bursts/hide/dispose; opaque item/revision lookup; 600 repeated placements; callback-only model updates; asynchronous visibility; quality/bounds/picking preservation; storage corruption/newer versions/quota/session fallback/reset isolation; normalized search and honest partial/scanned statuses.

## Browser observations

The browser used the supported managed Preview URL `http://127.0.0.1:4173/`. It displayed **Software 3D**; these observations do not qualify the accelerated graphics path. The current page was inspected after actions, and screenshots were captured from the actual browser.

| Workflow | Observed outcome |
| --- | --- |
| Four saved defaults | Set Text redline, unlinked scrolling, source highlights off and Economy. Reloaded and reopened Settings: all four choices remained. |
| PDF comparison defaults | New PDF comparison opened Redline through the local worker and produced the existing 19 changes. Switching to source pages showed linked scrolling/highlights both off. |
| Active-pair precedence | Changed saved defaults to Side by side with linked scrolling/highlights on. The open PDF pair remained in Redline, retained 19 changes and kept page 2 plus its existing off/off toolbar choices when returning to source pages. |
| Next Word comparison | Newly opened DOCX pair used Side by side and on/on defaults, produced the existing 13 changes, and next-change navigation advanced to Change 2. |
| Preference reset | Reset returned the stored defaults to Side by side and Standard; the subsequent local dialog also showed linked scrolling and highlights on. The Preview still had its two open notes. Other-key/saved-view reset isolation is covered by store tests; there were no saved views in this browser test session. |
| Together resize | Keyboard divider changes moved the document ratio from 50% to 55%; the final PDF raster/text was readable and aligned beside the model. |
| Main model continuity | The real STEP assembly rendered locally in software mode. Bounds showed 212.0 × 136.0 × 84.0 mm. Bounds, section toggle and explosion/reset controls responded after quality/default changes. |
| Local-file preferences | Opened original `base-B.step` and `atlas-spec-B.pdf` together. After changing quality in the new local dialog, both files remained, PDF page 2 remained, and the local mesh envelope remained 180.00 × 136.00 × 8.00 mm. |
| Modal keyboard fix | Browser QA found that native Tab could leave the dialog controls. Added explicit boundary wrapping; verified Tab from Reset reaches Close, Shift+Tab from Close reaches Reset, and Escape returns focus to the preferences trigger. |
| PDF visual comparison | Selected page 1 still reported eight regions, 1.18% changed pixels and 108 dpi at Standard sensitivity while Economy graphics was selected. The graphics preference did not alter this comparison's resolution. The full overview was not requalified in this round. |
| PDF text search | `DATUM` produced five matching passages. Enter/Shift+Enter and previous-result wrap worked; the last result navigated to and highlighted a passage on source page 2. The final UI labels this `Passage 5 of 5`. |
| Word text search | `ASSEMBLY` produced five matching passages and wrapped to browser page 2. `Inspection    AND review requirements` found the page-2 heading, despite case and repeated-space differences. |
| Search shortcuts and closing | Ctrl+F from the focused PDF/Word reader opened the local search. Enter advanced and Shift+Enter reversed. X, Escape and toggling Find off cleared the query and restored focus to Find. The complete no-result case displayed `No matching passages`. Cmd+F recognition is covered by the helper tests/source review; this browser run exercised Control. |
| Independent revision search | Baseline query `Maximum` showed one passage while current query `DATUM` showed five. Repeated Ctrl+F refocused the current pane's search. Escape closed only that search; the baseline query and comparison remained open, with 19 redline changes. |
| Different source | Opening the DOCX after searching the PDF started with an empty query. No prior source's search result was reused. |
| Search layout | The status uses a wrapped line below the field. Final DOM measurement confirmed a four-pixel gap below the input; the highlighted Word heading and result count remained visible. |

The latest inspected 100 warning/error log entries contained only the known browser-automation extension's metadata messages after filtering by their extension origin; no application warning/error appeared in that returned set. This is a bounded log observation, not a claim about every possible browser session.

## Captured views

| Evidence | View |
| --- | --- |
| Workspace preferences (historical screenshot omitted from this source export) | Saved defaults after reload |
| Local preferences (historical screenshot omitted from this source export) | Same controls with a local STEP/PDF still open |
| PDF redlines (historical screenshot omitted from this source export) | 19 local text changes |
| Word comparison (historical screenshot omitted from this source export) | Side-by-side sources and 13 changes |
| Together after resize (historical screenshot omitted from this source export) | Readable PDF, STEP and assembly bounds |
| PDF search (historical screenshot omitted from this source export) | Fifth matching passage on page 2 |
| Word search (historical screenshot omitted from this source export) | Normalized phrase search highlights the page-2 heading |

## Performance evidence and remaining work

The controlled text algorithm benchmark returned 125 changes without truncation in **509, 448 and 566 ms** (median **509 ms**) for 125 synthetic blocks per revision, approximately 383k characters each. This is synchronous Node computation, not a browser or customer-document benchmark. Worker offloading removes that alignment from the UI thread; it does not promise a faster algorithm or zero main-thread work. See the raw benchmark (historical raw report omitted from this source export).

The model regression observed zero render submissions and zero transformed-bound calculations for 20 callback/label-only updates, then a redraw for a real selection change. Software quality tests verified 1200 × 900 versus 800 × 600 backing rasters for an 800 × 600 CSS viewport at device ratio 2, with source reuse, bounds and picking preserved. These are controlled engine-test results, not hardware FPS benchmarks.

See [performance review](performance-review.md) for prioritized virtualization, document-handle/index lifetime work, repeated assembly import batching, progressive model insertion, software scratch-buffer reuse, picking and idle scheduling. See [preference roadmap](user-preferences.md) for units/precision, schema-scoped columns, CAD navigation, fit policies and account scope.

## Qualification boundaries

| Gate | Status |
| --- | --- |
| Installed Manifest V3 execution | Pending. Prior browser automation access to `chrome://extensions/` was rejected; no alternate route or installation was attempted. The package validator checks distribution resources/policy but does not execute the extension. |
| New text worker under installed extension CSP | Pending as part of actual installed PDF/Word comparison. The existing Local runtime checks inventory does not include text comparison. Hosted worker success is separate evidence. |
| GPU and representative workloads | Pending WebGL2, high-DPI hardware, large assemblies/documents, multiple tabs and repeated-session memory profiling. Current caps are protection limits, not supported performance tiers. |
| Live Arena | Not exercised. Vendor mappings, OAuth/MCP operation, exact document delivery, permissions, supplier/BOM retrieval, latency and throttling require the real configured service. No credentials or live records were used. |
| Search limitations | Searchable extracted text only; no OCR. Matches/counts refer to passages, and phrases do not span independent extracted blocks. Legacy `.doc` still needs a supported PDF/DOCX rendition. |
| Shared/account behavior | Preferences are local to one browser profile/origin. They are not account-synchronized, and this work does not add shared review writes. |

Publication is performed through the existing private Site workflow with the final pushed source and matching archive; the deployment result and source commit belong in the release handoff. The private Preview remains a static app, not a deployed Arena BFF/OAuth service.
