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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_ROOT = path.join(ROOT, 'dist-win');
const NAME = 'AI-Video-Win-x64-Portable-RC-0001';
const STAGE = path.join(OUT_ROOT, NAME);
// P14-B5: STAGE root exposes AI Video.exe (Electron shell) + Electron support
// files + tools/ + manifests. Engineering tree is under resources/runtime/.
const RESOURCES = path.join(STAGE, 'resources');
const RUNTIME_DIR = path.join(RESOURCES, 'runtime');
// Electron desktop shell built by build-electron-shell.mjs before assembly.
const ELECTRON_UNPACKED = path.join(ROOT, 'dist-win-electron', 'win-unpacked');

const log = (m) => process.stdout.write(`[assemble] ${m}\n`);

const INCLUDE = [
  'app-server', 'client', 'config', 'desktop', 'lib', 'prompts', 'scripts',
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
      const relU = parts.join('/');
      if (parts.at(-1) === '.DS_Store') return false;
      if (parts[0] === 'node_modules') {
        if (parts[1] && NM_SKIP_TOP.has(parts[1])) return false;
        if (parts[1] && parts[2] && NM_SKIP_SCOPED.has(path.join(parts[1], parts[2]))) return false;
      }
      // n8n 2.x needs ONE shared zod instance across its whole package tree. The
      // install ships ~24 nested zod copies (3.25.67) alongside the top-level
      // (3.25.76); multiple instances break startup two ways:
      //   - @n8n/api-types discriminatedUnion -> "discriminator value for key __type
      //     could not be extracted" (masked as missing breaking-changes.ee module);
      //   - @n8n/config augments zod with .alias() on its own copy, while
      //     commands/start.js gets a different copy -> "z.boolean(...).alias is not a
      //     function" (masked as Command "start" not found).
      // Drop EVERY nested */node_modules/zod so all packages resolve to the single
      // top-level node_modules/zod. (Validated locally: n8n then loads modules +
      // start command + runs migrations.)
      if (/(^|\/)node_modules\/.+\/node_modules\/zod(\/|$)/.test(relU)) return false;
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
// n8n runtime trees are NEVER pruned (a missing dist module breaks startup, e.g.
// dist/modules/breaking-changes.ee/breaking-changes.module). Matches n8n, the whole
// @n8n scope, and any n8n-* package, at the top level or nested node_modules.
const PROTECT_N8N = /(^|\/node_modules\/)(@n8n\/|n8n\/|n8n-core\/|n8n-workflow\/|n8n-[^/]+\/)/;
function isN8nRuntimePath(relFromNm) {
  return PROTECT_N8N.test(relFromNm.split(path.sep).join('/') + '/');
}
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
      const rel = path.relative(nm, full);
      // n8n runtime is fully protected — never prune anything inside it.
      if (isN8nRuntimePath(rel)) continue;
      if (e.isDirectory()) {
        // dev dirs are removed unless they contain license/compliance docs; in that
        // case we traverse them so file-level prune keeps the compliance files.
        if (PRUNE_DIRS.has(e.name)) {
          // Never prune directories that live inside a dist/ tree — they are compiled
          // runtime output even when named test/tests/__tests__/etc.
          // e.g. langchain/dist/agents/tests/utils.cjs is required by langchain/dist/index.cjs.
          const relU = rel.split(path.sep).join('/');
          if (/(?:^|\/)dist\//.test(relU)) { stack.push(full); continue; }
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
  const f = path.join(RUNTIME_DIR, rel);
  if (!fs.existsSync(f)) return;
  try { fs.writeFileSync(f, JSON.stringify(scrubApiKeys(JSON.parse(fs.readFileSync(f, 'utf8'))), null, 2) + '\n'); log(`sanitized ${rel}`); } catch {}
}

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

// Shared env block for both the main entry and the debug entry. %RUNTIME_DIR%
// must already be set by the caller. User data -> %APPDATA%\AI Video ; outputs ->
// Documents\AI Video Outputs ; final merge uses the bundled clean ffmpeg.exe
// (absolute path), never PATH ffmpeg.
const ENV_BLOCK = `set "NODE_EXE=%RUNTIME_DIR%\\runtime\\bin\\node.exe"
set "LAUNCHER=%RUNTIME_DIR%\\client\\launcher.mjs"
set "AI_VIDEO_HOME=%APPDATA%\\AI Video"
set "AI_VIDEO_FFMPEG_PATH=%RUNTIME_DIR%\\runtime\\bin\\ffmpeg.exe"
set "AI_VIDEO_RUNTIME_ROOT=%AI_VIDEO_HOME%"
set "WORKFLOW_DATA_ROOT=%AI_VIDEO_HOME%\\workflow-data"
set "N8N_USER_FOLDER=%AI_VIDEO_HOME%\\workflow-data"
set "AI_VIDEO_LOG_DIR=%AI_VIDEO_HOME%\\logs\\launcher"
set "AI_VIDEO_CONFIG_PATH=%AI_VIDEO_HOME%\\config\\local-config.json"
set "AI_VIDEO_OUTPUT_DIR=%USERPROFILE%\\Documents\\AI Video Outputs"
set "REVIEW_ASSET_PORT=18788"
if not exist "%AI_VIDEO_HOME%" mkdir "%AI_VIDEO_HOME%" >nul 2>nul
if not exist "%AI_VIDEO_HOME%\\config" mkdir "%AI_VIDEO_HOME%\\config" >nul 2>nul
if not exist "%AI_VIDEO_LOG_DIR%" mkdir "%AI_VIDEO_LOG_DIR%" >nul 2>nul
if not exist "%WORKFLOW_DATA_ROOT%" mkdir "%WORKFLOW_DATA_ROOT%" >nul 2>nul
if not exist "%AI_VIDEO_OUTPUT_DIR%" mkdir "%AI_VIDEO_OUTPUT_DIR%" >nul 2>nul`;

// P14-B5: tools/AI Video (命令行模式).cmd — cmd-mode fallback for power users /
// debug, no longer the root main entry (AI Video.exe is the primary entry).
// APP_DIR is the portable root (tools/../), RUNTIME_DIR one level deeper.
const MAIN_CMD = `@echo off
chcp 65001 >nul
title AI Video（命令行模式）
setlocal
set "APP_DIR=%~dp0.."
set "RUNTIME_DIR=%APP_DIR%\\resources\\runtime"
${ENV_BLOCK}

if not exist "%NODE_EXE%" (
  echo [错误] 找不到运行所需的程序：
  echo        %NODE_EXE%
  echo        安装包可能未完整解压，请重新解压整个文件夹后再试。
  echo.
  pause
  exit /b 1
)

echo.
echo   AI Video 正在启动（命令行模式），请稍候……
echo   首次启动可能需要 1-2 分钟，就绪后会自动打开浏览器。
echo   工作台地址：http://127.0.0.1:18788/
echo   视频输出目录：%AI_VIDEO_OUTPUT_DIR%
echo.

REM 后台等待本地服务就绪后自动打开浏览器（失败不影响启动）。
start "" /b "%NODE_EXE%" "%RUNTIME_DIR%\\scripts\\win\\open-when-ready.mjs" "http://127.0.0.1:18788/" >nul 2>nul

cd /d "%RUNTIME_DIR%"
"%NODE_EXE%" "%LAUNCHER%" --no-browser
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo   AI Video 启动失败（错误码 %EXITCODE%）。
  echo   日志目录：%AI_VIDEO_LOG_DIR%
  echo   可双击 Export-Diagnostics.cmd 一键导出诊断包发给我们排查。
  echo.
  pause
  exit /b %EXITCODE%
)
endlocal
`;

// tools/Open-Logs.cmd — open the user-data log directory in Explorer.
const OPEN_LOGS_CMD = `@echo off
chcp 65001 >nul
title AI Video — 打开日志目录
setlocal
set "LOGDIR=%APPDATA%\\AI Video\\logs"
if not exist "%LOGDIR%" (
  echo 日志目录尚不存在：%LOGDIR%
  echo 请先启动 AI Video 至少一次后再试。
  pause
  exit /b 0
)
explorer "%LOGDIR%"
endlocal
`;

// tools/Stop-AI-Video.cmd — graceful stop of the running AI Video desktop app.
// Reads %APPDATA%\AI Video\runtime\ai-video.pid (written by win-main.cjs) and
// only stops a process whose image name is exactly "AI Video.exe" — never an
// unknown PID. Falls back to image-name match if the PID file is stale.
const STOP_CMD = `@echo off
chcp 65001 >nul
title AI Video — 停止
setlocal EnableDelayedExpansion
set "PIDFILE=%APPDATA%\\AI Video\\runtime\\ai-video.pid"
set "TARGET="
if exist "%PIDFILE%" set /p TARGET=<"%PIDFILE%"

if defined TARGET (
  REM Only kill the PID if it is actually an "AI Video.exe" process.
  for /f "tokens=1" %%P in ('tasklist /FI "PID eq !TARGET!" /FI "IMAGENAME eq AI Video.exe" /NH 2^>nul ^| find /I "AI Video.exe"') do (
    echo 正在停止 AI Video（PID !TARGET!）……
    taskkill /PID !TARGET! /T /F >nul 2>nul
    del "%PIDFILE%" >nul 2>nul
    echo 已停止。
    goto :done
  )
)

REM PID file missing or stale — stop by image name (only AI Video.exe).
tasklist /FI "IMAGENAME eq AI Video.exe" /NH 2>nul | find /I "AI Video.exe" >nul
if %ERRORLEVEL%==0 (
  echo 正在停止 AI Video……
  taskkill /IM "AI Video.exe" /T /F >nul 2>nul
  if exist "%PIDFILE%" del "%PIDFILE%" >nul 2>nul
  echo 已停止。
) else (
  echo 未发现正在运行的 AI Video。
)

:done
endlocal
`;

// 创建桌面快捷方式.cmd — root-level helper, creates an LNK pointing to AI Video.exe.
const SHORTCUT_CMD = `@echo off
chcp 65001 >nul
title AI Video — 创建桌面快捷方式
setlocal
set "APP_DIR=%~dp0"
set "EXE=%APP_DIR%AI Video.exe"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws=New-Object -ComObject WScript.Shell; ^
   $lnk=$ws.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'AI Video.lnk')); ^
   $lnk.TargetPath='%EXE:\=\\%'; ^
   $lnk.WorkingDirectory='%APP_DIR:\=\\%'; ^
   $lnk.IconLocation='%EXE:\=\\%,0'; ^
   $lnk.Description='AI Video 工作台'; ^
   $lnk.Save(); ^
   Write-Host '快捷方式已创建到桌面。'"
echo.
echo 如果成功，桌面会出现 "AI Video" 图标，双击即可启动。
pause
endlocal
`;

// tools/Start-AI-Video-Debug.cmd — verbose launch with a detailed log (live
// console + tee to file). Lives under tools/, so RUNTIME_DIR is one level up.
const DEBUG_CMD = `@echo off
chcp 65001 >nul
title AI Video（调试模式）
setlocal
set "APP_DIR=%~dp0.."
set "RUNTIME_DIR=%APP_DIR%\\resources\\runtime"
${ENV_BLOCK}
set "DEBUGLOG=%AI_VIDEO_LOG_DIR%\\debug-launch.log"

if not exist "%NODE_EXE%" (
  echo [错误] 找不到运行程序：%NODE_EXE%
  pause
  exit /b 1
)

echo 调试模式启动。详细日志同时写入：
echo   %DEBUGLOG%
echo 按 Ctrl+C 可停止。
echo.

cd /d "%RUNTIME_DIR%"
echo ===== 调试启动 %date% %time% ===== >> "%DEBUGLOG%"
"%NODE_EXE%" "%LAUNCHER%" --no-browser 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath '%DEBUGLOG%'"
echo.
echo 调试会话结束。完整日志见：%DEBUGLOG%
pause
endlocal
`;

// tools/Export-Diagnostics.cmd — collect local logs + manifests into a Desktop
// folder and open it. Local files only; NO model calls, NO uploads.
const EXPORT_CMD = `@echo off
chcp 65001 >nul
title AI Video 诊断导出
setlocal
set "APP_DIR=%~dp0.."
echo 正在导出诊断包（仅本地日志与版本信息，不会上传，也不会调用任何模型）……
powershell -NoProfile -ExecutionPolicy Bypass -Command "$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'; $dest=Join-Path ([Environment]::GetFolderPath('Desktop')) ('AI-Video-诊断-'+$stamp); New-Item -ItemType Directory -Force -Path $dest | Out-Null; $logs=Join-Path $env:APPDATA 'AI Video\\logs'; if(Test-Path $logs){ Copy-Item $logs (Join-Path $dest 'logs') -Recurse -Force }; $root=Resolve-Path '%APP_DIR%'; foreach($f in @('version.json','runtime-manifest.json','使用说明.txt')){ $p=Join-Path $root $f; if(Test-Path $p){ Copy-Item $p $dest -Force } }; Write-Host ('诊断包已生成：'+$dest); Start-Process $dest"
echo.
echo 如果未自动打开，请到桌面查找 AI-Video-诊断-时间戳 文件夹。
pause
endlocal
`;

const USAGE_TXT = `AI Video — 使用说明
========================================

一、如何启动
  1. 确保已把整个文件夹完整解压到硬盘（不要在压缩包内直接运行）。
  2. 双击根目录的 “AI Video.exe”。
  3. 第一次启动需要 1-2 分钟，启动完成后客户端窗口会自动加载工作台。
     如未自动加载，工作台地址为 http://127.0.0.1:18788/ 。

二、创建桌面快捷方式（可选）
  双击根目录的 “创建桌面快捷方式.cmd”，桌面上会出现 “AI Video” 图标，
  以后双击图标即可启动。

三、首次配置 API Key
  1. 打开工作台页面后，进入”设置 / 系统”页面。
  2. 把你的 API Key 填入对应输入框并保存。
  3. 配置会保存到本机：%APPDATA%\\AI Video\\config\\
     （不会写回安装目录，升级时不会丢失。）

四、视频输出在哪里
  生成的视频与素材默认保存在：
    我的文档\\AI Video Outputs
  （即 %USERPROFILE%\\Documents\\AI Video Outputs）

五、启动失败怎么办
  1. 双击 tools\\Export-Diagnostics.cmd，会在桌面生成一个
     “AI-Video-诊断-时间戳” 文件夹，把它打包发给我们即可。
  2. 需要命令行模式或更详细日志时，可双击：
       tools\\AI Video (命令行模式).cmd
       tools\\Start-AI-Video-Debug.cmd
  3. 双击 tools\\Open-Logs.cmd 可直接打开日志目录。

本版本为内测候选版（RC）。
`;

// commit hash for traceability: CI env first, then local git, else 'unknown'.
function resolveCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, timeout: 10000 }).toString('utf8').trim(); }
  catch { return 'unknown'; }
}
function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function sha256RuntimeAsset(rel) {
  return sha256File(path.join(RUNTIME_DIR, rel));
}

function main() {
  const nodeExe = path.join(ROOT, 'runtime', 'bin', 'node.exe');
  const ffExe = path.join(ROOT, 'runtime', 'bin', 'ffmpeg.exe');
  if (!fs.existsSync(nodeExe)) throw new Error('missing runtime/bin/node.exe (run fetch-node-exe.mjs)');
  if (!fs.existsSync(ffExe)) throw new Error('missing runtime/bin/ffmpeg.exe (run build-ffmpeg-lgpl.sh)');

  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  // The full runnable project tree goes under resources/runtime/ (PROJECT_ROOT).
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) { log(`skip (absent): ${item}`); continue; }
    copyFiltered(src, path.join(RUNTIME_DIR, item));
    log(`copied ${item} -> resources/runtime/`);
  }

  stripNonWin32Addons(path.join(RUNTIME_DIR, 'node_modules'));
  pruneStagingTree(RUNTIME_DIR);

  sanitizeConfig(path.join('config', 'local-config.json'));
  sanitizeConfig(path.join('版本测试', 'config', 'local-config.json'));

  // P14-B5: Copy Electron desktop shell (AI Video.exe + DLLs + PAKs + locales +
  // resources/app/) from the pre-built ELECTRON_UNPACKED dir into staging root.
  // build-electron-shell.mjs must run before assemble on the Windows CI runner.
  if (!fs.existsSync(ELECTRON_UNPACKED)) {
    throw new Error(
      `Electron unpacked output not found: ${ELECTRON_UNPACKED}\n` +
      `Run 'node scripts/win/build-electron-shell.mjs' first (requires Windows runner with npm ci).`
    );
  }
  fs.cpSync(ELECTRON_UNPACKED, STAGE, { recursive: true });
  log(`copied Electron shell: ${ELECTRON_UNPACKED} -> ${STAGE}`);

  // licenses notice alongside the runtime tree.
  fs.mkdirSync(path.join(RESOURCES, 'licenses'), { recursive: true });
  fs.writeFileSync(path.join(RESOURCES, 'licenses', 'NOTICE.txt'),
    crlf('第三方依赖的许可证文件随各自包保留在 resources/runtime/node_modules 内。\nffmpeg 为干净的 LGPL 构建（无 gpl/x264/x265）。\n'));

  // User-facing surface at the staging root: shortcut helper + usage text.
  // Primary entry is AI Video.exe (copied from Electron unpacked above).
  fs.writeFileSync(path.join(STAGE, '创建桌面快捷方式.cmd'), crlf(SHORTCUT_CMD));
  fs.writeFileSync(path.join(STAGE, '使用说明.txt'), crlf(USAGE_TXT));

  // tools/: cmd-mode fallback + debug + diagnostics + log opener.
  fs.mkdirSync(path.join(STAGE, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(STAGE, 'tools', 'AI Video (命令行模式).cmd'), crlf(MAIN_CMD));
  fs.writeFileSync(path.join(STAGE, 'tools', 'Start-AI-Video-Debug.cmd'), crlf(DEBUG_CMD));
  fs.writeFileSync(path.join(STAGE, 'tools', 'Export-Diagnostics.cmd'), crlf(EXPORT_CMD));
  fs.writeFileSync(path.join(STAGE, 'tools', 'Open-Logs.cmd'), crlf(OPEN_LOGS_CMD));
  fs.writeFileSync(path.join(STAGE, 'tools', 'Stop-AI-Video.cmd'), crlf(STOP_CMD));
  log('wrote 创建桌面快捷方式.cmd, 使用说明.txt, tools/{AI Video (命令行模式),Start-AI-Video-Debug,Export-Diagnostics,Open-Logs,Stop-AI-Video}.cmd, resources/licenses');

  const nodeVer = execFileSync(nodeExe, ['--version'], { timeout: 20000 }).toString('utf8').trim();
  const ffVer = execFileSync(ffExe, ['-hide_banner', '-version'], { timeout: 20000 }).toString('utf8');
  const ffSha = sha256File(ffExe);
  const commit = resolveCommit();
  const builtAt = new Date().toISOString();
  const manifest = {
    name: NAME,
    platform: 'win32-x64',
    built_at: builtAt,
    commit,
    node_exe_version: nodeVer,
    ffmpeg_version: ffVer.split('\n')[0],
    ffmpeg_configuration: (ffVer.split('\n').find((l) => l.startsWith('configuration:')) || '').trim(),
    ffmpeg_sha256: ffSha,
    zip_sha256: '', // filled by zip-windows-portable.mjs after compression
    final_merge: 'stream copy (-c copy) via AI_VIDEO_FFMPEG_PATH absolute path',
    business_assets: {
      prompt_center: sha256RuntimeAsset(path.join('prompts', 'prompt_center.json')),
      prompt_center_ui_seed: sha256RuntimeAsset(path.join('版本测试', 'prompts', 'prompt_center.json')),
      workflow_n8n02b: sha256RuntimeAsset(path.join('正式导入文件', 'iteration-v1', 'n8n02b.json')),
      workflow_n8n03: sha256RuntimeAsset(path.join('正式导入文件', 'iteration-v1', 'n8n03.json')),
      review_asset_service: sha256RuntimeAsset(path.join('版本测试', 'serve-review-assets.mjs')),
      quality_gate: 'scripts/win/verify-business-assets.mjs',
    },
    project_root: 'resources/runtime',
    user_data_dir: '%APPDATA%\\AI Video',
    output_dir: '%USERPROFILE%\\Documents\\AI Video Outputs',
    note: 'portable zip; client-shaped (engineering tree under resources/runtime); no installer/MSI; no API keys baked in; non-win32 .node stripped',
  };
  const version = {
    name: 'AI Video',
    channel: 'rc',
    version: '0.0.0-rc',
    platform: 'win32-x64',
    built_at: builtAt,
    commit,
    entry: 'AI Video.exe',
    note: 'portable RC; primary entry is AI Video.exe (Electron desktop shell); cmd-mode fallback at tools/AI Video (命令行模式).cmd',
  };
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(OUT_ROOT, 'runtime-manifest.json'), manifestJson);
  fs.writeFileSync(path.join(STAGE, 'runtime-manifest.json'), manifestJson);
  fs.writeFileSync(path.join(STAGE, 'version.json'), JSON.stringify(version, null, 2) + '\n');
  log(`staged. node ${nodeVer} | ${manifest.ffmpeg_version} | commit ${commit.slice(0, 12)}`);
  log(`client root: ${STAGE}`);
  log(`project root: ${RUNTIME_DIR}`);
  printStagingStats(STAGE);
}
main();
