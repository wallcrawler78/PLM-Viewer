/** Make a portable source handoff from the same files used to build the preview. */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import JSZip from 'jszip';

const root = process.cwd();
const zip = new JSZip();
const ignored = new Set(['node_modules', '.git', 'dist', 'build', '.openai', 'test-results', 'playwright-report', '__pycache__', '.pytest_cache', '.DS_Store']);
let count = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name.startsWith('.env') && entry.name !== '.env.example' || entry.name.endsWith('.tsbuildinfo') || entry.name.endsWith('.log')) continue;
    const path = join(directory, entry.name);
    if (relative(root, path).replaceAll('\\', '/') === 'public/vendor') continue;
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) {
      zip.file(`arena-assembly-review/${relative(root, path).replaceAll('\\', '/')}`, await readFile(path));
      count++;
    }
  }
}
await walk(root);
await mkdir(join(root, 'dist/developer'), { recursive: true });
await writeFile(join(root, 'dist/developer/arena-review-source.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
console.log(`Packaged ${count} source files in dist/developer/arena-review-source.zip (no credentials, Git internals, dependencies, or Site identity).`);
