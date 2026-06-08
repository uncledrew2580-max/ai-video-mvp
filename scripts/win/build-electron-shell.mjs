#!/usr/bin/env node
// P14-B5: Build the Windows Electron desktop shell (win32-x64, unpacked dir).
// Runs on the Windows CI runner AFTER npm ci (which downloads the win32-x64
// Electron binary into node_modules/electron/dist/).
//
// OOM fix (P14-B5R1): electron-builder is run from a MINIMAL ISOLATED build dir
// (dist-win-electron-build/) that contains only win-main.cjs + package.json +
// icon, NOT from the repo root. This prevents electron-builder from scanning the
// multi-GB node_modules / resources/runtime tree and running out of memory.
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

// Resolve the exact installed Electron version from package-lock.json (lockfile v3).
// Falls back to 39.2.6 (consistent with devDependencies range) if the lock is absent
// or the electron entry is missing — this should never happen after npm ci.
function resolveElectronVersion() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const v = lock?.packages?.['node_modules/electron']?.version;
    if (v && /^\d+\.\d+\.\d+$/.test(v)) return v;
  } catch {}
  return '39.2.6';
}

// Isolated minimal build dir — contains only the Electron app source.
// electron-builder runs from here so it never touches ROOT/node_modules.
const BUILD_DIR = path.join(ROOT, 'dist-win-electron-build');
// electron-builder writes unpacked output here.
const OUTPUT_DIR = path.join(ROOT, 'dist-win-electron');
const UNPACKED = path.join(OUTPUT_DIR, 'win-unpacked');

function main() {
  // Verify electron binary is present (npm ci must have run on Windows runner).
  const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  const electronExe = path.join(electronDist, 'electron.exe');
  if (!fs.existsSync(electronExe)) {
    throw new Error(`electron.exe not found at ${electronExe} — npm ci must run on the Windows runner first`);
  }

  // Resolve exact Electron version from package-lock.json so the isolated build
  // dir's package.json carries a pinned devDependencies.electron entry and the
  // generated config carries electronVersion — both without node_modules in BUILD_DIR.
  const electronVersion = resolveElectronVersion();
  log(`electron dist: ${electronDist} (v${electronVersion}, source: package-lock.json)`);

  // Verify icon.ico exists.
  const icoSrc = path.join(ROOT, 'build', 'icon.ico');
  if (!fs.existsSync(icoSrc)) {
    throw new Error(`build/icon.ico not found — must be committed to repo`);
  }
  log(`icon: ${icoSrc}`);

  // ── Build isolated minimal project dir ──────────────────────────────────────
  // electron-builder runs from this small dir, never scanning ROOT/node_modules.
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(BUILD_DIR, 'build'), { recursive: true });

  // App source: only win-main.cjs.
  fs.copyFileSync(path.join(ROOT, 'desktop', 'win-main.cjs'), path.join(BUILD_DIR, 'win-main.cjs'));
  log('copied desktop/win-main.cjs → build dir');

  // Icon (build/icon relative to BUILD_DIR; electron-builder appends .ico on Windows).
  fs.copyFileSync(icoSrc, path.join(BUILD_DIR, 'build', 'icon.ico'));
  log('copied build/icon.ico → build dir');

  // Minimal package.json with pinned devDependencies.electron (exact, no ^ range).
  // electron-builder reads devDependencies for version resolution when node_modules
  // is absent — the exact version prevents the "Cannot compute electron version" error.
  const pkg = {
    name: 'ai-video',
    version: '0.0.0-rc',
    main: 'win-main.cjs',
    description: 'AI Video desktop shell',
    devDependencies: { electron: electronVersion },
  };
  fs.writeFileSync(path.join(BUILD_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  log(`wrote minimal package.json (electron=${electronVersion})`);

  // Inline electron-builder config — all paths relative to BUILD_DIR.
  // electronDist: ../node_modules/electron/dist  → ROOT/node_modules/electron/dist
  // directories.output: ../dist-win-electron     → ROOT/dist-win-electron
  // files: only win-main.cjs (BUILD_DIR/win-main.cjs); no wildcard, no node_modules.
  const ebConfig = {
    appId: 'com.aivideo.workbench',
    productName: 'AI Video',
    asar: false,
    npmRebuild: false,
    // Pin exact version so electron-builder doesn't scan node_modules for it.
    electronVersion,
    electronDist: '../node_modules/electron/dist',
    directories: { output: '../dist-win-electron' },
    files: ['win-main.cjs'],
    win: {
      target: [{ target: 'dir', arch: ['x64'] }],
      icon: 'build/icon',
    },
  };
  const configPath = path.join(BUILD_DIR, 'electron-builder.json');
  fs.writeFileSync(configPath, JSON.stringify(ebConfig, null, 2) + '\n');
  log('wrote electron-builder.json (isolated config)');

  // ── Run electron-builder from the isolated dir ──────────────────────────────
  // Using the explicit bin path avoids npx discovery latency and ensures the
  // correct version is used regardless of PATH.
  const ebBin = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', '.bin', 'electron-builder.cmd')
    : path.join(ROOT, 'node_modules', '.bin', 'electron-builder');

  log(`running electron-builder --win dir (cwd: dist-win-electron-build/) …`);
  execFileSync(
    ebBin,
    ['--win', 'dir', '--config', configPath],
    {
      cwd: BUILD_DIR,
      stdio: 'inherit',
      timeout: 300000,
      shell: process.platform === 'win32',
    }
  );

  // ── Verify output ────────────────────────────────────────────────────────────
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

  // Clean up isolated build dir (output already extracted to dist-win-electron/).
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  log('cleaned up dist-win-electron-build/');
}

main();
