import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadEnv } from '../src/config/env.js';
const env = loadEnv();
const source = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || source === path.parse(source).root)
  throw new Error('Usage: npm run restore -- <backup-directory>');
const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8')) as {
  files: Record<string, string>;
};
for (const [rel, hash] of Object.entries(manifest.files)) {
  if (path.isAbsolute(rel) || rel.includes('..')) throw new Error('Unsafe manifest path');
  const actual = crypto
    .createHash('sha256')
    .update(await fs.readFile(path.join(source, rel)))
    .digest('hex');
  if (actual !== hash) throw new Error(`Checksum mismatch: ${rel}`);
}
await fs.rm(env.DATA_DIR, { recursive: true, force: true });
await fs.mkdir(env.DATA_DIR, { recursive: true });
for (const rel of Object.keys(manifest.files)) {
  const dest = path.join(env.DATA_DIR, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(path.join(source, rel), dest);
}
console.log(`Restored ${Object.keys(manifest.files).length} files into ${env.DATA_DIR}`);
