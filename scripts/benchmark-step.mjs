/**
 * Reproducible, bounded CLI qualification of the viewer's local STEP pipeline.
 * This measures conversion in Node; it does not measure a browser or GPU.
 * Each run owns a fresh child process and the production limits stay intact.
 */
import { fork, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, Script } from 'node:vm';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
let activeChild;
const round = value => Math.round(value * 100) / 100;
const memory = () => ({ ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS });
const message = error => error instanceof Error ? error.message.slice(0, 512) : 'Unknown benchmark failure';

/** Read a stable regular-file snapshot without allocating or reading past the source cap. */
export async function readBoundedStepSource(file, maximumBytes, expectedSize) {
  const handle = await open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('The STEP source must be a regular file.');
    if (before.size <= 0n || before.size > BigInt(maximumBytes)) throw new Error('This STEP exceeds the 32 MiB local import limit or is empty.');
    if (expectedSize !== undefined && before.size !== BigInt(expectedSize)) throw new Error('The STEP source changed before reading. Retry with a stable source.');
    const size = Number(before.size);
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, Math.min(64 * 1024, size - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const [after, currentPath] = await Promise.all([handle.stat({ bigint: true }), stat(file, { bigint: true })]);
    const unchanged = candidate => candidate.dev === before.dev && candidate.ino === before.ino
      && candidate.size === before.size && candidate.mtimeNs === before.mtimeNs && candidate.ctimeNs === before.ctimeNs;
    if (offset !== size || !unchanged(after) || !unchanged(currentPath)) throw new Error('The STEP source changed while reading. Retry with a stable source.');
    return buffer;
  } finally { await handle.close(); }
}

/** Atomic checkpoints never follow an existing output/temp symlink into a source. */
export async function createReportWriter(requestedOutput, files) {
  const requested = resolve(requestedOutput);
  if (extname(requested).toLowerCase() !== '.json') throw new Error('--out must name a JSON report, not a source file.');
  await mkdir(dirname(requested), { recursive: true });
  const directory = await realpath(dirname(requested));
  const output = join(directory, basename(requested));
  const sources = files.map(file => resolve(file));
  const assertSafe = async () => {
    if (await realpath(directory) !== directory) throw new Error('The report directory changed. Choose a stable output directory.');
    let target;
    try { target = await lstat(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (target?.isSymbolicLink()) throw new Error('The report path must not be a symbolic link.');
    if (target && !target.isFile()) throw new Error('The report path must be a regular JSON file.');
    for (const file of sources) {
      const [sourcePath, source] = await Promise.all([realpath(file), stat(file)]);
      if (sourcePath === output || target && target.dev === source.dev && target.ino === source.ino) {
        throw new Error('The report path aliases an input source. Choose a separate output file.');
      }
    }
  };
  await assertSafe();
  return {
    output,
    async write(report) {
      const serialized = `${JSON.stringify(report, null, 2)}\n`;
      await assertSafe();
      const temporary = join(directory, `.${basename(output)}.${randomUUID()}.tmp`);
      let owned = false;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        owned = true;
        try { await handle.writeFile(serialized); } finally { await handle.close(); }
        await assertSafe();
        // rename replaces an output directory entry; it does not follow a
        // symlink introduced after the check into another file's contents.
        await rename(temporary, output);
        owned = false;
      } finally { if (owned) await rm(temporary, { force: true }); }
    },
  };
}

async function childRun(config) {
  const childStart = performance.now();
  const stages = {};
  const snapshots = { childStart: memory() };
  const usageStart = process.resourceUsage();
  let sourceHash, geometry, wasmCapacityBytes = 0, rawGeometry, lastStage = 'prepare';
  let kernelStarted, kernelReturned, diagnosticsMs = 0;
  const progress = stage => {
    lastStage = stage;
    process.send?.({ type: 'progress', stage });
  };
  let outcome;
  try {
    const { importStepBytes, STEP_LIMITS } = await import(pathToFileURL(config.bundlePath).href);
    progress('read-source');
    let started = performance.now();
    const bytes = await readBoundedStepSource(config.file, STEP_LIMITS.maxSourceBytes, config.expectedSize);
    stages.sourceReadMs = round(performance.now() - started);
    snapshots.afterRead = memory();

    // Fingerprinting is reported separately. importStepBytes verifies the exact
    // fingerprint again, as it does for an identity-bound source in the viewer.
    started = performance.now();
    sourceHash = createHash('sha256').update(bytes).digest('hex');
    stages.fingerprintMs = round(performance.now() - started);

    progress('initialize-runtime');
    started = performance.now();
    const runtimeDirectory = join(projectRoot, 'public/vendor/occt');
    const [packagedLoader, wasmBinary] = await Promise.all([
      readFile(join(runtimeDirectory, 'occt-import-js.mjs'), 'utf8'),
      readFile(join(runtimeDirectory, 'occt-import-js.wasm')),
    ]);
    // The browser's packaged loader is unchanged except for its terminal ESM
    // export, which the trusted Node VM evaluates as its existing CJS export.
    const suffix = /\nexport default occtimportjs;\s*$/;
    if (!suffix.test(packagedLoader)) throw new Error('The packaged CAD loader export changed. Review the benchmark adapter.');
    const context = createContext({
      module: { exports: {} }, exports: {},
      require: createRequire(join(runtimeDirectory, 'occt-import-js.cjs')),
      __dirname: runtimeDirectory, process, console, TextDecoder, TextEncoder,
      setTimeout, clearTimeout,
    }, { codeGeneration: { strings: false, wasm: true } });
    new Script(packagedLoader.replace(suffix, '\n'), { filename: 'packaged-occt-import-js.cjs' }).runInContext(context);
    const importer = await context.module.exports({ wasmBinary, print: () => {}, printErr: () => {} });
    stages.runtimeInitializationMs = round(performance.now() - started);
    wasmCapacityBytes = importer.HEAPU8?.buffer.byteLength ?? 0;
    snapshots.afterRuntimeInitialization = memory();

    progress('production-import');
    const importStart = performance.now();
    const measuredImporter = {
      ReadStepFile(source, options) {
        progress('kernel');
        kernelStarted = performance.now();
        stages.sourceVerificationMs = round(kernelStarted - importStart);
        let raw;
        try { raw = importer.ReadStepFile(source, options); }
        finally {
          kernelReturned = performance.now();
          stages.kernelMs = round(kernelReturned - kernelStarted);
          wasmCapacityBytes = importer.HEAPU8?.buffer.byteLength ?? wasmCapacityBytes;
          snapshots.afterKernel = memory();
          diagnosticsMs += performance.now() - kernelReturned;
        }
        const observationStart = performance.now();
        if (Array.isArray(raw?.meshes)) {
          rawGeometry = {
            meshes: raw.meshes.length,
            vertices: raw.meshes.reduce((sum, mesh) => sum + (mesh?.attributes?.position?.array?.length ?? 0) / 3, 0),
            triangles: raw.meshes.reduce((sum, mesh) => sum + (mesh?.index?.array?.length ?? 0) / 3, 0),
          };
        }
        progress('normalize-and-validate');
        diagnosticsMs += performance.now() - observationStart;
        return raw;
      },
    };
    let result;
    try { result = await importStepBytes(measuredImporter, bytes, sourceHash); }
    finally {
      const importEnd = performance.now();
      stages.productionImportMs = round(importEnd - importStart);
      if (kernelReturned !== undefined) stages.postKernelValidationMs = round(Math.max(0, importEnd - kernelReturned - diagnosticsMs));
      stages.diagnosticsMs = round(diagnosticsMs);
    }
    snapshots.afterValidation = memory();
    let hierarchyNodes = 0, hierarchyDepth = 0;
    const visit = (node, depth) => {
      hierarchyNodes++;
      hierarchyDepth = Math.max(hierarchyDepth, depth);
      node.children.forEach(child => visit(child, depth + 1));
    };
    visit(result.hierarchy, 0);
    geometry = {
      meshes: result.meshRanges.length,
      vertices: result.positions.length / 3,
      triangles: result.indices.length / 3,
      typedBufferBytes: result.positions.byteLength + result.normals.byteLength + result.indices.byteLength,
      hierarchyNodes, hierarchyDepth, boundsMm: result.bounds, warnings: result.warnings,
    };
    outcome = { status: 'imported' };
  } catch (error) {
    outcome = { status: 'rejected', error: message(error), failedStage: lastStage };
  }
  const usage = process.resourceUsage();
  const result = {
    ...outcome, sourceHash: sourceHash ?? null, stages,
    childElapsedMs: round(performance.now() - childStart),
    cpuMs: { user: round((usage.userCPUTime - usageStart.userCPUTime) / 1000), system: round((usage.systemCPUTime - usageStart.systemCPUTime) / 1000) },
    processPeakRssKiB: usage.maxRSS, wasmCapacityBytes, memorySnapshots: snapshots,
    ...(rawGeometry ? { rawGeometry } : {}), ...(geometry ? { geometry } : {}),
  };
  if (process.send) await new Promise(resolve => process.send({ type: 'result', result }, resolve));
  process.exit(0);
}

function argumentsForParent(args) {
  const config = { runs: 3, timeoutMs: 120_000, rssLimitMiB: 2048, files: [], output: undefined };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (['--runs', '--timeout-ms', '--rss-limit-mib', '--out'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--out') config.output = resolve(value);
      else config[arg === '--runs' ? 'runs' : arg === '--timeout-ms' ? 'timeoutMs' : 'rssLimitMiB'] = Number(value);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else config.files.push(resolve(arg));
  }
  if (!config.files.length || config.files.length > 20) throw new Error('Supply between one and twenty local STEP/STP files.');
  if (!Number.isSafeInteger(config.runs) || config.runs < 1 || config.runs > 5) throw new Error('--runs must be between 1 and 5.');
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 120_000) throw new Error('--timeout-ms must be between 1000 and 120000.');
  if (!Number.isSafeInteger(config.rssLimitMiB) || config.rssLimitMiB < 128 || config.rssLimitMiB > 2048) throw new Error('--rss-limit-mib must be between 128 and 2048.');
  if (config.files.some(file => !['.step', '.stp'].includes(extname(file).toLowerCase()))) throw new Error('Only STEP/STP paths are accepted.');
  return config;
}

async function readIfPresent(path) { try { return (await readFile(path, 'utf8')).trim(); } catch { return null; } }

async function executeSample(config, bundlePath, file, expectedSize) {
  const start = performance.now();
  const child = fork(scriptPath, ['--child', JSON.stringify({ file, bundlePath, expectedSize })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  activeChild = child;
  let lastStage = 'process-start', response, forced, diagnostics = '', sampledPeakRssBytes = 0, polling = false;
  let finished = false;
  const capture = chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2048); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.on('message', input => {
    if (input?.type === 'progress') lastStage = input.stage;
    if (input?.type === 'result') response = input.result;
  });
  const stop = reason => {
    if (finished || forced || response) return;
    forced = reason;
    child.kill('SIGKILL');
  };
  const timeout = setTimeout(() => stop('timeout'), config.timeoutMs);
  // A separate process can sample and stop a child while synchronous WASM runs.
  // Linux RSS sampling is approximate and can overshoot between 100 ms samples.
  const rssTimer = setInterval(async () => {
    if (finished || polling || !child.pid || platform() !== 'linux') return;
    polling = true;
    try {
      const status = await readFile(`/proc/${child.pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) {
        const rss = Number(match[1]) * 1024;
        sampledPeakRssBytes = Math.max(sampledPeakRssBytes, rss);
        if (rss > config.rssLimitMiB * 1024 * 1024) stop('rss-safety-ceiling');
      }
    } catch { /* The child may have already exited. */ }
    finally { polling = false; }
  }, 100);
  const termination = await new Promise(resolve => {
    child.once('error', error => resolve({ launchError: message(error) }));
    child.once('exit', (code, signal) => resolve({ exitCode: code, exitSignal: signal }));
  });
  finished = true;
  activeChild = undefined;
  clearTimeout(timeout); clearInterval(rssTimer);
  const parentMetrics = { parentElapsedMs: round(performance.now() - start), sampledPeakRssBytes, ...termination };
  if (forced) return { status: forced === 'timeout' ? 'timed-out' : 'safety-stopped', reason: forced, failedStage: lastStage, ...parentMetrics };
  if (response) return { ...response, ...parentMetrics };
  // Kernel diagnostics are not printed or stored: they may contain source text.
  return { status: 'crashed', failedStage: lastStage, diagnosticCharactersDiscarded: diagnostics.length, ...parentMetrics };
}

async function parentMain() {
  const config = argumentsForParent(process.argv.slice(2));
  if (config.help) {
    console.log('Usage: node scripts/benchmark-step.mjs [--runs 1..5] [--out /absolute/report.json] [--timeout-ms 1000..120000] [--rss-limit-mib 128..2048] /path/model.step [...]');
    console.log('Runs are sequential fresh processes. Defaults: 3 runs, 120 s total child deadline, 2048 MiB sampled Linux RSS safety ceiling. Source and geometry limits are unchanged.');
    return;
  }
  const writer = await createReportWriter(config.output ?? join(tmpdir(), `review-step-benchmark-${Date.now()}.json`), config.files);
  const output = writer.output;
  const temporary = await mkdtemp(join(tmpdir(), 'review-step-benchmark-'));
  try {
    const { build } = await import('esbuild'); // Existing pinned Vite dependency.
    const bundlePath = join(temporary, 'production-step.mjs');
    await build({
      stdin: { contents: `export * from ${JSON.stringify(join(projectRoot, 'src/cad/step-import.ts'))}; export { STEP_LIMITS } from ${JSON.stringify(join(projectRoot, 'src/cad/step-types.ts'))};`, resolveDir: projectRoot },
      bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: bundlePath, logLevel: 'silent',
    });
    const { STEP_LIMITS, STEP_TESSELLATION } = await import(pathToFileURL(bundlePath).href);
    if (config.timeoutMs > STEP_LIMITS.importTimeoutMs) throw new Error('The benchmark deadline must not exceed the production import deadline.');
    const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    const runtimeDirectory = join(projectRoot, 'public/vendor/occt');
    const [loader, wasm] = await Promise.all([readFile(join(runtimeDirectory, 'occt-import-js.mjs')), readFile(join(runtimeDirectory, 'occt-import-js.wasm'))]);
    let commit = null;
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Portable source has no Git metadata. */ }
    const report = {
      schemaVersion: 1, startedAt: new Date().toISOString(), completedAt: null,
      application: { version: manifest.version, commit, importer: manifest.dependencies['occt-import-js'], loaderSha256: createHash('sha256').update(loader).digest('hex'), wasmSha256: createHash('sha256').update(wasm).digest('hex'), productionBundleSha256: createHash('sha256').update(await readFile(bundlePath)).digest('hex'), benchmarkScriptSha256: createHash('sha256').update(await readFile(scriptPath)).digest('hex') },
      environment: { node: process.version, v8: process.versions.v8, platform: platform(), release: release(), architecture: process.arch, cpuModel: cpus()[0]?.model ?? null, logicalCpus: cpus().length, reportedSystemMemoryBytes: totalmem(), cpuQuota: await readIfPresent('/sys/fs/cgroup/cpu.max'), cgroupMemoryMax: await readIfPresent('/sys/fs/cgroup/memory.max') },
      method: {
        freshProcessPerRun: true, sequential: true, runs: config.runs,
        childDeadlineMs: config.timeoutMs, linuxRssSafetyCeilingBytes: config.rssLimitMiB * 1024 * 1024, linuxRssSampleIntervalMs: 100,
        stepLimits: STEP_LIMITS, tessellation: STEP_TESSELLATION,
        limits: [
          'Node conversion only; no browser fetch, structured-clone transfer, main-thread scene construction, GPU, or interaction measurements.',
          'Fresh process does not flush operating-system filesystem caches; no cold-network claim.',
          'Process peak RSS includes Node, source bytes, WASM, raw output and normalized buffers. It is not browser-tab memory or retained geometry.',
          'WASM capacity is allocated linear-memory capacity, not live allocations; parent RSS safety sampling is Linux-only and can overshoot.',
          'Child deadline includes startup, local read, fingerprint, runtime initialization and production import, making it more conservative than the viewer worker deadline.',
          'Source bytes, production tessellation and validation limits are not raised. Oversized files are refused before reading/importing.',
        ],
      }, samples: [],
    };
    const checkpoint = () => writer.write(report);
    await checkpoint();
    for (const file of config.files) {
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`${basename(file)} is not a regular file.`);
      const sample = { file, name: basename(file), bytes: info.size, runs: [] };
      report.samples.push(sample);
      if (!info.size || info.size > STEP_LIMITS.maxSourceBytes) {
        sample.runs.push({ status: 'blocked-source-size', error: 'This STEP exceeds the 32 MiB local import limit or is empty.', imported: false });
        console.log(`${sample.name}: blocked before import (${sample.bytes} bytes).`);
        await checkpoint();
        continue;
      }
      for (let run = 1; run <= config.runs; run++) {
        console.log(`${sample.name}: run ${run}/${config.runs} starting (${sample.bytes} bytes).`);
        const result = await executeSample(config, bundlePath, file, info.size);
        sample.runs.push({ run, ...result });
        await checkpoint();
        console.log(`${sample.name}: ${result.status}; ${result.stages?.productionImportMs ?? result.parentElapsedMs} ms; ${result.geometry?.triangles ?? result.rawGeometry?.triangles ?? '?'} triangles; peak RSS ${result.processPeakRssKiB ? round(result.processPeakRssKiB / 1024) : round(result.sampledPeakRssBytes / 1024 / 1024)} MiB.`);
        // Repeating a resource stop adds risk without useful timing statistics.
        if (['timed-out', 'safety-stopped', 'crashed'].includes(result.status)) break;
      }
    }
    report.completedAt = new Date().toISOString();
    await checkpoint();
    console.log(`Report: ${output}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  if (process.argv[2] === '--child') {
    await childRun(JSON.parse(process.argv[3]));
  } else {
    process.once('SIGINT', () => { activeChild?.kill('SIGKILL'); process.exit(130); });
    process.once('SIGTERM', () => { activeChild?.kill('SIGKILL'); process.exit(143); });
    try { await parentMain(); }
    catch (error) { console.error(message(error)); process.exitCode = 1; }
  }
}
