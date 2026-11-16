import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
const files = [
  'index.html',
  'manifest.json',
  'sw.js',
  'css/style.css',
  'js/storage.js',
  'js/mesh.js',
  'js/app.js',
  'assets/icon.svg',
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of files) {
  const target = resolve(out, file);
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(root, file), target);
}
await writeFile(resolve(out, '.nojekyll'), '');
console.log(`Built static site (${files.length} assets) in dist/`);
