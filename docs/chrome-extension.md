# Review Studio Chrome extension

The extension package contains the viewer application, local STEP processing engine, PDF/DOCX runtime, workers, fonts, auxiliary PDF assets, and synthetic Preview files. The toolbar opens a local extension page. No hosted viewer, Arena login, desktop CAD/Office installation, or AI subscription is needed for Preview.

The first packaged release keeps the existing authenticated **hosted Arena viewer** as the live launch destination. Direct MCP authentication from the extension is not implemented or verified. An Arena launch never substitutes Preview when configuration or access fails.

Version **0.8.0** adds a **Playground** tab to the packaged workspace. Its visual proposal tools, model/PDF markups and Preview ECR packages run locally. The optional AI gateway is available only to a separately configured web development/hosted viewer; this extension build does not connect to an AI service. Live Arena ECR creation is not enabled.

## Build

From the repository root, with Node.js 22 or newer:

```sh
npm ci
npm run build:extension
```

The build creates:

| Output | Purpose |
| --- | --- |
| `build/extension/` | Complete unpacked extension for Chrome |
| `dist/developer/review-studio-extension.zip` | Portable extension package; extract before loading locally |
| `dist/developer/review-studio-extension.zip.sha256` | SHA-256 of the ZIP |
| `build/extension/checksums.sha256` | SHA-256 of each packaged runtime file |

`npm run build:extension` first builds the application and prepares pinned runtime assets. Packaging then bundles the Arena content script as one classic local script, copies the full application, and validates its entry points, parsed static/literal dynamic imports, emitted worker/preload assets, CSS fonts/resources, runtime manifest versions/entries, and complete executable policy. Computed library imports still require runtime qualification. Developer ZIPs, server build outputs, environment files, and hosting headers are excluded. The generated directory is not source code and should not be committed.

Do not load the repository's `extension/` source directory directly: it intentionally lacks the compiled application and its content script still uses source-module imports. Load `build/extension/` or the extracted ZIP.

## Install for testing

1. Extract `review-studio-extension.zip` to a dedicated folder, or use the local `build/extension` directory.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the folder containing the packaged `manifest.json`.
5. Pin **Review Studio · Universal Viewer** from Chrome's Extensions menu if convenient.
6. Select the toolbar icon. It opens the bundled PDF Preview at `chrome-extension://.../viewer.html`.
7. Right-click the extension icon and select **Options** for the sample launch buttons and optional Arena configuration.
8. Choose **Local runtime checks** in Options, select **Run local checks**, and download the JSON report. The execution surface must read **Chrome extension** for installed-package evidence. The same screen in the hosted Preview tests a different origin and does not qualify Manifest V3 behavior.

After rebuilding, use **Reload** on the extension card and reload any already open viewer/Arena tabs. Extension IDs can differ between unpacked installation paths. Keep a stable folder for testing; a production signed package and app registration need a stable identity.

An unpacked test install is not a Chrome Web Store publication. Store distribution, administrator deployment, and installed-extension qualification remain release gates.

## Local review workflows

| Action | Expected behavior |
| --- | --- |
| Select the extension toolbar icon | Open the packaged PDF Preview, independent of saved live connection settings |
| **Read a PDF** in Options | Open the sample PDF with local rendering and search |
| **Read a Word document** | Open sample DOCX locally |
| **Compare PDF revisions** | Open both sample revisions with deterministic text redlines |
| **Visual changes** in a PDF comparison | Compare explicitly chosen PDF page pairs locally with overlay, changed regions and sensitivity; the existing text redlines remain available |
| **Page overview → Scan pages** | Scan same-number PDF pairs locally, inspect coverage and change summaries, pause/resume, and open any pair in the detailed overlay |
| **Inspect the assembly** | Open the sample BOM/model and process its STEP sources locally |
| **View a model and drawing together** | Open equal model/document panes |
| **Playground** tab | Move/rotate visual component representations, add concept shapes, compare original/proposed views, explode, label, draw and Undo/Redo |
| **Create ECR** in Playground | Describe the change, review the initially selected visible items, and prepare actual design/markup images plus a Word report in a clearly labeled Preview package |
| **Open local test files** in the viewer header | Select actual STEP/STP, PDF and DOCX files without uploading them; choose comparison baselines explicitly |
| **Local runtime checks** in Options | Verify package versions/source hashes and exercise real STEP/PDF/DOCX engines and graphics, with cancellation and a sanitized downloadable report |

Core processing does not use a conversion API or AI model. Current format and precision limits still apply: legacy binary DOC and scanned-page OCR are not included; DOCX pagination is browser-based; document redlines compare extracted text. Visual PDF differences use a common scale and explicit selected pairs or a same-number page overview; there is no automatic registration or semantic page matching. Failed and unscanned overview pages remain coverage gaps. Each run is capped at 50 pairs, 60 million pixels and two minutes; the overview covers at most 300 pairs. Model point distances are mesh estimates. Shared live review storage is not connected. Preview notes and saved views are local browser review data.

Normal PDF reading and Runtime Checks now use the same explicitly owned package-local native worker. An unavailable worker fails through the bounded load path; silent main-thread fallback is not accepted as a successful worker check. Per-page PDF resources are released cooperatively; source bytes/shared PDF caches remain until the document closes.

For the new proposal workflow, follow `docs/playground-testing.md` in the source checkout. The Preview result offers image, Word and ZIP downloads; it does not fabricate an Arena URL. The live result is reserved for a verified write/readback once the actual MCP operations and durable submission journal are bound. Model edits change web 3D representations only. Word documents remain readable/searchable; drawing overlays apply to model views and PDF pages.

## Connect the existing live Arena path

An administrator must separately deploy and configure the viewer's authenticated MCP service as described in `docs/arena-mcp-setup.md`. The currently published static Preview is not that service.

In extension Options, enter the **Hosted Arena viewer URL** and **Arena workspace ID**, then save. URLs must use HTTPS, with HTTP localhost allowed for local server development. Sign-in codes, tokens, and credential-bearing URLs are rejected. These settings store no Arena session token or attachment bytes.

Use either the **Open in Review Studio** context-menu action on a compatible Arena link/page, or **Open an exact Arena source** in Options. Manual launch accepts the item GUID, optional revision and file GUID, and optional exact edition/hash. The hosted application resolves and authorizes the source; a missing revision may require explicit selection. Identifiers are source context, never proof of permission.

The live launch opens the configured HTTPS application in a regular browser tab. It does not claim to be direct extension-to-MCP access. A failed live connection stays a live error rather than opening sample data.

## Optional automatic attachment opening

Automatic opening is **off by default**. Enable **Open verified attachment links automatically** only after the administrator has configured and tested the live viewer.

The content bridge is scoped to:

| Region/application | Allowed origin |
| --- | --- |
| Arena application | `https://app.bom.com` |
| Arena government application | `https://app.arenagov.com` |
| Arena Europe | `https://app.europe.arenaplm.com` |
| Arena UK | `https://app.uk.arenaplm.com` |

The bridge handles ordinary clicks and Enter activation on links that explicitly identify a STEP/STP, PDF, or DOCX source and contain unambiguous `itemId`/`itemGUID`, `fileId`/`fileGUID`, `revision`, `edition`, and lowercase SHA-256 `sourceHash` parameters. A type can be supplied by a recognized filename, a `filename`/`fileName` parameter, or an explicit `kind`/`format` parameter. If a workspace parameter is present it must match the saved workspace. The background worker revalidates the context and current settings before opening the hosted viewer.

Unknown/opaque routes, missing source identities, conflicting types, legacy DOC, other hosts, and modified/middle clicks keep their normal Arena/browser behavior. A context-menu fallback remains available. The bridge uses event delegation so newly added SPA links can be recognized without scraping the whole page.

For a recognized source, the original navigation/download action is paused before the extension requests a new viewer tab. If launch fails, an error gives the user an explicit **Continue with Arena** option. Failure does not silently trigger the original download.

This is support for the explicit launch contract, not proof that a real Arena tenant currently emits that URL shape. Actual Arena UI actions and version-specific routes still require verification. Prefer an Arena-supported external viewer action when available; extend source resolution only against verified behavior.

## Permissions and local resource policy

- `contextMenus` supplies the Arena fallback action.
- `storage` retains non-secret connection preferences and launch notices.
- The four declared content-script matches enable optional supported-link interception. The extension does not request access to every website, cookie access, download control, a debugger, or arbitrary network interception.
- The extension executable policy allows packaged scripts and WebAssembly, without unrestricted `eval` or remotely hosted executable code.
- The local viewer's network policy permits its own packaged resources and session blob URLs created for user-selected test files. It does not grant a direct remote MCP client.
- Original file bytes are not placed in extension settings or a persistent attachment cache. Displaying a file necessarily receives bytes on the device; this is not a guarantee against screenshots or all operating-system copies.

## Qualification checklist

Package validation and automated tests do not establish installed-Chrome behavior. Record these checks separately before production approval:

1. Install the emitted package in a clean current Chrome profile, run **Local runtime checks**, retain its report, and open each local workflow. The report is a starting point, not the entire release gate.
2. Confirm packaged PDF/CAD workers, fonts, character maps, and WASM load without a CDN or outside processing call.
3. Exercise PDF/DOCX comparisons, PDF overview pause/resume/drill-down and raw STEP loading, including two model revisions, hide/opacity, selection, bounds, measurement, and source replacement.
4. Test local file-session cleanup and cancellation without persistent original-file copies.
5. Validate real Arena launch actions, exact source resolution, login/expiry, and denied sources with two permission profiles.
6. Verify ordinary keyboard activation, SPA links, modifier/middle-click fallback, automatic-opening opt-out, and settings changes while an Arena page is open.
7. Test the final extension CSP and resource limits on representative laptops and large documents/assemblies.
8. Complete dependency/distribution notices, a stable extension identity, and the selected production deployment process.
9. Complete the 0.8 Playground checklist: proposal edits and Undo/Redo, source-bound model/PDF markups, state retention when switching tabs, visible-item defaults, real image/Word generation and the Preview-only ECR receipt. Confirm the local extension assistant stays explicitly unavailable without making an outside API request.

The broader delivery sequence and outstanding Arena requirements are in `docs/standalone-viewer-plan.md`.

The 0.5 audit attempted installed-extension testing through the supported browser workflow. Its policy rejected `chrome://extensions/` and prohibited alternate paths around that restriction. Installed Chrome testing remains outstanding; see `docs/release-05-qa.md` for the package and hosted-browser evidence actually obtained.
