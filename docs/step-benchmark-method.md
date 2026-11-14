# Local STEP conversion benchmark

`scripts/benchmark-step.mjs` measures the current viewer's local STEP conversion pipeline with external test files. It does not add a runtime service, upload a model, change viewer limits, or make browser frame-rate claims.

## Run

From an installed checkout with prepared runtime assets:

```bash
npm run prepare:assets
node scripts/benchmark-step.mjs --runs 3 --out /absolute/output/step-results.json /absolute/samples/assembly.step /absolute/samples/part.stp
```

The runner accepts one to twenty STEP/STP paths, runs each sequentially, and uses a fresh process for each repetition. Three repetitions are the default; `--runs` accepts one to five. Without `--out`, the JSON report goes into the operating system's temporary directory. The report is checkpointed after each completed run. Keep large external files outside the repository and application assets; record provenance and distribution terms separately before sharing a corpus.

The output must be a separate `.json` file. Output symlinks, canonical-path aliases through linked directories, and existing hard links to any source are rejected. Each checkpoint uses a unique, exclusively created temporary file and an atomic rename; an existing predictable `.tmp` symlink is never followed. Source files are opened as bounded regular-file snapshots. The child reads no more than the production source cap. It rejects a size change between the parent's stat and the child's read, and a size, identity or modification-timestamp change during the child's read. Keep inputs immutable for the full benchmark.

The runner uses the existing esbuild dependency to bundle `src/cad/step-import.ts` and `src/cad/step-types.ts`. It evaluates the exact prepared `public/vendor/occt/occt-import-js.mjs` loader, with only its terminal ESM export removed for the Node VM adapter, and uses the adjacent packaged WASM. String code generation is disabled in that VM, matching the existing CAD regression-test approach. The application version, commit, loader/WASM/bundle hashes, benchmark-script hash and host environment are included in the report.

## What is measured

| Field | Meaning |
| --- | --- |
| `sourceReadMs` | Local filesystem read into the source buffer. Does not represent an Arena download. |
| `fingerprintMs` | Independent SHA-256 fingerprint used to bind the report and production import to exact source bytes. |
| `runtimeInitializationMs` | Reading and evaluating the packaged loader, reading WASM and initializing the local importer. |
| `productionImportMs` | Calling the unchanged `importStepBytes` implementation: mapping and hash validation, `ReadStepFile`, and production geometry/hierarchy validation and normalization. Includes small diagnostic observation overhead. |
| `sourceVerificationMs` | Time from the production import call until the wrapped kernel starts; includes mapping, SHA-256 verification and a small progress notification. |
| `kernelMs` | Synchronous `ReadStepFile` call, including parsing, geometry processing, tessellation and conversion to the importer's JavaScript result. These internal phases cannot be separated through the current importer API. |
| `postKernelValidationMs` | Remaining production result validation/normalization after the kernel returns, excluding measured diagnostic snapshots/counting. |
| `diagnosticsMs` | Measured memory/count/progress-observation overhead around kernel completion. |
| `childElapsedMs` | Child's measured execution, including setup, local read, fingerprint and import. |
| `parentElapsedMs` | Parent-observed child lifetime, additionally including process startup/exit overhead. |
| `processPeakRssKiB` | OS-reported peak resident memory for the entire child process. Includes Node, compilation, source bytes, WASM, raw importer arrays and normalized buffers. |
| `sampledPeakRssBytes` | Highest Linux `/proc` RSS sample observed by the parent at approximately 100 ms intervals. Sampling can miss brief peaks. |
| `wasmCapacityBytes` | Importer's allocated WebAssembly linear-memory capacity after conversion. It is not live allocation size or total browser memory. |
| `geometry` | Validated mesh/vertex/triangle counts, typed geometry-buffer bytes, hierarchy size/depth and millimeter bounds. |
| `rawGeometry` | Kernel counts before production normalization, useful when a result exceeds the production geometry budget. |

CPU user/system time is also recorded. Values may exceed elapsed wall time because runtime initialization and compilation can use multiple threads. Source file size does not determine face count, tessellation density, output size or conversion difficulty.

## Bounds and outcomes

Production tessellation stays at absolute 0.1 mm linear deflection and 0.15 rad angular deflection. Production maximums remain 32 MiB source, two million vertices, one million triangles, 10,000 meshes, 20,000 hierarchy nodes and depth 64. Larger files are refused before reading or importing; geometry limits are still checked after the kernel returns its raw result.

Each child has a **120-second parent deadline** covering process startup, filesystem read, fingerprint, runtime initialization and import. This is more conservative than the viewer's worker deadline, which starts after acquisition. An independent parent can terminate a synchronous WASM call; an in-child JavaScript timer could not do so. `--timeout-ms` can lower the deadline, but cannot exceed 120,000 ms or the production worker limit.

On Linux the parent also samples child RSS and stops it above a **2 GiB benchmark safety ceiling**. `--rss-limit-mib` may lower this to 128–2048 MiB. This extra harness ceiling is not an application memory guarantee or supported-workload specification. Sampling can overshoot between observations. On other operating systems the sampled RSS stop is unavailable; the parent deadline remains active. Interrupting the parent with Ctrl+C or SIGTERM also kills its current child.

| Status | Interpretation |
| --- | --- |
| `imported` | The original source passed the actual production converter and validators. |
| `rejected` | Initialization or production import failed; `failedStage` and the bounded error explain where. This is not a successful import. |
| `blocked-source-size` | File size was empty or beyond the unchanged source cap; no kernel import occurred. |
| `timed-out` | Parent killed the child at the benchmark deadline. |
| `safety-stopped` | Parent killed the child after sampled RSS exceeded the harness ceiling. |
| `crashed` | Child exited without a completed result; exit code/signal are retained. Raw kernel diagnostics are discarded because they can contain source text. |

Repeated runs stop after a timeout, safety stop or crash. Repeating a rejected ordinary import can establish that the rejection is consistent. Reports remain available after completed samples even if a later sample encounters an infrastructure failure.

## Interpretation and browser follow-up

A fresh Node process is a **process-cold** measurement. It does not clear operating-system file caches, simulate a cold network, measure browser worker transfer, build the Three.js scene, render pixels, or test hover/orbit/selection. Report medians and run ranges for completed conversions; do not combine successful timings with rejections or timeouts. Retained typed geometry-buffer bytes exclude browser scene edges, GPU resources, software projection buffers, DOM and documents.

Use the viewer's **Open local test files** flow for separate browser verification. Identify the actual renderer, browser version, viewport and display pixel ratio; record first useful geometry, main-thread responsiveness, orbit/selection/section/opacity operations, comparison, cancel/reopen and cleanup. Hosted browser observations do not establish installed-extension performance or a specific user's laptop experience. Keep CPU conversion, browser responsiveness and production Arena transfer measurements separate in the results.

## Reproduce the external corpus

The five public sources are recorded with exact byte counts, SHA-256 identities, publisher links and license declarations in [the corpus manifest](qa-large-step/corpus.json). The originals remain outside the repository, normal Preview assets and extension package.

```bash
node scripts/download-step-corpus.mjs --dest /tmp/review-step-corpus
node scripts/benchmark-step.mjs --runs 3 --out /tmp/review-step-results.json /tmp/review-step-corpus/*.step
```

The downloader verifies each file before making its final filename available, skips matching existing files and preserves mismatches. Its destination must be outside the checkout. The 37.67 MiB source is intentionally an early-rejection case. The helper downloads data only; it does not convert a model or invoke a third-party processing service.

## Browser performance harness

Start the normal development server with `npm run dev` and open `/scripts/performance/step-browser.html` on the printed development origin. In the managed Sites environment, use the supported Sites preview URL. This development-only entry is excluded from the production application and extension builds.

Choose one STEP file, press **Load selected STEP**, wait for the model, and run **Run 10 camera views**. Keep the viewport and quality setting consistent between sources. Close the preceding source before starting another; the chooser also cancels and releases the preceding run. Use **Download JSON report** to retain the results. The normal viewer's **Open local test files** flow remains the separate check of the product interface.

The harness calls the production `openLocalFile`, `ViewerEngine`, CAD worker and renderer. It wraps only the current engine instance's actual `render` method to time its synchronous work; it does not replace the renderer or omit geometry. Its deliberate test-only access to engine internals must be reviewed if those internals change. Sources, engine limits and tessellation remain unchanged.

| Browser metric | Interpretation |
| --- | --- |
| Load to first model draw | From the Load button handler through local read/hash, worker acquisition/import, scene preparation and completion of the first renderer call. Excludes the native chooser, file transfer into the test browser and page startup. |
| Engine ready | Geometry is imported, validated and installed in the scene. A draw may still be pending. |
| First post-render animation frame | An ensuing paint opportunity, not proof of presentation to a physical display. |
| Camera first-render summary | Ten standard-view commands through the actual engine. Reports synchronous renderer-call time after each command; empty loading frames are excluded. |
| Software render time | Includes projection, primitive preparation/sorting and Canvas drawing calls. It is not an end-to-end displayed frame rate. |
| WebGL render time | CPU command-submission time only; does not measure GPU execution. |
| Long tasks | Main-thread tasks observed through the browser's optional Long Tasks API. Includes diagnostic/reporting overhead and other activity in the observation interval; not a separate measurement of the CAD worker. |
| Browser memory | Optional, possibly quantized `performance.memory` JavaScript heap snapshots. Not a tab/process/WASM/GPU peak-memory measurement and not evidence of a leak by itself. |

The camera sequence resets model visibility, opacity, selection, bounds and measurement to consistent defaults. Results retain at most 12 source runs, 512 render samples per run, 256 long tasks per run and eight camera sequences per run; dropped samples are reported. The report stores source names, sizes, hashes and bounded metrics, never source bytes. Do not run CPU-heavy tests, builds or other conversion jobs alongside measured browser work. Inspect the recorded renderer mode before interpreting the result.
