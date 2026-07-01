// Packs the built extension (.output/chrome-mv3) into a signed .crx (CRX3).
// Signing key lives at key.pem (gitignored); crx3 generates it on first run.
// Keep that key safe — reusing it keeps the extension's ID stable across builds.
import crx3 from 'crx3';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = resolve(root, '.output/chrome-mv3/manifest.json');
const keyPath = resolve(root, 'key.pem');
const crxPath = resolve(root, '.output/glp-ram.crx');

if (!existsSync(manifest)) {
  console.error('No build found at .output/chrome-mv3 — run `bun run build` first.');
  process.exit(1);
}

const freshKey = !existsSync(keyPath);
await crx3([manifest], { keyPath, crxPath });

if (freshKey) console.log('Generated signing key: key.pem (keep it; do not commit)');
console.log('Wrote', crxPath);
