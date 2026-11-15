/** Package the built browser application as a complete, local Manifest V3 viewer. */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import { initSync, parse as parseModule } from 'es-module-lexer';
import JSZip from 'jszip';

const EXTENSION_ICONS = ['icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png'];
const EXTENSION_FILES = ['manifest.json', 'background.js', 'launch-url.js', 'attachment-action.js', 'options.html', 'options.js', 'options.css', 'content-script.css', ...EXTENSION_ICONS];
const DIST_EXCLUDED = new Set(['developer', 'server', '_headers', '_redirects']);
const PACKAGE_DATE = new Date('2026-01-01T00:00:00Z');
initSync();

async function readTree(directory, prefix = '', files = new Map()) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.') || !prefix && DIST_EXCLUDED.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Extension packaging refuses symbolic links: ${relative}`);
    if (entry.isDirectory()) await readTree(join(directory, entry.name), relative, files);
    else if (entry.isFile()) files.set(relative, await readFile(join(directory, entry.name)));
  }
  return files;
}

function requireLocalResource(files, owner, value) {
  if (typeof value !== 'string' || !value || /^[a-z][a-z\d+.-]*:|^\/\//i.test(value) || /[\\\u0000-\u0020]/.test(value)) throw new Error(`Extension entry ${owner} references an external resource or invalid path: ${value}`);
  const resource = value.split(/[?#]/)[0];
  const path = posix.normalize(resource.startsWith('/') ? resource.slice(1) : posix.join(posix.dirname(owner), resource));
  if (path === '..' || path.startsWith('../') || !files.get(path)?.length) throw new Error(`Extension entry ${owner} references a missing resource: ${path}`);
}

/** Validate the shipped policy as a whole; an added directive must not relax it. */
function validateLocalPolicy(policy) {
  const expected = {
    'default-src': ["'self'"], 'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'object-src': ["'none'"], 'frame-src': ["'none'"], 'worker-src': ["'self'"],
    // The one outside host: the Claude API, reached only with the user's own key from the options.
    'connect-src': ["'self'", 'blob:', 'https://api.anthropic.com'], 'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:', 'blob:'], 'style-src': ["'self'", "'unsafe-inline'"],
    'base-uri': ["'self'"], 'form-action': ["'none'"],
  };
  const seen = new Set();
  for (const text of policy.split(';').map(value => value.trim()).filter(Boolean)) {
    const [name, ...sources] = text.split(/\s+/);
    if (seen.has(name) || !Object.hasOwn(expected, name) || sources.length !== expected[name].length || new Set(sources).size !== sources.length || sources.some(value => !expected[name].includes(value))) throw new Error(`The extension needs its local-only resource policy (${name}).`);
    seen.add(name);
  }
  for (const name of Object.keys(expected)) if (!seen.has(name)) throw new Error(`The extension needs its local-only resource policy (${name}).`);
}

/** Check actual import syntax plus Vite's emitted worker/preload/asset URL literals. */
function validateJavaScriptResources(files, name, code) {
  let imports;
  try { [imports] = parseModule(code, name); }
  catch { throw new Error(`The extension contains unreadable JavaScript in ${name}.`); }
  for (const dependency of imports) {
    if (typeof dependency.n !== 'string') continue; // Computed library imports still require runtime qualification.
    if (!/^(?:\.{1,2}\/|\/)/.test(dependency.n)) throw new Error(`Unbundled or external executable import in ${name}: ${dependency.n}`);
    requireLocalResource(files, name, dependency.n);
  }
  for (const match of code.matchAll(/\bimportScripts\s*\(\s*(["'])([^"']+)\1/g)) requireLocalResource(files, name, match[2]);
  // Vite emits root-based asset constants and preload arrays separately from
  // import declarations. This covers PDF/CAD/visual workers and lazy CSS too.
  for (const match of code.matchAll(/(["'])(\/?assets\/[^"'\\\s]+)\1/g)) requireLocalResource(files, 'index.html', match[2]);
}

function validateStyleResources(files, name, code) {
  for (const match of code.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (/^data:|^#/.test(value)) continue;
    requireLocalResource(files, name, value);
  }
  for (const match of code.matchAll(/@import\s+(["'])([^"']+)\1/gi)) requireLocalResource(files, name, match[2]);
}

function validateRuntimeManifest(files, version) {
  const runtime = JSON.parse(files.get('vendor/runtime-assets.json').toString());
  if (runtime.formatVersion !== 1 || runtime.viewerVersion !== version || !Array.isArray(runtime.assets)) throw new Error('The extension runtime asset manifest does not match the packaged version.');
  for (const [packageName, directory] of [['pdfjs-dist', 'vendor/pdfjs'], ['occt-import-js', 'vendor/occt']]) {
    const candidates = runtime.assets.filter(asset => asset.package === packageName);
    const asset = candidates[0];
    if (candidates.length !== 1 || asset.directory !== directory || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(asset.version ?? '') || !Array.isArray(asset.entries) || !asset.entries.length) throw new Error(`The extension runtime asset manifest is invalid for ${packageName}.`);
    for (const entry of asset.entries) {
      if (typeof entry !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(entry) || entry === '.' || entry === '..') throw new Error(`The extension runtime asset manifest has an invalid entry for ${packageName}.`);
      const path = `${directory}/${entry}`;
      if (!files.get(path)?.length && ![...files].some(([name, bytes]) => name.startsWith(`${path}/`) && bytes.length)) throw new Error(`Extension runtime is missing ${path}.`);
    }
  }
}

/** Validate real distribution boundaries; this is not an installed-Chrome test. */
export function validateExtensionPackage(files) {
  const requireFile = name => {
    if (!files.has(name) || files.get(name).length === 0) throw new Error(`Extension runtime is missing ${name}. Run the complete application build first.`);
  };
  for (const name of ['manifest.json', 'viewer.html', 'index.html', 'fixtures/manifest.json', 'vendor/runtime-assets.json', 'vendor/occt/occt-import-js.mjs', 'vendor/occt/occt-import-js.wasm', 'vendor/occt/LICENSE.md', 'content-script.js']) requireFile(name);
  for (const directory of ['vendor/pdfjs/cmaps/', 'vendor/pdfjs/standard_fonts/', 'vendor/pdfjs/wasm/']) {
    if (![...files.keys()].some(name => name.startsWith(directory))) throw new Error(`Extension runtime is missing ${directory}. Run the runtime asset preparation first.`);
  }
  const manifest = JSON.parse(files.get('manifest.json').toString());
  if (manifest.manifest_version !== 3 || manifest.background?.type !== 'module' || manifest.action?.default_popup) throw new Error('The extension must use Manifest V3 and open its packaged viewer from the toolbar.');
  const policy = manifest.content_security_policy?.extension_pages ?? '';
  validateLocalPolicy(policy);
  validateRuntimeManifest(files, manifest.version);
  for (const name of [manifest.background.service_worker, manifest.options_page, ...(manifest.content_scripts ?? []).flatMap(script => [...(script.js ?? []), ...(script.css ?? [])])]) requireFile(name);
  // Chrome and the Web Store need the declared toolbar and listing icons to be real packaged PNGs.
  for (const size of ['16', '48', '128']) {
    const icon = manifest.icons?.[size], bytes = icon && files.get(icon);
    if (!bytes || bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47 || bytes.readUInt32BE(16) !== Number(size) || bytes.readUInt32BE(20) !== Number(size)) throw new Error(`The extension needs a ${size} px PNG icon.`);
  }
  if (JSON.stringify(manifest.host_permissions ?? []) !== JSON.stringify(['https://api.anthropic.com/*']) || manifest.optional_host_permissions) throw new Error('The viewer extension may reach only its packaged files and the Claude API host.');
  if (manifest.externally_connectable || manifest.permissions?.some(permission => ['downloads', 'cookies', 'debugger', 'webRequest', 'webRequestBlocking'].includes(permission))) throw new Error('Unexpected privileged capability in the viewer extension.');
  for (const [name, bytes] of files) {
    if (name.startsWith('developer/') || name.endsWith('.zip') || /(?:^|\/)\.env(?:\.|$)/.test(name)) throw new Error(`A development artifact or environment file entered the extension: ${name}`);
    if (name.endsWith('.html')) {
      const html = bytes.toString();
      for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const source = match[1].match(/\bsrc=["']([^"']+)["']/i);
        if (!source || match[2].trim()) throw new Error(`Inline executable code is not allowed in ${name}.`);
        requireLocalResource(files, name, source[1]);
      }
      for (const match of html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) requireLocalResource(files, name, match[1]);
    }
    if (/\.(?:m?js)$/.test(name)) validateJavaScriptResources(files, name, bytes.toString());
    if (name.endsWith('.css')) validateStyleResources(files, name, bytes.toString());
  }
  return { version: manifest.version, fileCount: files.size };
}

export async function buildExtension(projectRoot = process.cwd()) {
  const root = resolve(projectRoot);
  const files = await readTree(join(root, 'dist'));
  if (!files.has('index.html')) throw new Error('Build the application before packaging the extension.');
  for (const name of EXTENSION_FILES) {
    if (files.has(name)) throw new Error(`Application output conflicts with extension entry ${name}.`);
    files.set(name, await readFile(join(root, 'extension', name)));
  }
  files.set('viewer.html', Buffer.from(files.get('index.html')));

  // Chrome content scripts are classic scripts. Bundle the small DOM bridge and
  // shared validators locally; the application retains its separate Vite build.
  const result = await viteBuild({
    root, configFile: false, logLevel: 'silent',
    build: {
      write: false, minify: false, sourcemap: false,
      lib: { entry: join(root, 'extension/content-script.js'), name: 'ReviewStudioArenaBridge', formats: ['iife'] },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(bundle => bundle.output ?? []);
  const chunks = outputs.filter(output => output.type === 'chunk');
  if (chunks.length !== 1 || outputs.length !== 1) throw new Error('The Arena bridge must be one local script without external assets.');
  files.set('content-script.js', Buffer.from(chunks[0].code));
  files.set('INSTALL.md', await readFile(join(root, 'docs/chrome-extension.md')));
  const summary = validateExtensionPackage(files);
  const checksums = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => `${createHash('sha256').update(data).digest('hex')}  ${name}`).join('\n');
  files.set('checksums.sha256', Buffer.from(`${checksums}\n`));

  const output = join(root, 'build/extension');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const zip = new JSZip();
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    await mkdir(dirname(join(output, name)), { recursive: true });
    await writeFile(join(output, name), bytes);
    zip.file(name, bytes, { date: PACKAGE_DATE });
  }
  const archivePath = join(root, 'dist/developer/review-studio-extension.zip');
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, archive);
  const checksum = createHash('sha256').update(archive).digest('hex');
  await writeFile(`${archivePath}.sha256`, `${checksum}  review-studio-extension.zip\n`);
  return { output, archivePath, archiveBytes: archive.length, sha256: checksum, version: summary.version, fileCount: files.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildExtension();
  console.log(`Packaged Review Studio ${result.version}: ${result.fileCount} files, ${(result.archiveBytes / 1024 / 1024).toFixed(2)} MiB.\nUnpacked: ${result.output}\nArchive: ${result.archivePath}\nSHA-256: ${result.sha256}`);
}
