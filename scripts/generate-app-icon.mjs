#!/usr/bin/env node
// Generate the AI Video macOS app icon from the local SVG source.
//
// Pipeline (all local, no remote deps, no fonts):
//   assets/app-icon/icon-source.svg
//     --(sharp)-->  assets/app-icon/icon-1024.png        (1024x1024 master)
//     --(sips)-->   build/icon.iconset/*.png             (macOS sizes)
//     --(iconutil)->build/icon.icns                      (electron-builder picks this up)
//
// Usage: node scripts/generate-app-icon.mjs
//
// This script ONLY produces icon source assets. It does not package the app,
// touch n8n, call any model, or modify launcher/workflow logic.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_SVG = path.join(ROOT, 'assets', 'app-icon', 'icon-source.svg');
const MASTER_PNG = path.join(ROOT, 'assets', 'app-icon', 'icon-1024.png');
const BUILD_DIR = path.join(ROOT, 'build');
const ICONSET_DIR = path.join(BUILD_DIR, 'icon.iconset');
const ICNS_OUT = path.join(BUILD_DIR, 'icon.icns');

function log(msg) { process.stdout.write(`[app-icon] ${msg}\n`); }

async function main() {
  if (!fs.existsSync(SRC_SVG)) {
    throw new Error(`Missing icon source SVG: ${SRC_SVG}`);
  }

  // 1) Rasterize the SVG master with sharp (local dependency).
  const sharp = (await import('sharp')).default;
  fs.mkdirSync(path.dirname(MASTER_PNG), { recursive: true });
  await sharp(SRC_SVG, { density: 384 })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(MASTER_PNG);
  log(`master PNG -> ${path.relative(ROOT, MASTER_PNG)}`);

  // 2) Build the macOS .iconset with sips (built-in macOS tool).
  fs.rmSync(ICONSET_DIR, { recursive: true, force: true });
  fs.mkdirSync(ICONSET_DIR, { recursive: true });
  const variants = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ];
  for (const [name, size] of variants) {
    const out = path.join(ICONSET_DIR, name);
    execFileSync('sips', ['-z', String(size), String(size), MASTER_PNG, '--out', out], { stdio: 'ignore' });
  }
  log(`iconset (${variants.length} sizes) -> ${path.relative(ROOT, ICONSET_DIR)}`);

  // 3) Compile to .icns with iconutil (built-in macOS tool).
  execFileSync('iconutil', ['-c', 'icns', ICONSET_DIR, '-o', ICNS_OUT], { stdio: 'inherit' });
  log(`icns -> ${path.relative(ROOT, ICNS_OUT)}`);

  log('done. (Source assets only — packaging is a separate step.)');
}

main().catch((err) => {
  process.stderr.write(`[app-icon] FAILED: ${err.message}\n`);
  process.exit(1);
});
