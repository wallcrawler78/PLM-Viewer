/** Package matching document/CAD support assets locally; never load runtime code from a CDN. */
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareCadRuntime } from './prepare-cad-runtime.mjs';

const root = process.cwd();
const output = resolve(root, 'public/vendor');
const application = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const manifest = { formatVersion: 1, viewerVersion: application.version, assets: [] };

for (const [name, folder, paths] of [
  ['pdfjs-dist', 'pdfjs', ['cmaps', 'standard_fonts', 'wasm', 'LICENSE']],
]) {
  const source = resolve(root, 'node_modules', name);
  let dependency;
  try { dependency = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8')); }
  catch { throw new Error(`Install pinned dependencies before preparing local runtime assets (${name}).`); }
  if (application.dependencies[name] !== dependency.version) throw new Error(`The installed ${name} version does not match the pinned runtime dependency.`);
  // Only replace our generated directory; source documents and fixtures are never touched.
  const target = resolve(output, folder);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const path of paths) {
    await stat(resolve(source, path));
    await cp(resolve(source, path), resolve(target, path), { recursive: true });
  }
  manifest.assets.push({ package: name, version: dependency.version, directory: `vendor/${folder}`, entries: paths });
}

await prepareCadRuntime(root);
manifest.assets.push({ package: 'occt-import-js', version: application.dependencies['occt-import-js'], directory: 'vendor/occt', entries: ['occt-import-js.mjs', 'occt-import-js.wasm', 'LICENSE.md', 'NOTICE.txt'] });

await writeFile(resolve(output, 'runtime-assets.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared local assets for ${manifest.assets.map(row => `${row.package} ${row.version}`).join(', ')}.`);
