#!/usr/bin/env node
// P14-A1: assemble the Windows x64 portable RC on the Windows runner.
//
// Inputs already prepared by earlier workflow steps:
//   - node_modules/                 (win32-x64, built by `npm ci` on the runner)
//   - runtime/bin/node.exe          (official Windows node v24.14.0, sha-verified)
//   - runtime/bin/ffmpeg.exe        (clean LGPL build, license-verified)
//
// Output: dist-win/AI Video Win x64 Portable RC 0001/  + a zip + .sha256 + manifest.
// Portable: launched by Start-AI-Video.cmd (no installer/MSI). User data goes to
// %APPDATA%\AI Video; outputs to %USERPROFILE%\Documents\AI Video Outputs.
// No model calls, no secrets baked in.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_ROOT = path.join(ROOT, 'dist-win');
const NAME = 'AI-Video-Win-x64-Portable-RC-0001';
const STAGE = path.join(OUT_ROOT, NAME);
const ZIP = path.join(OUT_ROOT, `${NAME}.zip`);

const log = (m) => process.stdout.write(`[assemble] ${m}\n`);

// App payload (mirrors the Mac packager include list; mac-only .command launchers excluded).
const INCLUDE = [
  'app-server', 'client', 'config', 'desktop', 'prompts', 'scripts',
  '版本测试', '正式导入文件', 'runtime',
  'node_modules',
  'package.json', 'package-lock.json',
  'sync_iteration_v1_workflows_to_db.mjs', 'sync_wf02ab_to_db.mjs',
  'gemini-generate.mjs', 'veo-download.mjs', 'veo-sdk-submit.mjs', 'veo-status.mjs', 'voiceover_localize.mjs',
];

// node_modules trimming: Electron GUI shell is not used by the Windows portable
// (the launcher runs n8n + the local UI server via node.exe). These are large
// and/or platform-specific build tooling.
const NM_SKIP = new Set([
  'electron', 'electron-builder', 'app-builder-bin', 'app-builder-lib', 'dmg-builder',
  '@electron', '.cache', '.bin',
]);

function copyFiltered(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const rel = path.relative(ROOT, s);
      const parts = rel.split(path.sep);
      if (parts.at(-1) === '.DS_Store') return false;
      if (parts[0] === 'node_modules' && parts[1] && NM_SKIP.has(parts[1])) return false;
      // never ship a darwin/linux ffmpeg into the Windows package
      if (rel === path.join('runtime', 'bin', 'ffmpeg')) return false;
      if (parts.includes('.n8n-local-cache') || parts.includes('.n8n-local-cache-backups')) return false;
      if (parts[0] === '版本测试' && ['logs', 'backups', '正式导入文件'].includes(parts[1])) return false;
      return true;
    },
  });
}

// Strip any api_key-like values so no secret is ever baked into the package.
function scrubApiKeys(v) {
  if (Array.isArray(v)) return v.map(scrubApiKeys);
  if (!v || typeof v !== 'object') return v;
  for (const [k, val] of Object.entries(v)) {
    const n = k.toLowerCase();
    if (n === 'api_key' || n.endsWith('_api_key')) v[k] = '';
    else v[k] = scrubApiKeys(val);
  }
  return v;
}
function sanitizeConfig(rel) {
  const f = path.join(STAGE, rel);
  if (!fs.existsSync(f)) return;
  try { fs.writeFileSync(f, JSON.stringify(scrubApiKeys(JSON.parse(fs.readFileSync(f, 'utf8'))), null, 2) + '\n'); log(`sanitized ${rel}`); } catch {}
}

const LAUNCHER_CMD = `@echo off
REM AI Video — Windows x64 portable launcher (P14-A1).
REM User data -> %APPDATA%\\AI Video ; outputs -> Documents\\AI Video Outputs.
REM Final merge uses the bundled clean ffmpeg.exe (absolute path), never PATH ffmpeg.
setlocal
set "APP_DIR=%~dp0"
set "AI_VIDEO_FFMPEG_PATH=%APP_DIR%runtime\\bin\\ffmpeg.exe"
set "AI_VIDEO_RUNTIME_ROOT=%APPDATA%\\AI Video"
set "WORKFLOW_DATA_ROOT=%APPDATA%\\AI Video\\workflow-data"
set "N8N_USER_FOLDER=%APPDATA%\\AI Video\\n8n-user"
set "AI_VIDEO_LOG_DIR=%APPDATA%\\AI Video\\logs\\launcher"
set "AI_VIDEO_CONFIG_PATH=%APPDATA%\\AI Video\\config\\local-config.json"
set "AI_VIDEO_OUTPUT_DIR=%USERPROFILE%\\Documents\\AI Video Outputs"
set "REVIEW_ASSET_PORT=18788"
if not exist "%APPDATA%\\AI Video" mkdir "%APPDATA%\\AI Video"
if not exist "%AI_VIDEO_OUTPUT_DIR%" mkdir "%AI_VIDEO_OUTPUT_DIR%"
"%APP_DIR%runtime\\bin\\node.exe" "%APP_DIR%client\\launcher.mjs" %*
endlocal
`;

function main() {
  const nodeExe = path.join(ROOT, 'runtime', 'bin', 'node.exe');
  const ffExe = path.join(ROOT, 'runtime', 'bin', 'ffmpeg.exe');
  if (!fs.existsSync(nodeExe)) throw new Error('missing runtime/bin/node.exe (run fetch-node-exe.mjs)');
  if (!fs.existsSync(ffExe)) throw new Error('missing runtime/bin/ffmpeg.exe (run build-ffmpeg-lgpl.sh)');

  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) { log(`skip (absent): ${item}`); continue; }
    copyFiltered(src, path.join(STAGE, item));
    log(`copied ${item}`);
  }

  sanitizeConfig(path.join('config', 'local-config.json'));
  sanitizeConfig(path.join('版本测试', 'config', 'local-config.json'));

  fs.writeFileSync(path.join(STAGE, 'Start-AI-Video.cmd'), LAUNCHER_CMD.replace(/\n/g, '\r\n'));
  log('wrote Start-AI-Video.cmd');

  // runtime manifest
  const nodeVer = execFileSync(nodeExe, ['--version'], { timeout: 20000 }).toString('utf8').trim();
  const ffVer = execFileSync(ffExe, ['-hide_banner', '-version'], { timeout: 20000 }).toString('utf8');
  const manifest = {
    name: NAME,
    platform: 'win32-x64',
    built_at: new Date().toISOString(),
    node_exe_version: nodeVer,
    ffmpeg_version: ffVer.split('\n')[0],
    ffmpeg_configuration: (ffVer.split('\n').find((l) => l.startsWith('configuration:')) || '').trim(),
    final_merge: 'stream copy (-c copy) via AI_VIDEO_FFMPEG_PATH absolute path',
    user_data_dir: '%APPDATA%\\AI Video',
    output_dir: '%USERPROFILE%\\Documents\\AI Video Outputs',
    note: 'portable zip; no installer/MSI; no API keys baked in',
  };
  const manPath = path.join(OUT_ROOT, 'runtime-manifest.json');
  fs.writeFileSync(manPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(STAGE, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`manifest: node ${nodeVer} | ${manifest.ffmpeg_version}`);

  // zip via PowerShell Compress-Archive (available on windows-2022 runners)
  log('zipping (Compress-Archive)...');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -Force`,
  ], { stdio: 'inherit' });

  const sha = createHash('sha256').update(fs.readFileSync(ZIP)).digest('hex');
  fs.writeFileSync(`${ZIP}.sha256`, `${sha}  ${path.basename(ZIP)}\n`);
  log(`zip:    ${ZIP}`);
  log(`sha256: ${sha}`);
  log('done.');
}
main();
