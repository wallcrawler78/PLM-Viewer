# Agent handoff: 0.8 Playground and Chrome qualification

Review Studio **0.8.0** adds the Playground to the existing STEP, PDF and DOCX universal viewer. It includes visual proposals, drawing/labeling, reference documents and a simulated ECR package workflow. Test this feature checkout, its generated package, or the private [hosted Playground](https://arena-assembly-review.wallcrawler78.chatgpt.site/?mode=preview&playground=1). The hosted test site now contains 0.8 local tools and Preview ECR preparation; optional AI and live Arena writes remain unconnected.

The public 0.7 import was commit `048746c37555c9f46ecb2f7144446aa4b91092ad`, originating from prototype source commit `7c3278877b3a2a35bd52f1b0e9fc77ea2db13408`. Those identifiers describe the historical base, not the new Playground changes. Historical QA records retain their original source identifiers.

## Current verification and open gates

| Check | 0.8 result |
| --- | --- |
| TypeScript and tests | `npm run check` passed: **704 tests in 59 test files**. |
| Application and Chrome build | `npm run build:extension` passed for 0.8.0; the build reported 282 packaged files, 6.76 MiB, with the local STEP/PDF assets. |
| Generated Word report | The test report was rendered to three pages and all pages inspected; a table-row split was corrected and the report rerendered. This is artifact layout QA, not a Playground browser screenshot. |
| Browser visual/interaction and installed Chrome | **Pending manual qualification.** Automatic approval review blocked the attempted browser validation. No successful Playground browser/install run is claimed. |
| Live AI / live Arena ECR | **Not tested.** No authenticated live AI request or actual Arena ECR write was performed. |

The existing hosted link and old browser/performance reports must not be presented as new Playground qualification. Use [Playground testing](playground-testing.md) for the pending manual gate.

## Source export

This public repository includes application source, build scripts, tests, textual QA records and original synthetic STEP/PDF/DOCX fixtures. Historical QA screenshots and raw QA JSON/CSV logs remain with the original prototype evidence and are omitted from this export. The public STEP corpus manifest is retained because the benchmark download script requires its public source URLs and content hashes. The seven binary document fixtures were checked against their generator, synthetic fixture manifest and file hashes before publication. No downloaded external performance models or deployment identity are included.

## Build from source

Use Node.js 22 or newer, npm and the committed lockfile. The feature is on `feature/playground` while its review is pending; a fresh checkout of the historical main branch may not contain it. From a fresh clone, select the feature branch first:

```bash
git clone https://github.com/wallcrawler78/PLM-Viewer.git
cd PLM-Viewer
git switch feature/playground
```

Then build from that checkout:

```bash
npm ci
npm run check
npm run build:extension
```

The build prepares the pinned local CAD/PDF runtimes and emits a complete unpacked extension in `build/extension/`. It also creates `dist/developer/review-studio-extension.zip` and its `.sha256` file. Generated packages, dependencies and vendor assets are intentionally absent from source control. The existing GitHub workflow runs the install, checks and extension build.

## First local Playground session

Run `npm run dev`, open the printed URL, then choose **Playground**. The optional query `?mode=preview&playground=1` opens the new workspace directly. Select a component, move/rotate it, add a bracket concept, draw an arrow labeled “Move hole here,” and use **Capture intent**. Read a PDF beside the model and try its PDF markup target. Undo/Redo, Original/Proposed/Overlay, explode/reassemble and reference documents work as local prototype features without AI.

For the requested ECR flow: **Create ECR → enter a title/description → review items in view as affected items → include rendered design/markup images → generate the Word description attachment → inspect the Preview receipt**. The package contains the local `.docx`, images, manifest and ZIP. It does not upload them to Arena. The Arena-link area remains unavailable until a future verified write provider creates and reads back a real request. See the [six-step walkthrough](playground-testing.md#test-the-six-step-ecr-flow).

Preview proposals autosave to browser-local draft storage; live Arena proposals remain session drafts. Captures and preview receipts remain session-only unless explicitly downloaded. The original source files are not rewritten or included in the exported proposal package. Plain local-file sessions remain in the existing universal viewer and are not automatically mapped to a fake BOM.

## Install in the authorized Chrome browser

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated `build/extension/` folder. If using a packaged ZIP, extract it first and choose the directory containing its `manifest.json`. The repository's `extension/` directory contains incomplete source inputs and is not the installable build.

Use the user's intended browser/profile. A file path in another machine or a cloud executor is not automatically available on that browser's device. If browser or enterprise policy blocks installation, record the exact restriction and stop that installation path.

## Verify the installed runtime

Open the extension toolbar, then **Options → Local runtime checks → Open local runtime checks**. Confirm the page uses the `chrome-extension://` origin and identifies version 0.8.0. Press **Run local checks**, then **Download report**.

| Area | Check and retain evidence |
| --- | --- |
| Package | Version, source hashes and actual packaged CAD/PDF/Word workers load |
| STEP | Imported fixture geometry and expected dimensions; bounds, approximate point measurement, hide/show, opacity, sections and explosion |
| Documents | PDF and DOCX rendering, search and match navigation, page/zoom controls |
| Revisions | Text redlines and side-by-side; PDF visual differences and overview coverage; model overlay and side-by-side |
| Multi-file | Together view with model and its specification/drawing |
| Playground | Occurrence-level transforms, concept dimensions/hole layout, Undo/Redo, Original/Proposed/Overlay and display-only explosion/hiding |
| Design intent | Model/PDF arrows, labels and highlights; camera/aspect behavior; frozen captures retaining deleted original markup text |
| Preview ECR | Description, affected items, actual image captures, generated Word report, manifest/ZIP and an explicit preview receipt without an Arena URL |
| Recovery | Source replacement, cancellation, close/reopen, oversized files, failed sources, proposal save/import and storage conflicts |
| Graphics | Record WebGL2 versus Software 3D, Chrome version, OS/hardware and viewport |

Use [Chrome extension guidance](chrome-extension.md), [test guide](test-guide.md), and [runtime checks](runtime-checks.md). Save actual outcomes, console errors relevant to this application, screenshots, and the downloaded JSON report. Treat hosted Preview tests and static package validation as separate evidence from installed-extension behavior.

## Large-model performance

The [performance report](large-step-performance.md) records four public 5.55–25.90 MiB models that converted and rendered, plus an oversized 37.67 MiB rejection. The previous browser measurements used Software 3D. Accelerated Chrome and installed-extension performance remain unqualified.

Download the exact public corpus outside the repository:

```bash
node scripts/download-step-corpus.mjs --dest /tmp/review-step-corpus
```

Open those files through the installed viewer's **Open local test files** flow. Record load, interaction, comparison and cleanup behavior; preserve the 32 MiB cap and existing geometry limits. For controlled developer measurements, use [the benchmark method](step-benchmark-method.md). The development performance page is not included in the production extension.

## AI boundary

AI is optional and unconfigured by default. Local web development can enable the same-origin gateway with a server-owned provider key and explicit loopback opt-in; follow [the exact setup](playground-ai.md#local-development-configuration). No key belongs in client code, `VITE_` environment variables, extension settings or proposal exports. The assistant returns validated packaged operations for review, not executable code. Sharing a screenshot is explicit and separately authorized.

The installed extension intentionally has no external AI transport under its current CSP. Installing the package must not be reported as enabling Claude/Fable automatically. A future approved extension-to-gateway transport and authentication flow are described in [the integration document](playground-ai.md#a-future-assistant-inside-the-packaged-chrome-tab). Browser dictation inserts editable text only, may use a browser speech service, and does not submit instructions or an ECR by itself.

## Arena boundary

Preview and local source rendering use packaged engines without Arena, desktop CAD/Office or an AI service. Live Arena launches currently use a separately configured hosted viewer/BFF with user-bound access. Direct extension-to-MCP authentication, actual tenant attachment routes and shared live review writes remain unverified. Do not treat Preview data, a successful CI run or a software-rendering result as live Arena qualification.

The current ECR adapter is a local simulation. The server-only ECR orchestration seam is not publicly mounted and has no mapped Arena write tools. Real testing requires the actual tool catalog, user-bound create/affected-item/attachment permissions, a durable shared retry journal, exact-source checks and record/file/URL readback. No guessed tool name or Preview receipt establishes live capability. A hidden field is not an authorization boundary or a verified team storage service.

Keep credentials, private source files, source bytes from downloaded external performance models, and deployment identity out of the repository. Preserve the exact item/revision/file/hash and component-placement contracts when changing code.
