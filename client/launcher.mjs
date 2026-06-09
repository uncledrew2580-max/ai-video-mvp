#!/usr/bin/env node
/**
 * Phase 2.1 Mac MVP Launcher
 * 用法: node client/launcher.mjs
 */

import { spawn, execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import { waitForN8nDbSchemaReady } from '../scripts/win/n8n-db-ready.mjs';

// ─── 路径 ──────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const UI_DIR = join(PROJECT_ROOT, '版本测试');
const UI_SCRIPT = join(UI_DIR, 'serve-review-assets.mjs');
const WORKFLOW_BOOTSTRAP_SCRIPT = join(PROJECT_ROOT, 'scripts', 'bootstrap-ai-video-workflows.mjs');
const _launcherPath = __dirname.replace(/\\/g, '/');
// Dist detection. macOS: path lives inside an .app bundle or /dist/. Windows
// packaged: launcher lives at resources/runtime/client/launcher.mjs (no .app),
// so also treat the Electron/cmd shell signals as dist:
//   - AI_VIDEO_APP_MODE=1 (set by both desktop shells)
//   - the packaged resources/runtime/ layout
// Without this, the Windows app falls back to source-dev paths and POSIX-only
// port handling (lsof/SIGTERM), writing config into resources/runtime/版本测试/.
const _IS_DIST =
  _launcherPath.includes('.app/Contents/') ||
  _launcherPath.includes('/dist/') ||
  _launcherPath.includes('/resources/runtime/') ||
  process.env.AI_VIDEO_APP_MODE === '1';
// Per-user data base, platform-aware: Windows -> %APPDATA%\AI Video,
// macOS -> ~/Library/Application Support/AI Video, others -> ~/.ai-video.
const APP_SUPPORT_DIR = process.platform === 'win32'
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'AI Video')
  : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'AI Video')
    : join(homedir(), '.ai-video');
const RUNTIME_ROOT = process.env.AI_VIDEO_RUNTIME_ROOT || (_IS_DIST ? APP_SUPPORT_DIR : PROJECT_ROOT);
const DEFAULT_WORKFLOW_DATA_ROOT = _IS_DIST ? join(APP_SUPPORT_DIR, 'workflow-data') : PROJECT_ROOT;
const WORKFLOW_DATA_ROOT = process.env.WORKFLOW_DATA_ROOT || DEFAULT_WORKFLOW_DATA_ROOT;
// Windows dist: n8n user folder defaults to workflow-data (matches the env both
// the Electron exe and the cmd entry inject), so the n8n DB never splits to a
// separate n8n-user dir. macOS/other dist keep n8n-user to avoid relocating an
// existing on-disk n8n DB.
const _DIST_N8N_USER_FOLDER = process.platform === 'win32'
  ? join(APP_SUPPORT_DIR, 'workflow-data')
  : join(APP_SUPPORT_DIR, 'n8n-user');
const N8N_USER_FOLDER = process.env.N8N_USER_FOLDER || (_IS_DIST ? _DIST_N8N_USER_FOLDER : join(PROJECT_ROOT, '.n8n-local-cache'));
const LOG_DIR = process.env.AI_VIDEO_LOG_DIR || (_IS_DIST ? join(APP_SUPPORT_DIR, 'logs', 'launcher') : join(PROJECT_ROOT, 'logs', 'launcher'));
const CONFIG_PATH = process.env.AI_VIDEO_CONFIG_PATH || (_IS_DIST
  ? join(APP_SUPPORT_DIR, 'config', 'local-config.json')
  : join(PROJECT_ROOT, '版本测试', 'config', 'local-config.json'));
// Bundled ffmpeg for final-video merge (n8n03). Final merge must NOT rely on a
// bare `ffmpeg` from PATH (a clean Mac has none). Prefer an explicit override,
// then the binary shipped inside the app at <PROJECT_ROOT>/runtime/bin/ffmpeg.
const FFMPEG_PATH = process.env.AI_VIDEO_FFMPEG_PATH || join(PROJECT_ROOT, 'runtime', 'bin', 'ffmpeg');

const N8N_PORT = Number(process.env.N8N_PORT || 5678);
const N8N_RUNNERS_BROKER_PORT = Number(process.env.N8N_RUNNERS_BROKER_PORT || N8N_PORT + 1);
// Client-owned UI port: 18788 for dist app, 8788 for source dev.
// detect dist by checking if this launcher lives inside a .app bundle or /dist/
const UI_PORT = Number(process.env.REVIEW_ASSET_PORT || (_IS_DIST ? 18788 : 8788));
const N8N_URL = process.env.N8N_HOST || `http://127.0.0.1:${N8N_PORT}`;
const UI_URL = `http://127.0.0.1:${UI_PORT}`;
const DEFAULT_GLOBAL_N8N_DB = join(homedir(), '.n8n', 'database.sqlite');
let shuttingDown = false;
let restartingN8n = false;

// ─── 工具函数 ──────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function log(msg)  { console.log(`[${ts()}] ${msg}`); }
function warn(msg) { console.warn(`[${ts()}] ⚠️  ${msg}`); }
function fail(msg) { console.error(`[${ts()}] ❌ ${msg}`); }

/** 检查端口是否有服务在监听。返回 'free' 或 'busy' */
function checkPort(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock.once('connect', () => { sock.destroy(); resolve('busy'); });
    sock.once('error',   () => { sock.destroy(); resolve('free'); });
    sock.once('timeout', () => { sock.destroy(); resolve('free'); });
    sock.connect(port, '127.0.0.1');
  });
}

/** HTTP GET，返回 true 表示服务存活（状态码 < 500） */
function httpOk(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** HTTP GET JSON，返回解析后的对象；失败返回 null */
function httpGetJson(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function getPidsOnPort(port) {
  try {
    const pids = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true`, { encoding: 'utf8', shell: true }).trim();
    if (!pids) return [];
    return pids.split(/\s+/).map(Number).filter(Boolean);
  } catch {
    return [];
  }
}

function getProcessCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function isPortOwnedByCurrentApp(port) {
  const pidList = getPidsOnPort(port);
  if (pidList.length === 0) return false;
  return pidList.some((pid) => {
    const command = getProcessCommand(pid);
    return command.includes(PROJECT_ROOT)
      || command.includes(APP_SUPPORT_DIR)
      || command.includes(N8N_USER_FOLDER);
  });
}

/** 停止占用指定端口的所有进程 (macOS/Linux: lsof + kill) */
async function killProcessesOnPort(port) {
  try {
    const pidList = getPidsOnPort(port);
    if (pidList.length === 0) return;
    log(`正在停止端口 ${port} 的旧进程 (PID: ${pidList.join(', ')})...`);
    for (const pid of pidList) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    await sleep(2000);
    for (const pid of pidList) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await sleep(500);
  } catch {}
}

/** 轮询直到服务响应或超时 */
async function waitForService(url, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpOk(url)) {
      log(`✅ ${label} 就绪`);
      return true;
    }
    await sleep(1000);
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function resolveLocalN8nDbPath() {
  if (process.env.N8N_DB_PATH) return process.env.N8N_DB_PATH;
  return join(N8N_USER_FOLDER, '.n8n', 'database.sqlite');
}

/** 找 n8n：先项目内 node_modules，再 PATH，再 ~/.npm-global/bin/n8n */
function findN8n() {
  const localPackageBin = join(PROJECT_ROOT, 'node_modules', 'n8n', 'bin', 'n8n');
  if (existsSync(localPackageBin)) return localPackageBin;

  const localBin = join(PROJECT_ROOT, 'node_modules', '.bin', 'n8n');
  if (existsSync(localBin)) return localBin;

  try {
    const found = execSync('which n8n', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (found && existsSync(found)) return found;
  } catch {}
  const fallback = join(homedir(), '.npm-global', 'bin', 'n8n');
  if (existsSync(fallback)) return fallback;
  return null;
}

function hasPackageDependency(name) {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.optionalDependencies?.[name]);
  } catch {
    return false;
  }
}

function printInstallHelp() {
  console.error('');
  console.error('  解决办法：');
  console.error('  1. 双击 client/mac/安装运行依赖.command');
  console.error('  2. 安装完成后，再双击 TikTok AI 视频工作台.command');
  console.error('');
  console.error('  如果你懂命令行，也可以在项目根目录运行：');
  console.error('    npm install');
  console.error('');
}

/** macOS: open URL in default browser */
function openBrowser(url) {
  try {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    warn(`无法自动打开浏览器：${e.message}`);
    log(`请手动访问: ${url}`);
  }
}

function shouldOpenBrowser() {
  return !process.argv.includes('--no-browser') && process.env.AI_VIDEO_NO_BROWSER !== '1';
}

function runWorkflowBootstrap(dbPath) {
  if (process.env.AI_VIDEO_BOOTSTRAP_WORKFLOWS === '0') {
    return { ok: true, changed: false, skipped: true };
  }
  if (!existsSync(WORKFLOW_BOOTSTRAP_SCRIPT)) {
    warn(`找不到工作流初始化脚本：${WORKFLOW_BOOTSTRAP_SCRIPT}`);
    return { ok: false, changed: false };
  }
  try {
    const stdout = execFileSync(process.execPath, [WORKFLOW_BOOTSTRAP_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PROJECT_ROOT,
        N8N_USER_FOLDER,
        N8N_DB_PATH: dbPath,
        REVIEW_ASSET_PORT: String(UI_PORT),
        WORKSPACE_HOST: UI_URL,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(stdout);
    if (result.ok) {
      log(`工作流自检完成：${result.workflows?.length || 0} 个核心 workflow 已就绪`);
      return result;
    }
  } catch (e) {
    warn(`工作流自检失败：${e.stderr?.toString?.().trim() || e.message}`);
  }
  return { ok: false, changed: false };
}

const WORKFLOW_SYNC_SCRIPT = join(PROJECT_ROOT, 'sync_iteration_v1_workflows_to_db.mjs');

function runWorkflowSync(dbPath) {
  if (!existsSync(WORKFLOW_SYNC_SCRIPT)) {
    warn(`找不到工作流同步脚本：${WORKFLOW_SYNC_SCRIPT}`);
    return false;
  }
  try {
    execFileSync(process.execPath, [WORKFLOW_SYNC_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PROJECT_ROOT, TIKTOK_WORKFLOW_ROOT: PROJECT_ROOT, N8N_DB_PATH: dbPath, REVIEW_ASSET_PORT: String(UI_PORT), WORKSPACE_HOST: UI_URL },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    log('工作流版本已同步到 DB ✓');
    return true;
  } catch (e) {
    warn(`工作流同步失败：${e.stderr?.toString?.().trim() || e.message}`);
    return false;
  }
}

/** 向 children 发 SIGTERM，3 秒后强制 SIGKILL */
function shutdown(children) {
  shuttingDown = true;
  if (children.length === 0) { process.exit(0); return; }
  log('正在停止子进程...');
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => {
    for (const c of children) {
      try { c.kill('SIGKILL'); } catch {}
    }
    process.exit(0);
  }, 3000).unref();
}

async function stopChild(child, label) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch { resolve(); }
  });
  log(`${label} 已重启准备`);
}

function removeChild(children, child) {
  const idx = children.indexOf(child);
  if (idx >= 0) children.splice(idx, 1);
}

async function restartManagedN8n(n8nBin, children, reason) {
  if (shuttingDown || restartingN8n) return;
  restartingN8n = true;
  warn(`n8n 已离线，正在自动重启（${reason}）...`);
  try {
    if (await httpOk(`${N8N_URL}/healthz`, 1500)) {
      log('n8n 已恢复 ✓');
      return;
    }
    await startN8n(n8nBin, children, { watchdog: true });
    log('n8n 自动重启完成 ✓');
  } catch (error) {
    fail(`n8n 自动重启失败：${error.message || String(error)}`);
  } finally {
    restartingN8n = false;
  }
}

function startN8nWatchdog(n8nBin, children) {
  setInterval(async () => {
    if (shuttingDown || restartingN8n) return;
    if (!(await httpOk(`${N8N_URL}/healthz`, 2000))) {
      await restartManagedN8n(n8nBin, children, '健康检查失败');
    }
  }, 15000).unref();
}

async function startN8n(n8nBin, children, options = {}) {
  const logStream = createWriteStream(join(LOG_DIR, 'n8n.log'), { flags: 'a' });
  logStream.write(`\n──── 启动于 ${new Date().toISOString()} ────\n`);

  const n8nCommand = n8nBin.startsWith(PROJECT_ROOT)
    ? { command: process.execPath, args: [n8nBin, 'start'] }
    : { command: n8nBin, args: ['start'] };

  const n8nProc = spawn(n8nCommand.command, n8nCommand.args, {
    env: {
      ...process.env,
      PATH: [join(PROJECT_ROOT, 'bin'), process.env.PATH || ''].filter(Boolean).join(':'),
      N8N_USER_FOLDER,
      N8N_PORT: String(N8N_PORT),
      N8N_HOST: '127.0.0.1',
      N8N_LISTEN_ADDRESS: '127.0.0.1',
      N8N_PROTOCOL: 'http',
      WEBHOOK_URL: `${N8N_URL.replace(/\/+$/, '')}/`,
      N8N_RUNNERS_BROKER_PORT: String(N8N_RUNNERS_BROKER_PORT),
      N8N_RUNNERS_TASK_TIMEOUT: '900',
      N8N_RUNNERS_TASK_REQUEST_TIMEOUT: '1200',
      NODE_FUNCTION_ALLOW_BUILTIN: '*',
      NODE_FUNCTION_ALLOW_EXTERNAL: 'sharp',
      PROJECT_ROOT,
      TIKTOK_WORKFLOW_ROOT: PROJECT_ROOT,
      AI_VIDEO_RUNTIME_ROOT: RUNTIME_ROOT,
      WORKFLOW_DATA_ROOT,
      AI_VIDEO_CONFIG_PATH: CONFIG_PATH,
      AI_VIDEO_FFMPEG_PATH: FFMPEG_PATH,
      N8N_DISABLE_UI: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  n8nProc.stdout.pipe(logStream);
  n8nProc.stderr.pipe(logStream);
  children.push(n8nProc);
  const _n8nPidFile = join(RUNTIME_ROOT, '.n8n.pid');
  try { writeFileSync(_n8nPidFile, String(n8nProc.pid)); } catch {}

  n8nProc.on('exit', (code) => {
    try { if (readFileSync(_n8nPidFile, 'utf8').trim() === String(n8nProc.pid)) unlinkSync(_n8nPidFile); } catch {}
    removeChild(children, n8nProc);
    if (code !== null && code !== 0) {
      fail(`n8n 进程意外退出 (code ${code})，请查看：${join(LOG_DIR, 'n8n.log')}`);
    }
    if (options.watchdog && !shuttingDown) {
      setTimeout(() => restartManagedN8n(n8nBin, children, '进程退出'), 3000).unref();
    }
  });

  log('n8n 启动中...');
  const ok = await waitForService(`${N8N_URL}/healthz`, 'n8n', 45000);
  if (!ok) {
    fail(`n8n 启动超时（45s）。请查看：${join(LOG_DIR, 'n8n.log')}`);
    shutdown(children);
    process.exit(1);
  }

  return n8nProc;
}

// ─── 帮助 ──────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
  AI Video — 本地服务启动器

  用法:
    node client/launcher.mjs          启动所有服务并打开工作台
    node client/launcher.mjs --no-browser
                                      只启动服务，不自动打开浏览器
    node client/launcher.mjs --help   显示本帮助

  它会做什么:
    1. 检查 Node.js 版本（需 v18+）
    2. 找到 n8n 可执行文件（PATH 或 ~/.npm-global/bin/n8n）
    3. 检查端口 ${N8N_PORT} / ${UI_PORT}
       · 服务已健康运行 → 直接复用，不重复启动
       · 端口被占但健康检查失败 → 报错退出
    4. 启动 n8n（N8N_USER_FOLDER 隔离，N8N_DISABLE_UI=true）
    5. 启动工作台 UI（版本测试/serve-review-assets.mjs）
    6. 健康检查通过后自动打开浏览器 → ${UI_URL}/
    7. Ctrl+C 优雅停止由本启动器启动的子进程

  日志目录:  logs/launcher/
    n8n.log       — n8n 启动输出
    ui-${UI_PORT}.log   — 工作台 UI 输出

  注意:
    这是 Phase 2.1 Mac MVP，仅在 macOS 测试。
    不含 Electron 封装、授权保护或自动更新。
    后续计划见 docs/CLIENT_PACKAGING_PLAN.md
`);
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  console.log('');
  console.log('  🎬  AI Video  — 本地服务启动器');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  项目目录: ${PROJECT_ROOT}`);
  console.log('');

  // 1. Node 版本
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    fail(`Node.js 版本过低：当前 v${process.versions.node}，需要 v18+`);
    process.exit(1);
  }
  log(`Node.js v${process.versions.node} ✓`);

  // 2. 找 n8n
  const n8nBin = findN8n();
  if (!n8nBin) {
    fail('找不到 n8n 可执行文件。');
    if (hasPackageDependency('n8n')) {
      printInstallHelp();
    } else {
      console.error('  当前包没有内置 n8n 依赖，请运行：npm install -g n8n');
    }
    process.exit(1);
  }
  log(`n8n: ${n8nBin} ✓`);

  // 3. UI 脚本存在？
  if (!existsSync(UI_SCRIPT)) {
    fail(`找不到 UI 脚本：${UI_SCRIPT}`);
    process.exit(1);
  }

  // 4. 日志目录
  ensureDir(LOG_DIR);

  // 5. 端口检查
  const [n8nPortState, uiPortState] = await Promise.all([
    checkPort(N8N_PORT),
    checkPort(UI_PORT),
  ]);

  let n8nAlreadyUp = false;
  let uiAlreadyUp = false;
  let n8nDbPathForUi = resolveLocalN8nDbPath();
  // workflowDataRoot: where n8n Code nodes write concept-context / project-state.
  // Kept separate from PROJECT_ROOT so the dist app retains its own script root
  // while reading data from wherever the external n8n instance actually writes.
  let workflowDataRoot = WORKFLOW_DATA_ROOT;
  ensureDir(workflowDataRoot);

  if (n8nPortState === 'busy') {
    const n8nHealthy = await httpOk(`${N8N_URL}/healthz`);
    const n8nOwnedByThisApp = isPortOwnedByCurrentApp(N8N_PORT);

    if (_IS_DIST && !n8nOwnedByThisApp) {
      fail(`端口 ${N8N_PORT} 已被其他程序占用，AI Video 未清理该进程。\n请关闭占用端口 ${N8N_PORT} 的程序或重启电脑后再打开 AI Video。\n日志：${LOG_DIR}`);
      process.exit(1);
    } else if (n8nHealthy) {
      log('n8n 已在运行，复用现有进程 ✓');
      n8nAlreadyUp = true;
      if (!_IS_DIST && !process.env.N8N_DB_PATH && existsSync(DEFAULT_GLOBAL_N8N_DB)) {
        n8nDbPathForUi = DEFAULT_GLOBAL_N8N_DB;
        log(`工作台将读取现有 n8n 数据库: ${n8nDbPathForUi}`);
      }
    } else {
      if (_IS_DIST) {
        warn(`端口 ${N8N_PORT} 被本 App 旧进程占用但健康检查失败，正在清理本 App 旧进程后重启。`);
        const brokerPortState = await checkPort(N8N_RUNNERS_BROKER_PORT);
        const brokerOwnedByThisApp = brokerPortState === 'busy' ? isPortOwnedByCurrentApp(N8N_RUNNERS_BROKER_PORT) : false;
        if (brokerPortState === 'busy' && !brokerOwnedByThisApp) {
          fail(`端口 ${N8N_RUNNERS_BROKER_PORT} (runner broker) 已被其他程序占用，AI Video 未清理该进程。\n请关闭占用端口 ${N8N_RUNNERS_BROKER_PORT} 的程序或重启电脑后再打开 AI Video。\n日志：${LOG_DIR}`);
          process.exit(1);
        }
        await killProcessesOnPort(N8N_PORT);
        if (brokerPortState === 'busy' && brokerOwnedByThisApp) {
          await killProcessesOnPort(N8N_RUNNERS_BROKER_PORT);
        }
        if (await checkPort(N8N_PORT) === 'busy') {
          fail(`无法释放 n8n 端口 ${N8N_PORT}，请重启电脑后再打开 AI Video。`);
          process.exit(1);
        }
        log(`n8n 端口 ${N8N_PORT} 已释放 ✓`);
      } else {
        fail(`端口 ${N8N_PORT} 被占用，但 n8n 健康检查失败。`);
        console.error('  可以用以下命令查看并停止占用进程：');
        console.error(`    lsof -ti:${N8N_PORT} | xargs kill -9`);
        process.exit(1);
      }
    }
  }

  if (uiPortState === 'busy') {
    // Ownership check: call /health/meta to see if the existing process belongs to this app.
    // "Belongs" means project/config/data paths match — same app instance, not a
    // stale source server or a previous packaged process with old env paths.
    const meta = await httpGetJson(`${UI_URL}/health/meta`);
    const ownsPort = meta?.project_root === PROJECT_ROOT
      && meta?.config_path === CONFIG_PATH
      && meta?.workflow_data_root === workflowDataRoot;

    if (ownsPort) {
      log(`工作台 UI 已在运行（当前 app，PID ${meta.server_pid}），复用现有进程 ✓`);
      uiAlreadyUp = true;
    } else {
      const _uiOccupant = meta
        ? `被其他 AI Video 实例占用 (project_root: ${meta.project_root})`
        : '被未知进程占用，无法识别所属实例';
      if (_IS_DIST) {
        fail(`端口 ${UI_PORT} ${_uiOccupant}，AI Video 未清理该进程。\n请关闭占用端口 ${UI_PORT} 的程序或重启电脑后再打开 AI Video。\n日志：${LOG_DIR}`);
        process.exit(1);
      } else {
        fail(`端口 ${UI_PORT} ${_uiOccupant}。\n请手动关闭后重试：lsof -ti:${UI_PORT} | xargs kill -9`);
        process.exit(1);
      }
    }
  }

  // Warn about source dev server on 8788 — do NOT kill it, do NOT use it.
  if (UI_PORT !== 8788) {
    const sourcePortState = await checkPort(8788);
    if (sourcePortState === 'busy') {
      warn('检测到 source 开发服务器在端口 8788。客户端将完全使用自己的 18788 服务，不受影响。');
    }
  }

  const children = [];

  // ─── 启动 n8n ──────────────────────────────────────────────────────────────
  if (!n8nAlreadyUp) {
    let n8nProc = await startN8n(n8nBin, children, { watchdog: false });
    // Create and migrate the DB first, then stop n8n before writing workflows.
    // SQLite can be locked while n8n is running, and active webhooks are only
    // registered during n8n startup anyway.
    //
    // P14-B8E: n8n reports /healthz ready BEFORE its first-run SQLite migrations
    // finish. If we stop n8n and bootstrap now, the bootstrap opens an un-migrated
    // DB ("schema is not ready") and aborts before the workbench ever starts
    // (the B8D Windows failure). Wait — while n8n is still running — until the
    // workflow schema actually exists, then stop n8n and bootstrap.
    log('正在初始化本地工作流引擎…');
    const schemaReady = await waitForN8nDbSchemaReady(n8nDbPathForUi, {
      timeoutMs: 120000,
      onWait: () => log('正在初始化本地工作流引擎…（首次启动需要完成数据库迁移）'),
    });
    removeChild(children, n8nProc);
    await stopChild(n8nProc, 'n8n');

    if (!schemaReady) {
      if (_IS_DIST) {
        fail(`n8n 数据库初始化未完成，请稍后重试或导出诊断包。\n日志：${join(LOG_DIR, 'n8n.log')}\nDB：${n8nDbPathForUi}`);
        process.exit(1);
      } else {
        warn('n8n 数据库 schema 尚未就绪（120s 超时），工作流自检可能失败。');
      }
    }

    const bootstrap = runWorkflowBootstrap(n8nDbPathForUi);
    if (!bootstrap.ok) {
      if (_IS_DIST) {
        fail(`工作流初始化失败，无法继续启动。\n日志：${join(LOG_DIR, 'n8n.log')}\nDB：${n8nDbPathForUi}`);
        process.exit(1);
      } else {
        warn('工作流未能自动初始化，表单入口可能 404。');
      }
    }
    const syncOk = runWorkflowSync(n8nDbPathForUi);
    if (!syncOk && _IS_DIST) {
      fail(`工作流版本同步失败，无法继续启动。\n日志：${join(LOG_DIR, 'n8n.log')}\nDB：${n8nDbPathForUi}`);
      process.exit(1);
    }
    n8nProc = await startN8n(n8nBin, children, { watchdog: true });
  } else {
    if (_IS_DIST) {
      log('复用当前客户端 n8n：保持现有执行进程。');
    } else {
      log('复用外部 n8n：跳过自动写库。如需同步工作流版本，请访问 /system 页面。');
    }
  }

  // ─── 启动工作台 UI ─────────────────────────────────────────────────────────
  if (!uiAlreadyUp) {
    const uiLogName = `ui-${UI_PORT}.log`;
    const logStream = createWriteStream(join(LOG_DIR, uiLogName), { flags: 'a' });
    logStream.write(`\n──── 启动于 ${new Date().toISOString()} ────\n`);

    const uiProc = spawn(process.execPath, ['serve-review-assets.mjs'], {
      cwd: UI_DIR,
      env: {
        ...process.env,
        PROJECT_ROOT,                              // script/config root (dist or source)
        AI_VIDEO_RUNTIME_ROOT: RUNTIME_ROOT,
        AI_VIDEO_LOG_DIR: dirname(LOG_DIR),
        AI_VIDEO_CONFIG_PATH: CONFIG_PATH,
        WORKFLOW_DATA_ROOT: workflowDataRoot,      // n8n concept-context / project-state root
        REVIEW_ASSET_PORT: String(UI_PORT),
        N8N_PORT: String(N8N_PORT),
        N8N_HOST: N8N_URL,
        N8N_DB_PATH: n8nDbPathForUi,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    uiProc.stdout.pipe(logStream);
    uiProc.stderr.pipe(logStream);
    children.push(uiProc);

    uiProc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        fail(`工作台 UI 进程意外退出 (code ${code})，请查看：${join(LOG_DIR, uiLogName)}`);
      }
    });

    log('工作台 UI 启动中...');
    const ok = await waitForService(`${UI_URL}/`, '工作台 UI', 20000);
    if (!ok) {
      fail(`工作台 UI 启动超时（20s）。请查看：${join(LOG_DIR, uiLogName)}`);
      shutdown(children);
      process.exit(1);
    }
  }

  // ─── 打开浏览器 ────────────────────────────────────────────────────────────
  if (shouldOpenBrowser()) {
    openBrowser(UI_URL);
  }

  startN8nWatchdog(n8nBin, children);

  console.log('');
  console.log(`  ✅ 所有服务就绪`);
  console.log(`  📺 工作台地址:  ${UI_URL}`);
  console.log(`  📝 日志目录:    ${LOG_DIR}`);
  if (children.length > 0) {
    console.log('  按 Ctrl+C 停止由本启动器启动的服务');
  } else {
    console.log('  （所有服务均为复用，本启动器无子进程管理）');
  }
  console.log('');

  // ─── 信号处理 ──────────────────────────────────────────────────────────────
  process.on('SIGINT',  () => { console.log(''); shutdown(children); });
  process.on('SIGTERM', () => shutdown(children));

  // 如果有子进程，挂起主进程直到 Ctrl+C
  if (children.length > 0) {
    await new Promise(() => {});
  }
}

main().catch((e) => {
  fail(`启动异常：${e.message}`);
  process.exit(1);
});
