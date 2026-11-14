# Playground 0.8 test guide

This guide tests the **0.8.0 source/package** and its private [hosted Preview](https://arena-assembly-review.wallcrawler78.chatgpt.site/?mode=preview&playground=1). Use the hosted test site, a local build, or the generated Chrome package for the applicable steps. A hosted test does not qualify an installed extension.

## What has and has not been verified

| Evidence | Status |
| --- | --- |
| TypeScript and automated suite | Passed: `npm run check`, 704 tests in 59 test files. |
| Final application/extension packaging | Passed: `npm run build:extension` for 0.8.0, including packaged local STEP/PDF assets. |
| Generated Word report layout | Passed for the three-page test report after correcting a split table row and inspecting the rerender. This is report QA, not browser interaction evidence. |
| Playground browser layout and interaction | Pending. Automatic approval review blocked the attempted browser validation. |
| Installed Chrome package | Pending manual installation and runtime qualification. A successful build does not establish installed behavior. |
| Live AI provider | Not tested with an authenticated provider account. Synthetic gateway/client tests are separate evidence. |
| Live Arena reads or ECR creation | Actual tenant/source routes and ECR write bindings remain unverified. ECR creation in the UI is simulated. |
| Existing hosted results | Historical release evidence only; they do not qualify the new Playground. |

## Start the local application

Use Node.js 22 or newer and the committed lockfile. In the repository checkout:

```bash
npm ci
npm run check
npm run dev
```

Open the exact local URL printed by Vite. Select **Playground** beside Documents, 3D and Together. You can also append `?mode=preview&playground=1` to the local base URL to start there directly. Preview uses the included synthetic Atlas Drive Module and makes no Arena requests.

Leave AI configuration absent for the first test. An unavailable assistant is expected; the local scene, drawing tools, documents, proposal history and Preview ECR package must still work. Record Chrome version, operating system, viewport size and whether the stage shows **Software 3D** or uses WebGL2. Test the accelerated path on the target laptop; software-renderer results do not establish GPU performance.

Playground opens the current source-bound BOM workspace. **Open local test files** remains a separate universal-viewer workflow; selecting loose local files does not automatically associate them with the sample BOM or assign Arena item identities.

## Manual acceptance walkthrough

Record Pass, Fail or Blocked for each row, with the source/package version and any relevant screenshot or error. These are steps to run, not claims that they have already passed.

| Area | Action | Expected result |
| --- | --- | --- |
| Initial workspace | Open Playground and wait for source loading. | Source product/revision and separate proposal are visible; no blank placeholder replaces a failed source. |
| Component identity | Select a named item in the component list, then select a repeated occurrence in the model. | Selection identifies the occurrence. Moving one instance does not move every use of its part number. |
| Transform | Select a component, use Move/Rotate, and try numeric Position/Rotation fields followed by **Apply changes**. | Only the proposed installed pose changes. UI rotation values use degrees; stored scene rotations use XYZ radians and positions use millimeters. |
| Undo/Redo | Undo and redo a transform, concept addition and label edit. | The source baseline remains unchanged, and the proposed scene returns to the expected state. |
| Concept bracket | Choose **Add concept → Bracket with a hole**. Adjust width/depth/height, plate thickness, hole diameter and hole center, then apply. | The visual bracket updates; a hole outside the supported plate is rejected without losing the existing proposal. |
| Other concepts | Add a box/enclosure and cylinder; resize and rename them. | Each remains independently selectable and unnumbered. Box/cylinder controls do not claim unsupported hole tools. |
| Comparison | Switch Original, Proposed and Overlay. | Original shows the source configuration; Proposed shows accepted visual edits; Overlay compares them. The original STEP is unchanged. |
| Presentation | Explode, reassemble, hide/show, isolate, change opacity and toggle labels. | These alter display state. Reassembly returns components to their proposed installed positions, and display actions do not enter the product-change list as moves/removals. |
| Proposed removal | Use **Propose removing component**, inspect Changes, then restore it. | The proposed removal is distinct from hiding. The original component remains available in the baseline. |
| Source-file limits | Attempt a source or configuration that cannot be resolved. | The UI reports the problem without substituting another edition or Preview data for a live error. |

### Drawing and labels

| Area | Action | Expected result |
| --- | --- | --- |
| Arrow | Draw from the feature toward its intended destination; enter “Move hole here” in the label editor. | Both the visible arrow and editable text remain associated with the proposal. |
| Other tools | Draw a rectangle, ellipse, freehand stroke, note and pin. | Each can be selected, edited or deleted; Undo/Redo restores the intended markup change. |
| Camera hold | Draw a stroke while dragging across the model. | The camera does not orbit during drawing. Return to the selection/orbit tool for navigation. |
| View-only marks | Draw in empty space, then change camera or assembly presentation. | The mark is treated as saved-view intent, not an invented 3D point. Other-view feedback remains understandable. |
| Surface anchors | Draw using model surface hits, then rigidly move or explode that component. | Valid local surface anchors follow the component; the proposal's installed pose remains separate from explosion. |
| Changed shape | Capture a mark on a concept bracket, then alter the hole geometry. | An anchor tied to the previous shape is not silently presented as an equivalent point on the new geometry. |
| Captured intent | Select **Capture intent**, then edit/delete the live label or Undo a concept addition. | The saved intent image retains its original text and version. Historical unresolved anchors remain evidence, not active Arena mappings. |
| Resize | Resize the workspace after drawing. | Marks retain the intended normalized/page or projected relationship; inspect aspect handling and labels at the target laptop size. |

### Reference documents and retained universal tools

Open **Documents** inside Playground, choose a supplied PDF drawing and use the **PDF** markup target. Draw and label on a page, switch pages, return, then capture the intent. The mark must remain on its exact file revision, edition, hash and page. A different edition or page must not acquire it automatically.

Choose a Word attachment to verify reading and text search beside the model. Drawing overlays currently attach to PDF pages, not Word reflow. Return to the main **Documents**, **3D** and **Together** workspaces for the original universal review tools:

| Existing workflow | Regression check |
| --- | --- |
| PDF and DOCX readers | Open both formats, search for words, navigate matches/pages, zoom and fit. |
| Document revisions | Choose a baseline, use side-by-side and text redlines, navigate changes, and retain explicit incomplete-extraction notices. |
| PDF visual differences | Compare selected page pairs, scan the overview, pause/resume, inspect coverage and open a changed pair. |
| Model review | Select through BOM/model, inspect attributes, measure approximate point distances and bounds, hide/show, change opacity, section and explode. |
| Model revisions | Compare original source revisions in overlay and side-by-side. Playground's concept comparison does not replace these existing tools. |
| Multi-file review | Use Together for a model and its specification/drawing, resize panes and return to document reading. |
| Local files | Open STEP/STP, PDF and DOCX with **Open local test files**, choose explicit comparison baselines, then close the session. |
| Notes, views and preferences | Verify existing Preview notes, saved views, document defaults and rendering preferences continue to work. |

Legacy binary `.doc`, scanned-page OCR, exact CAD feature editing, manufacturing validation and automatic semantic registration of revision pages remain outside the prototype.

## Test the six-step ECR flow

| Step | Action | Expected evidence |
| --- | --- | --- |
| 1. Open | Select **Create ECR** in Playground. | A focused dialog opens; Escape/Cancel returns to the workspace. |
| 2. Describe | Enter a title and a useful change description. | Empty required descriptions are caught; an error or retry does not erase entered text. |
| 3. Affected items | Review initially selected items in view. Toggle an item, inspect other source items, optionally include the parent. | Repeated occurrences are deduplicated by item/revision with occurrence traceability. Unnumbered concepts appear in the report, not as invented Arena items. |
| 4. Evidence | Keep a marked intent capture, then create the preview request. | The proposed configuration is captured from the actual local scene. Up to two original intent images are included. If current markups have no usable image, the dialog asks for a marked view instead of treating a blank scene as markup evidence. |
| 5. Description file | Download and open `change-summary.docx`; inspect all pages and images. | The document contains the entered description, affected items, changes, assumptions and embedded design/intent images. Old captured labels remain even if their live annotations were deleted. This is a generated Word attachment, not an automatic PDF conversion. |
| 6. Result | Inspect the receipt and download the review ZIP if desired. | A **PREVIEW-ECR-…** receipt clearly says no Arena record was written. No fabricated Arena link appears. The ZIP contains the Word report, images, proposal manifest, creation receipt and README. |

Captured view limits are three images, up to 2 MiB each, within a 12 MiB review payload. Original STEP/PDF/DOCX source attachments are excluded. The user explicitly chooses downloads; preparing a request does not automatically write copies to the Downloads folder.

If preparation fails, keep the dialog open, correct the reported issue and retry. The same prepared content uses idempotent preview creation. Canceling preparation must not produce a misleading success message. A live Arena URL is a future result of authorized creation plus readback, not a Preview feature.

## Draft retention and recovery

Preview proposal drafts are browser-local and bound to the exact source configuration. Change a proposal, allow the save indicator to settle, reload the same Preview source and verify its state. Export proposal JSON, then open it against the same source; a different source/configuration must be rejected. Imports replace the open proposal deliberately and clear session-only captured evidence.

Test browser storage denial/quota or a second-tab save conflict using a dedicated test profile. A failed save must retain the open draft and preserve the previous stored value. Use **Export draft** to keep session work. **Recover saved data** offers the original stored bytes; it does not silently overwrite corrupt data.

Live Arena proposals remain session drafts. Captured intent images and simulated ECR receipts are not restored by draft autosave; download the review package to retain that evidence. Returning among the viewer tabs is distinct from closing/reloading the browser session.

## Install and test the Chrome package

Build the actual package:

```bash
npm run build:extension
```

1. Open `chrome://extensions` in the user's authorized Chrome profile and enable **Developer mode**.
2. Choose **Load unpacked** and select `build/extension/`. If using `dist/developer/review-studio-extension.zip`, extract it first and select the folder containing `manifest.json`. Do not load the repository's incomplete `extension/` source folder.
3. Open the extension toolbar and confirm the bundled viewer runs at a `chrome-extension://` origin. Confirm version **0.8.0** in extension details.
4. Open Options, then **Local runtime checks**. Run the checks and retain the report with its execution surface, graphics mode and package version.
5. Repeat the scene, markup, document and ECR walkthrough above in that installed tab. Verify packaged workers, fonts and WASM load without a runtime CDN.
6. Verify the assistant reports its unavailable extension transport. Do not put an API key in extension settings or weaken the package CSP to make that message disappear.
7. After a rebuild, reload the extension card and reopen/reload its viewer tabs before recording results.

The computer running Chrome must have access to the generated package folder; a path on a remote build machine is not automatically available locally. If installation or the approved browser workflow is blocked, record the restriction and leave the gate pending. Do not claim that a hosted test or static package check installed the extension.

## Optional AI test in local web development

Use [the AI connection setup](playground-ai.md#local-development-configuration) only with an approved provider account and server-side key. The example `.env.local` is ignored by Git; never use a `VITE_` variable for a secret. The configured allowed origin must exactly match the Vite URL/port. A static production preview server and the installed extension do not provide the development AI gateway.

| Check | Expected behavior |
| --- | --- |
| No configuration | Status is unavailable; local tools still work. |
| Configured prompt | Select a component and request a simple move. Review the returned operations before **Apply suggestion**. |
| Display request | Ask for an exploded, labeled view. Display instructions must not become installed component moves in the change list. |
| Explicit PDF image | Open a marked PDF page and opt into sharing that page for a prompt. A supported concept suggestion retains assumptions; missing dimensions should not be silently invented as verified measurements. |
| Screenshot permission | With image sharing disabled on the server, no image request is sent. With it enabled, the user still opts in per prompt. |
| Stale/canceled request | Cancel a request or edit the proposal before applying its response. No partial or stale transaction should alter the current proposal. |
| Dictation | Start/stop the microphone, inspect and edit the transcript, then submit explicitly. Dictation alone must not send a prompt or create an ECR. |

Browser speech recognition may use the browser vendor's speech service and may be unavailable. It is not an offline guarantee; typed instructions remain available. No live AI trial has been performed for this release.

## Arena testing when access is available

Preview never proves Arena connectivity. Use the existing [Arena MCP setup](arena-mcp-setup.md) and [preflight](arena-preflight.md) for authorized reads. Verify exact attachments, BOM placements, attributes, source expiry and at least two real permission profiles before claiming live readiness.

Live ECR creation additionally requires verified MCP write tools, per-user create/affected-item/attachment permissions, an approved durable retry journal and record/attachment/URL readback. The supplied ECR orchestration seam is unmounted and uses synthetic test bindings. It neither submits an ECR nor changes its approval state. The current Chrome live-launch path opens a separately configured authenticated hosted viewer/BFF; direct extension-to-MCP access and actual tenant click routes remain unverified.

## Record a result

| Field | Record |
| --- | --- |
| Source commit and package version | Exact commit, 0.8.0 package/checksum |
| Execution surface | Local Vite, static build, or installed extension |
| Browser/environment | Chrome version, OS, GPU/render mode, viewport |
| Scenario | Row or workflow from this guide |
| Outcome | Pass, Fail or Blocked, with observed behavior |
| Evidence | Relevant screenshot, runtime report or artifact; remove credentials/private source content before sharing publicly |
| Live services | Which approved provider/tenant was actually called, or “none” |

Keep browser/install outcomes separate from automated tests, Word layout inspection and historical hosted results.
