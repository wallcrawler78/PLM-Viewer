# Large STEP performance results

Review date: **13 November 2026, America/Los_Angeles**. Raw timestamps retain UTC. Tested application: **0.7.0**, starting source `59599cff2b592102bd96c946c67bcb6af9d9b2ad`.

## Outcome

Four public STEP sources from **5.55 to 25.90 MiB** passed the unchanged local converter in all three fresh-process repetitions and rendered through the actual browser viewer engine. A fifth, **37.67 MiB**, was correctly rejected by the existing **32 MiB** source limit before conversion. The original 0.69 MiB Atlas assembly provided a control.

The browser available for this run used **Software 3D**, not WebGL2. Dense sources required about **two seconds of synchronous renderer work per controlled camera view**, with one 5.90-second draw. That is too slow for comfortable orbiting. This is evidence that the fallback needs a restricted workload or further optimization; it is not a measurement of accelerated Chrome on a user's computer.

Local import is viable for these examples, but this is **not yet a large-assembly production qualification**. The largest accepted sample reached a 1,523 MiB reported whole-process peak RSS in the Node conversion runner. Keep current limits while qualifying hardware, comparisons and repeated sessions. These tests used the packaged converter and renderer without an AI API, remote conversion service, or desktop CAD application.

## Public test sources

Sizes below use MiB (1,048,576 bytes). Exact source sizes, SHA-256 hashes, pinned revisions, publisher declarations and STEP exporter headers are retained in [corpus.json](qa-large-step/corpus.json). Original external STEP bytes are deliberately outside the repository and are not included in Preview, the extension, or the portable source archive.

| Sample | Size, MiB | Publisher/source | Declared terms and tested role |
| --- | ---: | --- | --- |
| RevoVoron printhead | 5.55 | [Voron Stealthburner](https://github.com/VoronDesign/Voron-Stealthburner), pinned commit | Repository declares GPL-3.0; mechanical geometry |
| Helicopter main rotor | 6.63 | [STEP Tools sample collection](https://www.steptools.com/docs/stpfiles/bigassy/) | Public sample; no explicit redistribution grant established. SolidWorks 2015 export |
| Mini Stealthburner Bowden toolhead | 12.87 | [Voron 0](https://github.com/VoronDesign/Voron-0), pinned commit | Repository declares GPL-3.0; mechanical subassembly |
| Robot head assembly | 25.90 | [Zenodo record 20695787](https://zenodo.org/records/20695787), DOI 10.5281/zenodo.20695787 | Official record metadata declares CC BY 4.0; near-limit assembly |
| Stealthburner CW2.5 assembly | 37.67 | [Voron Stealthburner](https://github.com/VoronDesign/Voron-Stealthburner), pinned commit | Repository declares GPL-3.0; early size-rejection case only |

The robot dataset credits Semin Ahn, Hyunkyoon Kim, Huijae Moon, Yeon June Kang and Sung Hoon Ahn, and is titled *A Sub-second Rotation Binaural Ear for Human-like 3D Sound Localization in Humanoids*. Its publisher MD5 also matched the downloaded file. The rotor sample credits an original GrabCAD source. License statements are publisher declarations, not a new distribution grant; retain source attribution and applicable terms if redistributing models or derivatives.

All five downloaded headers describe AP214/`AUTOMOTIVE_DESIGN`. The rotor identifies SolidWorks 2015 / SwSTEP 2.0; the other four identify Autodesk Translation Framework export paths. This corpus does not qualify Onshape, Creo, every SolidWorks version, AP242 metadata, or deeply nested engineering assemblies.

## Local conversion measurements

The runner calls the actual production `importStepBytes` implementation and the exact prepared OCCT loader/WASM, in a fresh sequential Node process for each repetition. Tessellation remains **0.1 mm absolute linear deflection** and **0.15 rad angular deflection**. No source, geometry or timeout limit was raised.

| Source | Size, MiB | Import median, s | Import range, s | Imported meshes | Triangles | Max reported process peak RSS, MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Atlas assembly A, control | 0.69 | 1.36 | 1.31–2.01 | 9 | 21,822 | 403 |
| RevoVoron | 5.55 | 9.79 | 8.53–10.74 | 2 | 140,121 | 495 |
| Helicopter rotor | 6.63 | 14.75 | 14.41–18.73 | 93 | 663,944 | 766 |
| MiniSB Bowden | 12.87 | 31.87 | 31.74–33.54 | 44 | 712,544 | 908 |
| Robot head | 25.90 | 49.27 | 45.04–84.89 | 100 | 542,333 | 1,523 |
| Stealthburner CW2.5 | 37.67 | — | — | — | — | — |

Every accepted source has three successful repetitions, for **15 successful conversions including the control**. Mesh/vertex/triangle counts, hierarchy and bounds remained consistent across repetitions. No completed final run timed out or crossed the runner's separate 2 GiB RSS safety ceiling. The oversized file had zero conversion attempts, so its actual conversion cost and compatibility remain unknown.

`productionImportMs` includes source/mapping verification, the synchronous kernel and output validation/normalization. It excludes filesystem read, runtime initialization, browser worker overhead, scene creation and rendering. Approximately 98–99.5% of import time in the four external samples was inside `ReadStepFile`; its parsing, CAD processing, tessellation and JavaScript-output stages cannot be separated through this API. Optimizing React updates or source hashing alone therefore will not remove most of this conversion time.

The robot runs were 84.89, 49.27 and 45.04 seconds. The cause of this spread is unproven; this report does not attribute it to a cache, JIT, memory pressure or a defect. Fresh processes do not clear the operating system's file caches or establish cold-network performance.

### Memory and complexity

| Source | Vertices | Retained typed geometry, MiB | Allocated WASM capacity after import, MiB |
| --- | ---: | ---: | ---: |
| Atlas control | 22,145 | 0.76 | 41.19 |
| RevoVoron | 94,470 | 3.77 | 177.50 |
| Rotor | 519,094 | 19.48 | 306.75 |
| MiniSB | 466,347 | 18.83 | 441.75 |
| Robot head | 496,174 | 17.56 | 1,074.94 |

The RSS column is the maximum recorded OS-reported peak for the **whole Node child process**, including Node, compilation, source bytes, WASM, raw importer arrays and normalized geometry. It is not browser-tab peak memory. The report also retains approximately 100 ms Linux RSS samples, which can miss brief peaks; the OS peak snapshot is taken near conversion completion rather than after every possible cleanup allocation. WASM capacity is allocated linear memory, not live used allocation. Typed geometry excludes scene objects, GPU resources, projection buffers, primitive lists, documents and DOM.

The 6.63 MiB rotor produced almost 4.74 times as many triangles as the 5.55 MiB Revo source. Conversely, the 25.90 MiB robot produced fewer triangles than the 12.87 MiB MiniSB while costing more import time and memory. **Bytes, import complexity and interactive rendering complexity need separate budgets.** Imported meshes are not verified Arena BOM occurrences. These shallow imported hierarchies, depth one or two, do not stress a deep BOM.

Environment: Node v24.22.1, V8 13.6.233.17-node.58, Linux x64. The host reported an Intel Xeon Platinum 8573C, nine logical CPUs and 10,451,423,232 bytes of memory; effective container quotas and dedicated CPU availability were not established. The raw report includes the exact loader, WASM, bundled production module and benchmark-script hashes. The final CLI script hash is `528bf73945c7de7da760d49b25a6a3666a26660198ab5d567d809f58e13c09f8`.

Evidence: conversion CSV (historical raw report omitted from this source export), raw Node JSON (historical raw report omitted from this source export), [measurement method](step-benchmark-method.md).

## Actual browser measurements

The development diagnostic page uses the production `openLocalFile`, `ViewerEngine`, CAD worker and renderer. Each measured source used ten standard camera views with visibility, opacity, selection, bounds and measurement reset consistently. CPU-heavy CLI tests and builds were not run alongside these timed browser measurements.

Browser: Chrome 156.0.0.0, Linux x86_64, **software renderer**, Standard quality, device-pixel ratio 1, 1,298 × 558 CSS-pixel canvas. One initial browser load and ten camera samples were collected per source. No renderer or long-task samples were dropped.

| Source | Load to first completed model draw, s | Median camera renderer CPU time, ms | Maximum camera renderer CPU time, ms |
| --- | ---: | ---: | ---: |
| Atlas control | 2.26 | 84.10 | 132.60 |
| RevoVoron | 12.83 | 478.10 | 556.20 |
| Rotor | 14.66 | 2,020.15 | 2,800.80 |
| MiniSB | 38.53 | 1,991.00 | 5,904.30 |
| Robot head | 55.05 | 1,962.15 | 3,212.90 |

“Load to first draw” starts at the Load button handler and includes local read/hash, worker acquisition/import, scene preparation and completion of the first renderer call. It excludes the chooser, transferring a file into the cloud test browser and page startup. The report also records engine-ready time and a following animation-frame opportunity; screenshots confirm that the geometry became visible. A completed render call is not a physical-display presentation timestamp.

Camera values measure the actual synchronous renderer call. In software mode that includes projection, primitive preparation/sorting and Canvas drawing calls. **These are not measured FPS, complete pointer-to-paint latency, or WebGL/GPU execution times.** Ten samples are a small observation set, not a production percentile distribution. The MiniSB maximum is retained rather than discarded. The source of that outlier is not established.

The main-thread Long Tasks report includes other UI, hover and diagnostic work during the interval; it does not isolate CAD-worker computation. Optional `performance.memory` values are partial, possibly quantized JavaScript heap snapshots, not total or peak tab memory and not a leak diagnosis. The page and its assets may be warm; no cold-browser claim is made.

All four external sources exceeded the existing detailed-edge threshold, so the production engine suppressed detailed edge lines with a visible notice. That existing policy was not introduced to improve these benchmark scores. Economy mode changes display resolution, not triangle count; at the tested DPR of 1 it does not provide a density reduction.

Evidence: browser CSV (historical raw report omitted from this source export), raw browser JSON (historical raw report omitted from this source export), rotor screenshot (historical screenshot omitted from this source export), robot screenshot (historical screenshot omitted from this source export).

## Functional and failure-path checks

| Check | Observed result |
| --- | --- |
| Oversized source in diagnostic page | 37.67 MiB source rejected in 6.4 ms before engine/source hashing/geometry work. This is one observed rejection, not a latency guarantee. |
| Oversized source in normal viewer | Existing Revo model, 1/8 source list, bounds and 52.96 mm approximate measurement remained visible after the rejection. |
| Bounding box in normal viewer | Revo mesh envelope displayed 71.07 × 42.00 × 63.13 mm with its visible box. |
| Hide/show and transparency | Hide produced the empty-model state; Show restored geometry. Opacity changed from 1 to 0.1 and back with visible results. |
| Two-point measurement | Surface picks produced 52.96 mm, explicitly labeled approximate. This is mesh review, not certified B-rep metrology. |
| Diagnostic cancellation/reopen | MiniSB cancelled 7.10 seconds after starting while still at 0/1 imports. A subsequent Revo load reached first draw in 7.85 seconds with the correct hash and triangle count, with no stale MiniSB result. This is recovery evidence, not a claimed speedup. |
| Normal-app cancellation/reopen | With the preview server running, MiniSB displayed Importing STEP locally 0/1. Back to Preview exited the active import; opening a fresh local session and Revo restored the correct model/envelope with no stale MiniSB result. |
| Warning/tool layout | Found and fixed overlap between long import notices and measurement instructions. They now share a flowing, pointer-transparent stack; verified an 8-pixel vertical gap with the real source and both messages visible. |

During later manual QA, the managed development server stopped and two immediate worker-start failures appeared in the still-open page. The previous preview process no longer existed. Restarting the supported preview restored normal loading, cancellation and reopening. This infrastructure interruption occurred after timed collection; it is not counted as a file incompatibility, out-of-memory event or timed conversion failure.

Completed diagnostic runs have outcome `closed` in the JSON because the engine was intentionally disposed after measurement; this does not mean their import failed. All external models were checked through the real engine, while the normal application interaction checks above focus on Revo.

The small warning-layout fix was made **after** timed collection. It changes only `ModelViewport.tsx` and viewport CSS; the converter, engine, renderer, limits, dependencies and version were not changed. The final source includes the diagnostic tools and report as development assets.

Normal viewer, Revo bounds and approximate point measurement (historical screenshot omitted from this source export)

## Recommended next work

| Priority | Recommended action | Acceptance evidence |
| --- | --- | --- |
| 1 | Run this same corpus on actual target Chrome hardware with WebGL2, including the installed Manifest V3 package. | Record hardware, graphics path, load-to-draw, pointer-to-paint/interaction traces, peak process memory and repeated open/close. Include the user's Mac configuration and at least one constrained managed computer. |
| 2 | Treat Software 3D as a constrained fallback for dense models. Profile allocation and primitive sorting before implementing buffer reuse and bounded working sets. | Re-run this exact corpus and confirm lower interaction cost while preserving clipping, transparency, picking and measurements. Buffer reuse alone is not assumed to solve hundreds of thousands of Canvas primitives. |
| 3 | Improve time to useful content with selected-subassembly loading and progressive scene insertion; batch selectors that share one exact STEP source. | Show correct loaded/failed counts; avoid repeated whole-assembly import, overlapping geometry and pose errors; keep cancellation and source replacement deterministic. |
| 4 | Evaluate a local detail policy for dense geometry, separate from display-resolution preferences. | Any tessellation/LOD change must carry explicit precision and exact-source identity, preserve measurement semantics and be compared against known dimensions. Do not silently reduce engineering fidelity. |
| 5 | Expand qualification to two large revisions, Together, multi-tab, long sessions, deeper assemblies and broader exporters. | Measure compounded memory and interaction costs, compare cleanup over repeated cycles and verify source-bound selection, comments and comparison alignment. |

Keep the 32 MiB source ceiling, one active import per tab and current geometry bounds. The 96 MiB geometry budget is not a total process-memory cap. Passing one 25.90 MiB file is not evidence that every smaller file will fit. Do not enlarge the ceiling merely to admit the 37.67 MiB sample; memory and target-hardware evidence should come first.

No result here establishes live Arena transfer speed, MCP authorization, source retrieval, automatic BOM-to-CAD mapping, GPU behavior or installed-extension compatibility. PDF/Word performance and larger document redlines remain a separate qualification track. The current results do not indicate that an outside AI or conversion service is required.

## Reproduce and extend

From an installed checkout, obtain the data outside the repository and run the frozen production converter:

```bash
npm run prepare:assets
node scripts/download-step-corpus.mjs --dest /tmp/review-step-corpus
node scripts/benchmark-step.mjs --runs 3 --out /tmp/review-step-results.json public/fixtures/step/atlas-assembly-A.step /tmp/review-step-corpus/*.step
```

The downloader validates exact sizes/hashes, preserves mismatched existing files and refuses destinations inside the checkout. The runner adds an external parent deadline and Linux sampled-RSS safety stop; it never raises production limits. Use [the method guide](step-benchmark-method.md) for metric definitions and runner options.

For browser measurements, start the development server and open `/scripts/performance/step-browser.html` on its printed origin. Choose each file, press **Load selected STEP**, run **Run 10 camera views**, close it, and repeat. Keep dimensions, quality and background workload consistent; download the JSON report. The diagnostic page is intentionally absent from the production website and extension. To check normal product tools, use **Open local test files → Open files** in the viewer.

## Evidence index

- [Source provenance and exact hashes](qa-large-step/corpus.json)
- Node conversion raw report (historical raw report omitted from this source export), conversion CSV (historical raw report omitted from this source export)
- Browser raw report (historical raw report omitted from this source export), browser CSV (historical raw report omitted from this source export)
- [Repeatable benchmark method](step-benchmark-method.md)
- [Current performance roadmap](performance-review.md)


## Final verification and packaging

| Verification | Result |
| --- | --- |
| TypeScript and automated suite | `npm run check` passed: 51 test files, 621 tests, including seven new benchmark source/output safety cases. |
| Production build | Supported Sites build helper completed the package's TypeScript/Vite build successfully. |
| Chrome package | Built Review Studio 0.7.0, 276 files, 6.70 MiB compressed. Static package validation passed; this is not an installed-extension runtime test. |
| Source/package scope | Confirmed external STEP bytes and development diagnostic page are absent from production runtime and extension. The portable source ZIP includes the harnesses, reports and provenance. |
| Report integrity | Independent reviewer recomputed both CSVs from JSON, verified source hashes and script identity, and reviewed measurement limits. Local report links resolve. |
| UI recovery | Fresh normal-app cancel/reopen restored Revo after exiting an active MiniSB import. Post-fix notice and measurement messages do not overlap. |

The extension archive SHA-256 is `c6b65e6150b3f22adec72e265bbe3c2530439224db17a939dac7ff6e0a18c1da`. It contains the same production runtime and the small warning-layout correction. No dependency or production geometry-policy changes were made for this work.
