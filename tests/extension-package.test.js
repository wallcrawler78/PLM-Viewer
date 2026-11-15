import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { buildExtension, validateExtensionPackage } from '../scripts/build-extension.mjs';

const temporary = [];
afterAll(async () => { for (const path of temporary) await rm(path, { recursive: true, force: true }); });

describe('complete extension artifact', () => {
  let root, result, files, fixture, application, bytes;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'review-studio-extension-'));
    temporary.push(root);
    const source = resolve(import.meta.dirname, '..');
    await cp(join(source, 'extension'), join(root, 'extension'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await cp(join(source, 'docs/chrome-extension.md'), join(root, 'docs/chrome-extension.md'));
    application = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    fixture = {
      'index.html': '<html><head><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body></body></html>',
      'assets/app.js': 'import "./shared.js"; export const load = () => import("./lazy.js"); const pdfWorker = "/assets/pdf.worker-local.mjs"; new Worker(new URL("/assets/step.worker-local.js", import.meta.url)); const preload = ["assets/visual-diff.worker-local.js"];',
      'assets/shared.js': 'export const shared = true;', 'assets/lazy.js': 'export const local = true;',
      'assets/pdf.worker-local.mjs': 'export const worker = true;', 'assets/step.worker-local.js': 'self.onmessage = () => {};', 'assets/visual-diff.worker-local.js': 'self.onmessage = () => {};',
      'assets/app.css': '@font-face{font-family:Review;src:url(/assets/review.woff2)}body{color:#123}', 'assets/review.woff2': 'local font',
      'fixtures/manifest.json': '{}',
      'vendor/runtime-assets.json': JSON.stringify({ formatVersion: 1, viewerVersion: application.version, assets: [
        { package: 'pdfjs-dist', version: application.dependencies['pdfjs-dist'], directory: 'vendor/pdfjs', entries: ['cmaps', 'standard_fonts', 'wasm', 'LICENSE'] },
        { package: 'occt-import-js', version: application.dependencies['occt-import-js'], directory: 'vendor/occt', entries: ['occt-import-js.mjs', 'occt-import-js.wasm', 'LICENSE.md', 'NOTICE.txt'] },
      ] }),
      'vendor/occt/occt-import-js.mjs': 'export const localCad = true;',
      'vendor/occt/occt-import-js.wasm': 'local wasm', 'vendor/occt/LICENSE.md': 'license', 'vendor/occt/NOTICE.txt': 'notice', 'vendor/pdfjs/LICENSE': 'license',
      'vendor/pdfjs/cmaps/test.bcmap': 'map', 'vendor/pdfjs/standard_fonts/font.pfb': 'font', 'vendor/pdfjs/wasm/decoder.wasm': 'decoder',
      'developer/arena-review-source.zip': 'must not be repackaged', 'developer/review-studio-extension.zip': 'must not recurse',
      'server/private.mjs': 'must not enter the extension', '.env.private': 'must not enter the extension', '_headers': 'hosting policy only',
    };
    for (const [name, value] of Object.entries(fixture)) {
      await mkdir(join(root, 'dist', name, '..'), { recursive: true });
      await writeFile(join(root, 'dist', name), value);
    }
    result = await buildExtension(root);
    bytes = await readFile(result.archivePath);
    const archive = await JSZip.loadAsync(bytes);
    files = new Map();
    for (const entry of Object.values(archive.files)) if (!entry.dir) files.set(entry.name, await entry.async('nodebuffer'));
  }, 20000);

  it('packages local runtime assets and entry points without development or server artifacts', async () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.sha256);
    expect(validateExtensionPackage(files).version).toBe(application.version);
    expect(files.has('viewer.html')).toBe(true);
    expect(files.has('vendor/occt/occt-import-js.wasm')).toBe(true);
    expect(files.has('INSTALL.md')).toBe(true);
    expect([...files.keys()].some(name => name.startsWith('developer/') || name.startsWith('server/') || name.startsWith('.env'))).toBe(false);
    expect(files.get('content-script.js').toString()).toContain('review-studio-open-attachment');
    expect(files.get('content-script.js').toString()).not.toMatch(/^import\s/m);
    expect(await readFile(join(result.output, 'viewer.html'), 'utf8')).toBe(fixture['index.html']);

    const missing = new Map(files); missing.delete('vendor/occt/occt-import-js.wasm');
    expect(() => validateExtensionPackage(missing)).toThrow('missing vendor/occt');
    const remote = new Map(files); remote.set('viewer.html', Buffer.from('<script src="https://cdn.example/remote.js"></script>'));
    expect(() => validateExtensionPackage(remote)).toThrow('external resource');
    const inline = new Map(files); inline.set('viewer.html', Buffer.from('<script>alert(1)</script>'));
    expect(() => validateExtensionPackage(inline)).toThrow('Inline executable');
    const absent = new Map(files); absent.delete('assets/app.js');
    expect(() => validateExtensionPackage(absent)).toThrow('missing resource');
  });

  it.each(['assets/shared.js', 'assets/lazy.js', 'assets/pdf.worker-local.mjs', 'assets/step.worker-local.js', 'assets/visual-diff.worker-local.js', 'assets/review.woff2'])('rejects a missing emitted runtime reference: %s', path => {
    const missing = new Map(files); missing.delete(path);
    expect(() => validateExtensionPackage(missing)).toThrow('missing resource');
  });

  it.each([
    'import "pdfjs-dist";',
    'export const load = () => import(/* resolved runtime */ "https://cdn.example/worker.mjs");',
    String.raw`export { worker } from "https:\u002f\u002fcdn.example/worker.mjs";`,
  ])('rejects an unbundled or external parsed import: %s', code => {
    const invalid = new Map(files); invalid.set('assets/app.js', Buffer.from(code));
    expect(() => validateExtensionPackage(invalid)).toThrow('external executable import');
  });

  it('does not confuse comments or string examples with executable imports', () => {
    const valid = new Map(files);
    valid.set('assets/lazy.js', Buffer.from('// import "https://example.invalid/example.js";\nexport const sample = \'import("https://example.invalid/example.js")\';'));
    expect(() => validateExtensionPackage(valid)).not.toThrow();
  });

  it('rejects external stylesheet/font resources and accepts a query on a packaged asset', () => {
    const remote = new Map(files); remote.set('assets/app.css', Buffer.from('@font-face{src:url(https://fonts.example/review.woff2)}'));
    expect(() => validateExtensionPackage(remote)).toThrow('external resource');
    const valid = new Map(files); valid.set('assets/app.css', Buffer.from('@font-face{src:url(/assets/review.woff2?v=1)}'));
    expect(() => validateExtensionPackage(valid)).not.toThrow();
  });

  it('rejects a stale runtime manifest or a missing declared dependency notice', () => {
    const stale = new Map(files), runtime = JSON.parse(stale.get('vendor/runtime-assets.json'));
    runtime.viewerVersion = '0.0.0'; stale.set('vendor/runtime-assets.json', Buffer.from(JSON.stringify(runtime)));
    expect(() => validateExtensionPackage(stale)).toThrow('does not match');
    const missing = new Map(files); missing.delete('vendor/occt/NOTICE.txt');
    expect(() => validateExtensionPackage(missing)).toThrow('missing vendor/occt/NOTICE.txt');
  });

  it.each([[['https://api.anthropic.com/*', 'https://example.com/*']], [['<all_urls>']], [['https://*/*']], [[]]])('rejects any host access other than the Claude API: %j', hosts => {
    const invalid = new Map(files), manifest = JSON.parse(invalid.get('manifest.json'));
    manifest.host_permissions = hosts;
    invalid.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    expect(() => validateExtensionPackage(invalid)).toThrow('only its packaged files and the Claude API host');
    const optional = new Map(files), other = JSON.parse(optional.get('manifest.json'));
    other.optional_host_permissions = ['https://example.com/*'];
    optional.set('manifest.json', Buffer.from(JSON.stringify(other)));
    expect(() => validateExtensionPackage(optional)).toThrow('only its packaged files and the Claude API host');
  });

  it.each([
    ["worker-src 'self'", "worker-src 'self' blob:"],
    ["connect-src 'self' blob: https://api.anthropic.com", "connect-src 'self' blob: https:"],
    ["connect-src 'self' blob: https://api.anthropic.com", "connect-src 'self' blob: https://api.anthropic.com https://example.com"],
    ["connect-src 'self' blob: https://api.anthropic.com", "connect-src 'self' blob: https://*.anthropic.com"],
    ["script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'self'"],
    ["default-src 'self';", "default-src 'self'; script-src-elem 'unsafe-inline';"],
  ])('rejects a relaxed or ambiguous resource policy: %s', (before, after) => {
    const invalid = new Map(files), manifest = JSON.parse(invalid.get('manifest.json'));
    manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(before, after);
    invalid.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    expect(() => validateExtensionPackage(invalid)).toThrow('local-only resource policy');
  });
});
