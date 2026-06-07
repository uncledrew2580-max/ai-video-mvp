#!/usr/bin/env node
// P14-A1R2: assemble the Windows x64 portable STAGING tree (no zip here — zipping
// happens after the artifact-tree native-module verification).
//
// Inputs prepared by earlier workflow steps:
//   - node_modules/                 (win32-x64, built by `npm ci` on the runner)
//   - runtime/bin/node.exe          (official Windows node v24.14.0, sha-verified)
//   - runtime/bin/ffmpeg.exe        (clean LGPL build, license-verified)
//
// Output: dist-win/AI-Video-Win-x64-Portable-RC-0001/  + runtime-manifest.json.
// Packaging filter guarantees NO darwin/linux/Mach-O/ELF .node ships in the tree.
// No model calls, no secrets baked in.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_ROOT = path.join(ROOT, 'dist-win');
const NAME = 'AI-Video-Win-x64-Portable-RC-0001';
const STAGE = path.join(OUT_ROOT, NAME);

const log = (m) => process.stdout.write(`[assemble] ${m}\n`);

const INCLUDE = [
  'app-server', 'client', 'config', 'desktop', 'prompts', 'scripts',
  '版本测试', '正式导入文件', 'runtime',
  'node_modules',
  'package.json', 'package-lock.json',
  'sync_iteration_v1_workflows_to_db.mjs', 'sync_wf02ab_to_db.mjs',
  'gemini-generate.mjs', 'veo-download.mjs', 'veo-sdk-submit.mjs', 'veo-status.mjs', 'voiceover_localize.mjs',
];

// Whole packages excluded from the Windows portable (mirrors the Mac packager).
// @sentry-internal/node-cpu-profiler ships multi-platform prebuilds (darwin/linux)
// and is optional telemetry not needed for n8n workflow execution.
const NM_SKIP_TOP = new Set(['electron', 'electron-builder', 'app-builder-bin', 'app-builder-lib', 'dmg-builder', '.cache', '.bin']);
const NM_SKIP_SCOPED = new Set([path.join('@sentry-internal', 'node-cpu-profiler'), path.join('@electron', 'rebuild')]);

function copyFiltered(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const rel = path.relative(ROOT, s);
      const parts = rel.split(path.sep);
      if (parts.at(-1) === '.DS_Store') return false;
      if (parts[0] === 'node_modules') {
        if (parts[1] && NM_SKIP_TOP.has(parts[1])) return false;
        if (parts[1] && parts[2] && NM_SKIP_SCOPED.has(path.join(parts[1], parts[2]))) return false;
      }
      if (rel === path.join('runtime', 'bin', 'ffmpeg')) return false; // never ship the mac/linux ffmpeg
      if (parts.includes('.n8n-local-cache') || parts.includes('.n8n-local-cache-backups')) return false;
      if (parts[0] === '版本测试' && ['logs', 'backups', '正式导入文件'].includes(parts[1])) return false;
      return true;
    },
  });
}

// Header check: true only for a Windows PE with machine type x64 (0x8664).
function isWin32x64Node(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    if (!(head[0] === 0x4d && head[1] === 0x5a)) return false; // not "MZ"
    const peOff = head.readUInt32LE(0x3c);
    const peHdr = Buffer.alloc(6);
    fs.readSync(fd, peHdr, 0, 6, peOff);
    if (peHdr.toString('ascii', 0, 4) !== 'PE\0\0') return false;
    return peHdr.readUInt16LE(4) === 0x8664;
  } catch { return false; } finally { fs.closeSync(fd); }
}

// Strip any .node in the staging tree that is not a win32-x64 PE, or whose
// path/name marks it as a darwin/linux sibling prebuild. Generic safety net so
// ANY multi-platform package is handled, not just the known telemetry one.
function stripNonWin32Addons(nmDir) {
  let removed = 0, kept = 0;
  const stack = [nmDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.name.endsWith('.node')) continue;
      const rel = path.relative(nmDir, full);
      const named = /(?:^|[\\/_.-])(darwin|linux)(?:[\\/_.-]|$)/i.test(rel);
      if (named || !isWin32x64Node(full)) { fs.rmSync(full, { force: true }); removed++; }
      else kept++;
    }
  }
  log(`stripped ${removed} non-win32 .node (kept ${kept} win32-x64) from staging node_modules`);
}

// Prune dev-only weight from node_modules that is never needed at runtime, so the
// portable zip stays small/fast. Conservative: keeps LICENSE, package.json, all
// code (.js/.cjs/.mjs/.json) and win32 .node; only drops dev dirs + source maps + docs.
const PRUNE_DIRS = new Set(['test', 'tests', '__tests__', 'example', 'examples', 'docs', '.github', '.vscode', '.idea', 'coverage', '.nyc_output', '.cache']);
// License/compliance docs that MUST be kept even when they use a .md extension.
const COMPLIANCE_DOC = /(license|licence|notice|copying|copyright|patent|third[-_]?party|legal)/i;
// Recursively check whether a directory holds any license/compliance document.
function containsComplianceDoc(dir) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (containsComplianceDoc(path.join(dir, e.name))) return true; }
    else if (COMPLIANCE_DOC.test(e.name)) return true;
  }
  return false;
}
function pruneStagingTree(stageDir) {
  const nm = path.join(stageDir, 'node_modules');
  if (!fs.existsSync(nm)) return;
  let dirsRm = 0, filesRm = 0;
  const stack = [nm];
  while (stack.length) {
    const d = stack.pop();
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // dev dirs are removed unless they contain license/compliance docs; in that
        // case we traverse them so file-level prune keeps the compliance files.
        if (PRUNE_DIRS.has(e.name)) {
          if (containsComplianceDoc(full)) { stack.push(full); }
          else { fs.rmSync(full, { recursive: true, force: true }); dirsRm++; }
          continue;
        }
        stack.push(full);
      } else if (/\.(map|md|markdown)$/i.test(e.name) && !COMPLIANCE_DOC.test(e.name)) {
        // Drop ordinary README/docs and source maps, but never license/compliance
        // files (LICENSE.md, NOTICE.md, COPYING.md, COPYRIGHT.md, PATENTS.md, ...).
        fs.rmSync(full, { force: true }); filesRm++;
      }
    }
  }
  log(`pruned node_modules: ${dirsRm} dev dirs, ${filesRm} readme/doc/map files (license/notice/copying kept)`);
}

// Print staging-tree stats (file/dir count, total size, top 30 dirs) before zipping.
function printStagingStats(stageDir) {
  let files = 0, dirs = 0, bytes = 0;
  const buckets = new Map(); // first 2 path segments -> bytes
  const stack = [stageDir];
  while (stack.length) {
    const d = stack.pop();
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { dirs++; stack.push(full); continue; }
      files++;
      let sz = 0; try { sz = fs.statSync(full).size; } catch {}
      bytes += sz;
      const rel = path.relative(stageDir, full).split(path.sep).slice(0, 2).join('/');
      buckets.set(rel, (buckets.get(rel) || 0) + sz);
    }
  }
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  log(`staging stats: ${files} files, ${dirs} dirs, total ${mb(bytes)}`);
  const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  for (const [k, v] of top) log(`  ${mb(v).padStart(10)}  ${k}`);
}

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

  stripNonWin32Addons(path.join(STAGE, 'node_modules'));
  pruneStagingTree(STAGE);

  sanitizeConfig(path.join('config', 'local-config.json'));
  sanitizeConfig(path.join('版本测试', 'config', 'local-config.json'));

  fs.writeFileSync(path.join(STAGE, 'Start-AI-Video.cmd'), LAUNCHER_CMD.replace(/\n/g, '\r\n'));
  log('wrote Start-AI-Video.cmd');

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
    note: 'portable zip; no installer/MSI; no API keys baked in; non-win32 .node stripped',
  };
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(OUT_ROOT, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(STAGE, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`staged. node ${nodeVer} | ${manifest.ffmpeg_version}`);
  log(`staging tree: ${STAGE}`);
  printStagingStats(STAGE);
}
main();
