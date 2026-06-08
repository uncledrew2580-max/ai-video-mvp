#!/usr/bin/env node
// P14-B5: Build the Windows Electron desktop shell (win32-x64, unpacked dir).
// Runs on the Windows CI runner AFTER npm ci (which downloads the win32-x64
// Electron binary into node_modules/electron/dist/).
//
// Output: dist-win-electron/win-unpacked/
//   AI Video.exe         ← Electron binary with embedded app icon
//   *.dll / *.pak / ...  ← Electron support files
//   locales/
//   resources/
//     app/
//       win-main.cjs     ← Windows desktop launcher
//       package.json
//     electron.asar
//
// The assembler (assemble-windows-portable.mjs) merges this output into the
// staging root alongside resources/runtime/ (the n8n backend).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const log = (m) => process.stdout.write(`[electron-shell] ${m}\n`);

// electron-builder writes to dist-win-electron/win-unpacked/ (dir target, windows).
const OUTPUT_DIR = path.join(ROOT, 'dist-win-electron');
const UNPACKED = path.join(OUTPUT_DIR, 'win-unpacked');

function main() {
  // Verify electron binary is present (npm ci must have run on Windows runner).
  const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  const electronExe = path.join(electronDist, 'electron.exe');
  if (!fs.existsSync(electronExe)) {
    throw new Error(`electron.exe not found at ${electronExe} — npm ci must run on the Windows runner first`);
  }
  log(`electron dist: ${electronDist}`);

  // Verify icon.ico exists (generated from build/icon.iconset/icon_256x256.png).
  const icoPath = path.join(ROOT, 'build', 'icon.ico');
  if (!fs.existsSync(icoPath)) {
    throw new Error(`build/icon.ico not found — must be committed to repo`);
  }
  log(`icon: ${icoPath}`);

  // Run electron-builder --win dir using the Windows-specific config.
  const configPath = path.join(ROOT, 'electron-builder-win.json');
  log('running electron-builder --win dir …');
  execFileSync(
    'npx',
    ['electron-builder', '--win', 'dir', '--config', configPath],
    {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 300000,
      shell: true,
    }
  );

  // Verify output.
  if (!fs.existsSync(UNPACKED)) {
    throw new Error(`electron-builder output not found at ${UNPACKED}`);
  }
  const exePath = path.join(UNPACKED, 'AI Video.exe');
  if (!fs.existsSync(exePath)) {
    throw new Error(`AI Video.exe not found in ${UNPACKED}`);
  }
  const exeSize = fs.statSync(exePath).size;
  if (exeSize < 10240) {
    throw new Error(`AI Video.exe is suspiciously small (${exeSize} bytes)`);
  }
  const appMain = path.join(UNPACKED, 'resources', 'app', 'win-main.cjs');
  if (!fs.existsSync(appMain)) {
    throw new Error(`resources/app/win-main.cjs not found in unpacked output`);
  }
  log(`AI Video.exe  ${(exeSize / 1048576).toFixed(1)} MB`);
  log(`resources/app/win-main.cjs  OK`);
  log(`Electron shell built → ${UNPACKED}`);
}

main();
