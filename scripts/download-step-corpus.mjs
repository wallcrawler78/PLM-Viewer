/** Download the recorded public CAD corpus to an explicitly external directory. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(projectRoot, 'docs/qa-large-step/corpus.json');
const allowedHosts = new Set(['raw.githubusercontent.com', 'www.steptools.com', 'zenodo.org']);
const sourceDeadlineMs = 60_000;
const maxFileBytes = 40 * 1024 * 1024;
const shutdown = new AbortController();
process.once('SIGINT', () => shutdown.abort(new Error('Download canceled.')));
process.once('SIGTERM', () => shutdown.abort(new Error('Download canceled.')));

function parseArguments(args) {
  const config = { destination: undefined, selected: new Set(), list: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--list') { config.list = true; continue; }
    if (arg !== '--dest' && arg !== '--file') throw new Error(`Unknown argument: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    if (arg === '--dest') {
      if (config.destination) throw new Error('Supply --dest once.');
      config.destination = resolve(value);
    } else config.selected.add(value);
  }
  if (!config.list && !config.destination) throw new Error('Supply --dest with a directory outside this repository. See --help.');
  return config;
}

function checkedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new Error('The corpus contains an unsupported download URL.');
  return url;
}

async function readManifest() {
  if ((await lstat(manifestPath)).size > 64 * 1024) throw new Error('The corpus manifest exceeds its size limit.');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length !== 5) throw new Error('The corpus manifest format changed. Review this downloader.');
  const names = new Set();
  let total = 0;
  for (const file of manifest.files) {
    if (!/^[a-z0-9][a-z0-9-]*\.step$/.test(file.name) || names.has(file.name)) throw new Error('The corpus has an invalid or duplicate filename.');
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > maxFileBytes || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('The corpus has an invalid byte length or SHA-256.');
    if (file.publisherMd5 !== undefined && !/^[a-f0-9]{32}$/.test(file.publisherMd5)) throw new Error('The corpus has an invalid publisher MD5.');
    checkedUrl(file.downloadUrl);
    names.add(file.name); total += file.bytes;
  }
  if (total > 128 * 1024 * 1024) throw new Error('The corpus exceeds its total byte limit.');
  return manifest.files;
}

// Resolve existing ancestors before creating anything, so a symlink cannot
// turn an apparently external destination into public/, dist/ or this checkout.
async function canonicalDestination(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), basename(path));
  }
}

function requireExternal(destination, root) {
  const path = relative(root, destination);
  if (!path || (!path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && path !== '..' && !isAbsolute(path))) throw new Error('Choose --dest outside the repository; CAD samples must not enter public/, dist/, build/ or source control.');
}

function fingerprints(file) {
  return { sha256: createHash('sha256'), md5: file.publisherMd5 ? createHash('md5') : undefined };
}
function verifyFingerprints(file, hashes, bytes) {
  if (bytes !== file.bytes || hashes.sha256.digest('hex') !== file.sha256 || (hashes.md5 && hashes.md5.digest('hex') !== file.publisherMd5)) throw new Error(`${file.name}: byte length or fingerprint mismatch; no existing file was overwritten.`);
}

async function existingIsValid(path, file) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isFile() || info.size !== file.bytes) throw new Error(`${file.name}: an existing destination does not match the corpus. Move it explicitly before retrying; it was preserved.`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== file.bytes || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error(`${file.name}: the existing file changed during verification.`);
    const hashes = fingerprints(file);
    let bytes = 0;
    for await (const chunk of createReadStream('', { fd: handle.fd, autoClose: false })) {
      shutdown.signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > file.bytes) throw new Error(`${file.name}: the existing file grew during verification; it was preserved.`);
      hashes.sha256.update(chunk); hashes.md5?.update(chunk);
    }
    verifyFingerprints(file, hashes, bytes);
    return true;
  } finally { await handle.close(); }
}

async function requestFile(sourceUrl, signal) {
  const original = checkedUrl(sourceUrl);
  let url = original;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, { redirect: 'manual', credentials: 'omit', signal, headers: { 'Accept-Encoding': 'identity' } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 3) throw new Error('Download exceeded its redirect limit or has no redirect target.');
      url = checkedUrl(new URL(location, url).href);
      if (url.origin !== original.origin) throw new Error('A corpus download redirected to another origin. Review the manifest before retrying.');
      continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Download returned HTTP ${response.status}.`); }
    return response;
  }
  throw new Error('Download exceeded its redirect limit.');
}

async function download(file, destination) {
  const finalPath = join(destination, file.name);
  if (await existingIsValid(finalPath, file)) { console.log(`${file.name}: existing file verified; skipped.`); return; }
  const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(sourceDeadlineMs)]);
  const temporary = join(destination, `.download-${file.name}-${randomUUID()}.part`);
  let handle, response;
  try {
    response = await requestFile(file.downloadUrl, signal);
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== file.bytes) { await response.body.cancel(); throw new Error(`${file.name}: the published byte length changed.`); }
    handle = await open(temporary, 'wx', 0o600);
    const hashes = fingerprints(file);
    let bytes = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > file.bytes) throw new Error(`${file.name}: response exceeded its recorded byte limit.`);
      hashes.sha256.update(chunk); hashes.md5?.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error(`${file.name}: could not write downloaded bytes.`);
        offset += bytesWritten;
      }
    }
    verifyFingerprints(file, hashes, bytes);
    await handle.sync(); await handle.close(); handle = undefined;
    // Linking atomically refuses replacement if another writer creates the
    // final name while downloading. The temporary file is on the same volume.
    await link(temporary, finalPath);
    console.log(`${file.name}: downloaded and verified (${bytes} bytes).`);
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function main() {
  const config = parseArguments(process.argv.slice(2));
  if (config.help) {
    console.log(`Usage: node scripts/download-step-corpus.mjs --dest /absolute/external/step-corpus [--file NAME ...]
       node scripts/download-step-corpus.mjs --list

Downloads the five public STEP sources recorded in docs/qa-large-step/corpus.json.
Node.js 22+; no extra dependencies. --dest is required and must be outside this
repository, including public/, dist/ and build/. --file selects one or more
manifest filenames; omit it for all five. --list shows the corpus without network requests.

Downloads are sequential HTTPS requests with a 60-second deadline per file,
up to three same-origin redirects and an exact recorded byte ceiling. SHA-256,
size and any publisher MD5 must match before the final filename is created.
Valid existing files are skipped. Existing mismatches are preserved and stop
the command. Failed partial downloads are removed; no conversion is performed.
The 37.67 MiB sample is intentionally larger than the viewer's 32 MiB limit.
Consult the manifest's provenance and license notes before redistribution.

Example:
  node scripts/download-step-corpus.mjs --dest /tmp/review-step-corpus
  node scripts/benchmark-step.mjs --out /tmp/step-results.json /tmp/review-step-corpus/*.step`);
    return;
  }
  const allFiles = await readManifest();
  for (const name of config.selected) if (!allFiles.some(file => file.name === name)) throw new Error(`Unknown corpus filename: ${name}`);
  const files = allFiles.filter(file => !config.selected.size || config.selected.has(file.name));
  if (config.list) { for (const file of files) console.log(`${file.name}\t${file.bytes}\t${file.sha256}`); return; }
  const root = await realpath(projectRoot);
  const destination = await canonicalDestination(config.destination);
  requireExternal(destination, root);
  await mkdir(destination, { recursive: true });
  const actualDestination = await realpath(destination);
  requireExternal(actualDestination, root);
  for (const file of files) { shutdown.signal.throwIfAborted(); await download(file, actualDestination); }
  console.log(`Corpus ready: ${actualDestination}`);
}

try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : 'Corpus download failed.'); process.exitCode = 1; }
