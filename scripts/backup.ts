import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadEnv } from '../src/config/env.js';
const env = loadEnv();
const root = path.resolve(process.argv[2] ?? 'backups');
await fs.mkdir(root, { recursive: true });
const target = path.join(root, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
if (target.startsWith(env.DATA_DIR + path.sep))
  throw new Error('Backup destination must be outside DATA_DIR');
await fs.cp(env.DATA_DIR, target, { recursive: true, errorOnExist: true });
const files = await fs.readdir(target, { recursive: true });
const manifest: { createdAt: string; files: Record<string, string> } = {
  createdAt: new Date().toISOString(),
  files: {},
};
for (const rel of files) {
  const f = path.join(target, rel);
  if ((await fs.stat(f)).isFile())
    manifest.files[rel] = crypto
      .createHash('sha256')
      .update(await fs.readFile(f))
      .digest('hex');
}
await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Backup created: ${target} (${Object.keys(manifest.files).length} files)`);
