// Render the extension icon PNGs from assets/glp-ram-icon.svg into public/icon/.
// Chrome manifest icons must be raster (PNG); this is the single source of truth.
// Re-run with `bun run icons` whenever the SVG changes.
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(resolve(root, 'assets/glp-ram-icon.svg'));
const outDir = resolve(root, 'public/icon');
mkdirSync(outDir, { recursive: true });

const SIZES = [16, 32, 48, 128];
for (const size of SIZES) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(resolve(outDir, `${size}.png`), png);
  console.log(`icon/${size}.png (${png.length} B)`);
}
