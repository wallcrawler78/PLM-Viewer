# Specialist capability and quality audit

This audit covers the existing Review Studio prototype and its user-bound Arena MCP integration boundary. Three specialists reviewed documents, geometry and performance, and MCP/session behavior. The integration specialist then independently reviewed the document rendering changes; the geometry specialist independently reviewed the workspace changes. The parent checked the combined application in Chrome and resolved integration regressions before packaging.

The checks use synthetic Preview sources and controlled response fixtures. They do not establish production Arena connectivity or hardware WebGL performance.

## Findings addressed

| Area | Finding | Implemented correction |
| --- | --- | --- |
| Word rendering | Attachment-provided hyperlink targets and symbol text reached the renderer without an explicit policy | Validate Word symbol encodings before rendering; allow supported external links and source-local bookmarks; remove executable and unsupported targets before insertion |
| Word resource isolation | VML/SVG resource attributes and global embedded font families could escape the intended pane policy | Check graphic resource attributes; namespace embedded font definitions and references per source; restrict generated styles and active markup |
| Word image regression | Generic MIME types from embedded ZIP images were rejected by the new policy | Recognize supported image signatures and normalize their image MIME types; retain unknown-format rejection |
| PDF resilience | Failure to build the text layer hid an already-rendered PDF page | Keep the rendered image visible, clear partial text, and report the text-selection limitation |
| PDF memory | Zoom and device scale could allocate very large canvas backing stores in both comparison panes | Limit each page raster to 8 million pixels and an 8,192-pixel edge, retaining displayed page dimensions and annotation coordinates |
| Document-first startup | PDF-only sessions also loaded the Word parser and 3D engine | Defer Word code until a DOCX opens and defer the model engine until 3D/Together opens |
| Lazy model regression | Deferred viewport CSS changed cascade order and expanded the Software 3D badge over the canvas | Keep the small viewport stylesheet before the workspace overrides in the main stylesheet order |
| Model load failure | A failed model module could interrupt the whole workspace | Add a model-local error boundary with Return to documents and Reload workspace actions; retain draft guidance |
| File navigation | Repeated scans of all attachments/parts increased work, and an older configuration could supply the displayed item name | Index names, identities and duplicate filenames once; prefer the current configuration; group in one pass and retain exact selected editions |
| Compact layouts | The navigator could cover the initial document; paired Word pages became too cramped | Start with the navigator collapsed at compact widths, close it after selection, and stack compared documents below a 720px document-container width |
| Pane resizing | Abandoned pointer listeners and other touch pointers could continue or terminate a resize | Scope the drag to its initiating pointer; release capture and cancel listeners on release, cancellation, lost capture, blur, source/view changes and unmount |
| 3D rendering | Unchanged frames and unchanged overlays repeated rendering/allocation work | Skip scene draws until invalidated; retain unchanged bounding, measurement and annotation resources |
| Geometry lifecycle | Obsolete loads and unused cached assets could persist across source changes | Abort unused/obsolete loads, release assets after their final occurrence unloads, clear old source geometry/bounds immediately, and prevent late publication |
| Bounds correctness | Failed models could contribute bounds; mesh bounds could be described as CAD-derived | Derive scene bounds from successfully loaded sources and label CAD envelopes separately from approximate mesh envelopes |
| Section range | A fixed range assumed models were near the origin; equivalent Reset/Load-all arrays could clear bounds without reloading geometry | Derive limits from prepared full-scene bounds, center newly enabled/changed axes, wait for prepared bounds, and invalidate on source values rather than array identity |
| Disposal | Directional-light shadow render targets were not explicitly released | Dispose shadow resources and make repeated engine disposal safe |
| MCP/auth responses | Header completion ended the auth timeout, and declared metadata length could understate streamed bytes | Keep deadlines through body consumption and bound actual stream bytes with incremental UTF-8 decoding |
| Access denial | A stalled 403 detail body could delay clearing protected panes indefinitely | Limit optional eligibility detail to 4 KiB and one second, then handle denial; cancel rejected bodies without awaiting a stalled cancel hook |
| Chrome launcher | Context-menu visibility omitted Arena application domains | Add the exact HTTPS application hosts listed on Arena's official service-status page, without adding content-script permissions or inventing attachment routes |

## Automated verification

`npm run check` completed successfully: **291 tests passed across 28 test files**, including the TypeScript project check. The prior published baseline had 253 tests across 23 files. The added checks exercise concrete rendering policies, response deadlines/size bounds, extension hosts, file-source grouping, section ranges, and geometry lifecycle regressions.

`git diff --check` passed. A focused source search found no `TODO`, `FIXME`, `stub`, `NotImplemented`, or `coming soon` markers in application, server, or extension code. This is supplementary evidence; reviewed configuration seams and explicit unsupported operations remain documented below.

The production build passed using the Sites build helper, which ran `npm run build`. The initial JavaScript entry changed from 1,478.14 kB (416.20 kB gzip) in the preceding build to **775.63 kB (232.88 kB gzip)**. This is a 47.5% raw-entry reduction and a 44.0% gzip-entry reduction. Separate deferred chunks contain the model engine (539.92 kB; 137.68 kB gzip) and Word renderer (173.26 kB; 50.80 kB gzip). The PDF worker remains a separate 1,031.81 kB asset. These are build artifact sizes, not a claimed page-load-time or total-download improvement; opening the relevant content still loads its engine.

The rendering scheduling tests use a mocked GPU adapter with real geometry and interaction logic. They verify that unchanged frames do not cause additional scene draws and that camera/scene/resize/context restoration invalidate correctly. They are not hardware frame-rate benchmarks.

## Browser verification

| Workflow | Observed result |
| --- | --- |
| PDF revision review | Exact A/B files, 19 text changes, next-change navigation, linked page 2, search for sensor, zoom/Fit, and continuous redline view worked |
| Word revision review | Exact A/B DOCX files rendered as two browser pages and produced 13 text changes |
| Embedded Word content | A separate synthetic image/symbol/link fixture rendered its 640 × 240 PNG and valid symbol; its bookmark moved page 1 → 2 within the source pane |
| Word external link policy | The supported external link retained a new-tab target, `noopener noreferrer`, and no-referrer policy; no external link was followed for the test |
| Compact document access | A 390px test viewport displayed the document without the navigator covering it; opening Word through the picker closed the picker and retained the source identity |
| Compact revision comparison | At 680px the two Word sources stacked into readable full-width panes; the 390px body had no horizontal overflow |
| Saved views | A named PDF comparison view saved and restored its exact A/B source pair and Documents layout after visiting 3D |
| Review drafts | A change generated an editable source-bound note; a second suggestion did not replace it; changing layout retained the draft |
| Model source selection | BOM selection highlighted the mounting plate; B plate bounds read 180 × 136 × 8 mm |
| Model display tools | Selection opacity, isolation and Reset restored the expected visible set; Section remained usable after Reset and centered at Z = 36 mm for the full assembly |
| Model measurement | Two visible surface points produced an approximate 120.0 mm result; the result remained after Documents → 3D |
| Revision overlay | Baseline and current transparency controls changed independently; bounds explicitly identified the current revision selection |
| Model load recovery | A deliberate child-render failure in a temporary harness displayed the local recovery panel while the document remained available; Return to documents worked |
| Pane resizing | Two Right-arrow presses changed the document/model divider from 50% to 60%; a pointer drag independently changed it from 50% to 58% |

Temporary responsive and document test harnesses are removed before packaging. They are not product routes or source-download content. Browser checks used **Software 3D** because the cloud browser did not provide WebGL2.

## Capability boundaries reviewed

| Capability | Current status | What remains |
| --- | --- | --- |
| PDF/DOCX viewing, text comparison, model overlay, local comments and views | Working Preview behavior with real synthetic files | Representative customer-file acceptance and larger data sets |
| Arena MCP metadata/files/BOMs/supplier items | Implemented user-bound server/provider contract and browser loader | Registered OAuth client, verified Arena tool mappings, allowed deployment origins, production session store, and the separately hosted BFF |
| Hosted application | Private static Preview | It does not host the Node BFF or a real Arena OAuth callback |
| Chrome launch | Context-menu/action launcher carries explicit source context | Validate actual attachment-click interception against Arena's supported UI/routes |
| Arbitrary STEP | Viewer consumes meshes converted from genuine STEP files | Production conversion pipeline, retained exact geometry and representative import testing |
| Exact CAD measurement | Approximate mesh points and assembled bound envelopes are labelled | Exact face/edge/B-rep metrology |
| Legacy `.doc` | Explicitly unavailable without conversion | Server conversion/rendering path |
| PDF/Word change detection | Extracted text and manual visual review | OCR, formatting/image/drawing classification, and native Word tracked-change editing |
| Shared collaboration | Preview comments and views are browser-local; live writes remain disabled | Authenticated shared storage, concurrency, audit lifecycle and access rules |
| Arena hidden JSON review field | Design option only | Verify capacity, permissions, revision lifecycle and concurrency; a hidden field is not an access-control boundary |
| Large assemblies and graphics | Bounded asset validation, cancellation, demand-driven drawing and software fallback | Hardware WebGL visual acceptance and representative memory/latency benchmarks |

The document policy protects the implemented rendering path. It is not a general Office-content sandbox or a promise that every Word graphic/font format is supported. Original source files are not rewritten.

## Evidence

- PDF revision comparison (historical screenshot omitted from this source export)
- Embedded Word image and symbol (historical screenshot omitted from this source export)
- Model revision overlay and source-specific bounds (historical screenshot omitted from this source export)
- Compact Word comparison (historical screenshot omitted from this source export)
- [Repeatable acceptance guide](test-guide.md)
- [Arena MCP setup](arena-mcp-setup.md)
- [Previous MCP readiness checks](mcp-readiness-qa.md)

Arena application-host reference: <https://statuspage.arenasolutions.com/>.
