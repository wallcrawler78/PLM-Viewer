# Local runtime qualification

The viewer includes a user-initiated **Local runtime checks** page for deployment and browser testing. It runs real bundled fixtures through the local engines. It does not use an Arena connection, customer attachment, conversion API, or AI service.

## Open and run

From **Workspace settings → Local tools & handoff → Local runtime checks**, open the diagnostic page in a new tab. This preserves the current review and any unsaved draft in its original tab. The diagnostic route is `?mode=preview&runtimeChecks=true` and mounts separately from workspace/Arena effects.

For extension qualification, load the built extension, open its **Options**, expand **Local runtime checks**, and choose **Open local runtime checks**. The screen must say **Chrome extension page** and show the extension version in its details. A hosted Preview screen cannot qualify the installed extension or its Manifest V3 policy.

Click **Run local checks**. No checks run just by opening the page. Results remain in memory; use **Download report** to save an optional JSON report. Cancel the run at any time. Retry starts a fresh run.

## What runs

| Check | Real operation | Passing evidence | Deadline |
| --- | --- | --- | --- |
| Packaged assets | Read the local runtime/fixture manifests, check application/dependency versions, hash the three fixed source files | Runtime versions agree and SHA-256 values match the bundled synthetic source manifest | 15 seconds |
| STEP import | Transfer the original `base-B.step` bytes to the packaged CAD worker and validate its imported arrays | Finite indexed geometry, source hash, millimeter units, and a 180 × 136 × 8 mm envelope within 0.05 mm | 45 seconds |
| PDF rendering | Create an explicitly owned native worker, open `atlas-spec-B.pdf`, extract page 1 text and render page 1 to a bounded canvas | Two pages, the expected 140.0 mm fixture text, and visible page pixels; fake-worker fallback cannot pass | 25 seconds |
| Word rendering | Validate the DOCX ZIP, parse and render `atlas-spec-B.docx`, validate parsed symbols, sanitize the output before insertion | Expected fixture text, page elements, and measurable page layout in an offscreen inert container | 25 seconds |
| 3D graphics | Try WebGL2; render a small Three.js box with the viewer's actual software renderer | WebGL2 availability is reported separately; the software canvas must contain visible model pixels | 10 seconds |

The asset check verifies source bytes against a manifest in the same package. This checks consistency; it is not a signed supply-chain attestation. The runtime/version manifest and real engine checks are complementary. The fixture set does not exercise every auxiliary PDF font, character map, or image codec.

Source paths are a fixed inventory. No launch parameter or manifest URL can make these checks fetch arbitrary files. Fetches are bounded, omit credentials, reject redirects, and use package-local fixture/vendor paths. The PDF worker path is checked against the page's protocol and host, including `chrome-extension:` origins. STEP uses the existing packaged worker/CAD runtime.

Since 0.5, the ordinary PDF reader and this check share `createLocalPdfWorker()`, including explicit native worker ownership and disposal. This removes the previous difference between diagnostics and the reader's implicit worker startup. Both still need testing on an installed extension origin.

## Ownership, cancellation, and limits

Checks run sequentially. Each has its own cancellation signal and deadline. Cancel or navigation aborts outstanding reads and owned workers, cancels PDF page rendering, and prevents later checks from starting. A failed assets check makes the dependent fixture checks unavailable rather than inventing a pass; the graphics capability check can still run.

STEP workers terminate after import. The PDF worker is explicitly terminated; its loading/render tasks are destroyed/cancelled and the canvas is reset. The Word stage is removed and cleared, including a late async completion after cancellation. Temporary source buffers are released when consumed or when the run ends. The software model's geometry/material/canvas are disposed/reset, and a temporary WebGL context is released where supported. Download object URLs are revoked.

Asynchronous deadlines cannot forcibly interrupt a synchronous browser operation. DOCX rendering uses the main thread and has no native cancellation API; a late result stays detached and is cleared. Garbage collection is browser controlled. These are small synthetic fixtures, not large-file performance or arbitrary-document safety qualification.

## Report and interpretation

The report uses a closed, versioned schema. It includes application/dependency versions, extension version only on an extension page, Chrome major version when available, timestamps, pass/fail/unavailable/cancelled statuses, durations, authored result codes, and bounded numeric fixture measurements. It excludes complete user agents, origin URLs, extension IDs, Arena identifiers, credentials, document content, arbitrary exception messages, and customer metadata. No report is saved or uploaded automatically.

`passed` means every included local check passed on the reported surface. `attention` means one or more checks failed, were unavailable, or did not complete. `cancelled` means the user/navigation cancelled the run. WebGL2 absence alone can still pass the graphics check when the actual software renderer succeeds; the report explicitly records both capabilities.

This page does not qualify live Arena permissions or routes, BOM placement correctness, every document layout, engineering accuracy, binary `.doc`, OCR, large assemblies, all browser policies, or shared collaboration. The installed extension, per-user Arena contract, representative production files, and the full product workflows retain their separate release gates.

## Verification

`tests/runtime-checks.test.ts` exercises route/source restrictions, actual bundled fixture hash verification and tampering, sequential work, deadline cancellation, stopping subsequent work after cancel, immutable updates, sanitized reports, and hosted/extension scope distinctions. Browser execution must additionally exercise the real workers, canvases, and DOCX layout. Record that observed result independently; unit tests do not qualify the installed extension.
