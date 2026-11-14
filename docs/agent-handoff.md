# Agent handoff: installed Chrome qualification

Review Studio **0.7.0** is a browser viewer for STEP, PDF and DOCX, with a simulated BOM in Preview and a separate Arena integration boundary. This portable snapshot originates from source commit `7c3278877b3a2a35bd52f1b0e9fc77ea2db13408`. The original hosted Preview is maintained separately. Historical QA records retain their original source identifiers.

## Source export

This public repository includes application source, build scripts, tests, textual QA records and original synthetic STEP/PDF/DOCX fixtures. Historical QA screenshots and raw QA JSON/CSV logs remain with the original prototype evidence and are omitted from this export. The public STEP corpus manifest is retained because the benchmark download script requires its public source URLs and content hashes. The seven binary document fixtures were checked against their generator, synthetic fixture manifest and file hashes before publication. No downloaded external performance models or deployment identity are included.

## Build from source

Use Node.js 22 or newer, npm and the committed lockfile. From the repository root:

```bash
npm ci
npm run check
npm run build:extension
```

The build prepares the pinned local CAD/PDF runtimes and emits a complete unpacked extension in `build/extension/`. It also creates `dist/developer/review-studio-extension.zip` and its `.sha256` file. Generated packages, dependencies and vendor assets are intentionally absent from source control. The existing GitHub workflow runs the install, checks and extension build.

## Install in the authorized Chrome browser

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated `build/extension/` folder. If using a packaged ZIP, extract it first and choose the directory containing its `manifest.json`. The repository's `extension/` directory contains incomplete source inputs and is not the installable build.

Use the user's intended browser/profile. A file path in another machine or a cloud executor is not automatically available on that browser's device. If browser or enterprise policy blocks installation, record the exact restriction and stop that installation path.

## Verify the installed runtime

Open the extension toolbar, then **Options → Local runtime checks → Open local runtime checks**. Confirm the page uses the `chrome-extension://` origin and identifies version 0.7.0. Press **Run local checks**, then **Download report**.

| Area | Check and retain evidence |
| --- | --- |
| Package | Version, source hashes and actual packaged CAD/PDF/Word workers load |
| STEP | Imported fixture geometry and expected dimensions; bounds, approximate point measurement, hide/show, opacity, sections and explosion |
| Documents | PDF and DOCX rendering, search and match navigation, page/zoom controls |
| Revisions | Text redlines and side-by-side; PDF visual differences and overview coverage; model overlay and side-by-side |
| Multi-file | Together view with model and its specification/drawing |
| Recovery | Source replacement, cancellation, close/reopen, oversized files and failed sources |
| Graphics | Record WebGL2 versus Software 3D, Chrome version, OS/hardware and viewport |

Use [Chrome extension guidance](chrome-extension.md), [test guide](test-guide.md), and [runtime checks](runtime-checks.md). Save actual outcomes, console errors relevant to this application, screenshots, and the downloaded JSON report. Treat hosted Preview tests and static package validation as separate evidence from installed-extension behavior.

## Large-model performance

The [performance report](large-step-performance.md) records four public 5.55–25.90 MiB models that converted and rendered, plus an oversized 37.67 MiB rejection. The previous browser measurements used Software 3D. Accelerated Chrome and installed-extension performance remain unqualified.

Download the exact public corpus outside the repository:

```bash
node scripts/download-step-corpus.mjs --dest /tmp/review-step-corpus
```

Open those files through the installed viewer's **Open local test files** flow. Record load, interaction, comparison and cleanup behavior; preserve the 32 MiB cap and existing geometry limits. For controlled developer measurements, use [the benchmark method](step-benchmark-method.md). The development performance page is not included in the production extension.

## Arena boundary

Preview and local source rendering use packaged engines without Arena, desktop CAD/Office or an AI service. Live Arena launches currently use a separately configured hosted viewer/BFF with user-bound access. Direct extension-to-MCP authentication, actual tenant attachment routes and shared live review writes remain unverified. Do not treat Preview data, a successful CI run or a software-rendering result as live Arena qualification.

Keep credentials, private source files, source bytes from downloaded external performance models, and deployment identity out of the repository. Preserve the exact item/revision/file/hash and component-placement contracts when changing code.
