import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'src', 'ui');
const dest = join(root, 'dist', 'ui');

if (!existsSync(src)) {
  throw new Error(`expected UI assets directory at ${src}`);
}

cpSync(src, dest, { recursive: true });
console.log(`Copied ${src} -> ${dest}`);
