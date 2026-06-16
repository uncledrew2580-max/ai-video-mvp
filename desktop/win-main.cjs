'use strict';
// P14-B5: Windows Electron desktop shell.
// Packaged by electron-builder --win dir; lives in resources/app/win-main.cjs.
// PROJECT_ROOT (n8n backend) = resources/runtime/ (sibling to resources/app/).
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const UI_PORT = process.env.AI_VIDEO_UI_PORT || '18788';
const N8N_PORT = process.env.AI_VIDEO_N8N_PORT || '5678';
const UI_URL = `http://127.0.0.1:${UI_PORT}/`;

// __dirname = resources/app/  →  runtime is resources/runtime/
const PROJECT_ROOT = path.resolve(__dirname, '..', 'runtime');
const NODE_EXE = path.join(PROJECT_ROOT, 'runtime', 'bin', 'node.exe');
const NODE_BIN_DIR = path.dirname(NODE_EXE);
const LAUNCHER = path.join(PROJECT_ROOT, 'client', 'launcher.mjs');
const FFMPEG_EXE = path.join(PROJECT_ROOT, 'runtime', 'bin', 'ffmpeg.exe');

let mainWindow;
let launcherProcess;
let isQuitting = false;

// ── Per-user data layout (root cause #1) ────────────────────────────────────
// AI Video.exe must inject the SAME env the cmd-mode launcher sets (assemble's
// ENV_BLOCK). Without it, client/launcher.mjs fails dist detection and falls
// back to source-dev paths, writing config into resources/runtime/版本测试/.
function aiVideoHome() {
  return path.join(app.getPath('appData'), 'AI Video');
}
function userDataLayout() {
  const home = aiVideoHome();
  return {
    home,
    configDir: path.join(home, 'config'),
    configPath: path.join(home, 'config', 'local-config.json'),
    logDir: path.join(home, 'logs', 'launcher'),
    runtimeRoot: home,
    pidDir: path.join(home, 'runtime'),
    pidPath: path.join(home, 'runtime', 'ai-video.pid'),
    // n8n user folder == workflow-data so the n8n DB and the workflow data root
    // live under one user dir (%APPDATA%\AI Video\workflow-data), never n8n-user.
    workflowDataRoot: path.join(home, 'workflow-data'),
    n8nUserFolder: path.join(home, 'workflow-data'),
  };
}
function ensureUserDataDirs(layout) {
  for (const dir of [layout.home, layout.configDir, layout.logDir, layout.pidDir, layout.workflowDataRoot, layout.n8nUserFolder]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}
function writePidFile(layout) {
  try { fs.writeFileSync(layout.pidPath, String(process.pid)); } catch {}
}
function removePidFile(layout) {
  // Only remove the file when it still names this process — never touch a PID we
  // do not own.
  try {
    if (fs.readFileSync(layout.pidPath, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(layout.pidPath);
    }
  } catch {}
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

function logDir() {
  return path.join(app.getPath('appData'), 'AI Video', 'logs', 'launcher');
}

function envPathKey(env = process.env) {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'Path';
}

function withPrependedPath(baseEnv, entries) {
  const pathKey = envPathKey(baseEnv);
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path' && key !== pathKey) delete env[key];
  }
  const currentPath = baseEnv[pathKey] || baseEnv.Path || baseEnv.PATH || '';
  env[pathKey] = [...entries, currentPath].filter(Boolean).join(path.delimiter);
  return env;
}

function httpOk(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForUi(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpOk(UI_URL)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 950,
    minWidth: 1180,
    minHeight: 760,
    title: 'AI Video',
    backgroundColor: '#edf4fb',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.removeMenu();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const local = (u) =>
      u.startsWith(`http://127.0.0.1:${UI_PORT}`) ||
      u.startsWith(`http://localhost:${UI_PORT}`) ||
      u.startsWith(`http://127.0.0.1:${N8N_PORT}`) ||
      u.startsWith(`http://localhost:${N8N_PORT}`);
    if (local(url)) { mainWindow.loadURL(url); return { action: 'deny' }; }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const local = (u) =>
      u.startsWith('data:') ||
      u.startsWith(`http://127.0.0.1:${UI_PORT}`) ||
      u.startsWith(`http://localhost:${UI_PORT}`) ||
      u.startsWith(`http://127.0.0.1:${N8N_PORT}`) ||
      u.startsWith(`http://localhost:${N8N_PORT}`);
    if (!local(url)) { event.preventDefault(); shell.openExternal(url); }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    injectWorkbenchButton();
    injectConfigSaveHandler();
  });

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html lang="zh-CN">
    <head><meta charset="utf-8"><title>AI Video</title>
    <style>
      *{box-sizing:border-box}
      body{margin:0;height:100vh;display:grid;place-items:center;
        font-family:"Segoe UI",system-ui,sans-serif;color:#0f172a;
        background:radial-gradient(circle at 18% 16%,rgba(59,130,246,.20),transparent 32%),
          radial-gradient(circle at 82% 20%,rgba(14,165,233,.16),transparent 30%),
          linear-gradient(135deg,#f8fbff 0%,#eaf2fb 100%)}
      .card{width:min(560px,calc(100vw - 48px));padding:34px 36px;
        border:1px solid rgba(148,163,184,.28);border-radius:18px;
        background:rgba(255,255,255,.78);box-shadow:0 26px 80px rgba(15,23,42,.12)}
      h1{margin:0 0 12px;font-size:32px}
      p{margin:0;color:#475569;font-size:16px;line-height:1.75}
      .bar{margin-top:26px;height:8px;overflow:hidden;border-radius:999px;background:#dbeafe}
      .bar::before{content:"";display:block;height:100%;width:42%;border-radius:inherit;
        background:linear-gradient(90deg,#2563eb,#06b6d4);
        animation:move 1.15s ease-in-out infinite alternate}
      @keyframes move{from{transform:translateX(-20%)}to{transform:translateX(160%)}}
    </style></head>
    <body><section class="card">
      <h1>AI Video 正在启动</h1>
      <p>正在自动启动本地引擎和视频工作台，第一次启动可能需要稍等一会儿。</p>
      <div class="bar"></div>
    </section></body></html>
  `)}`);
}

function injectWorkbenchButton() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const url = mainWindow.webContents.getURL();
  if (!url.startsWith('http://')) return;
  mainWindow.webContents.executeJavaScript(`
    (() => {
      const id = 'ai-video-return-wb';
      if (document.getElementById(id)) return;
      const btn = document.createElement('button');
      btn.id = id; btn.type = 'button'; btn.textContent = '回到工作台';
      Object.assign(btn.style, {
        position:'fixed',right:'18px',bottom:'18px',zIndex:'2147483647',
        padding:'12px 18px',border:'1px solid rgba(37,99,235,.35)',
        borderRadius:'999px',background:'linear-gradient(135deg,#2563eb,#06b6d4)',
        color:'#fff',fontSize:'15px',fontWeight:'800',
        boxShadow:'0 18px 42px rgba(37,99,235,.30)',cursor:'pointer'
      });
      btn.addEventListener('click', () => { window.location.href = ${JSON.stringify(UI_URL)}; });
      document.documentElement.appendChild(btn);
    })();
  `).catch(() => {});
}

// P14-B8T: the config page's own inline <script> does NOT execute in the packaged
// Windows renderer (B8S: save_handler_present=false — neither window.saveConfig nor
// the inline addEventListener marker appear — while this executeJavaScript injection
// DOES run, e.g. the floating button above). So bind the 保存配置 click here, on the
// proven injection path. It collects the SAME [data-path] form fields the page's
// collectConfigBody() reads and POSTs the SAME /config-save endpoint — no direct
// config write, no faked success, no business/route change. Idempotent + marker-gated
// so it never double-fires with the page's own binding (mac, where inline runs).
function injectConfigSaveHandler() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const url = mainWindow.webContents.getURL();
  if (!url.startsWith('http://')) return;
  mainWindow.webContents.executeJavaScript(`
    (() => {
      if (window.AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND) return;
      function collect() {
        const body = { apis: {}, output: {}, services: {} };
        document.querySelectorAll('[data-path]').forEach((el) => {
          const parts = el.dataset.path.split('.');
          let ref = body;
          for (let i = 0; i < parts.length - 1; i++) { ref[parts[i]] = ref[parts[i]] || {}; ref = ref[parts[i]]; }
          ref[parts[parts.length - 1]] = el.value;
        });
        if (body.tasks && body.tasks.creative_direction && body.tasks.creative_direction.model) {
          body.tasks.script_framework = body.tasks.script_framework || {};
          body.tasks.storyboard_prompt = body.tasks.storyboard_prompt || {};
          body.tasks.script_framework.model = body.tasks.creative_direction.model;
          body.tasks.storyboard_prompt.model = body.tasks.creative_direction.model;
        }
        return body;
      }
      async function doSave(btn) {
        const prev = btn.textContent;
        btn.disabled = true; btn.textContent = '保存中…';
        try {
          const r = await fetch('/config-save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collect()) });
          if (r.ok) { setTimeout(() => { window.location.href = '/config'; }, 600); }
          else { window.alert('保存失败，请重试'); btn.disabled = false; btn.textContent = prev; }
        } catch (err) { window.alert('网络错误: ' + ((err && err.message) || err)); btn.disabled = false; btn.textContent = prev; }
      }
      document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest && e.target.closest('[data-testid="save-config-button"], #save-btn');
        if (!btn) return;
        e.preventDefault();
        doSave(btn);
      }, true);
      window.AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND = true;
      try { if (document.body) document.body.dataset.configSaveHandlerBound = 'true'; } catch (_) {}
      try { const sb = document.querySelector('[data-testid="save-config-button"], #save-btn'); if (sb) sb.dataset.boundSave = '1'; } catch (_) {}
    })();
  `).catch(() => {});
}

function startLauncher() {
  if (!fs.existsSync(NODE_EXE)) {
    dialog.showErrorBox(
      'AI Video — 缺少运行环境',
      `找不到捆绑的 Node.js 可执行文件，安装包可能未完整解压。\n\n期望路径：\n${NODE_EXE}\n\n请重新解压整个文件夹后再试。`
    );
    app.quit();
    return;
  }

  const layout = userDataLayout();
  ensureUserDataDirs(layout);

  const env = withPrependedPath({
    ...process.env,
    AI_VIDEO_NO_BROWSER: '1',
    AI_VIDEO_APP_MODE: '1',
    REVIEW_ASSET_PORT: UI_PORT,
    N8N_PORT,
    N8N_HOST: `http://127.0.0.1:${N8N_PORT}`,
    PROJECT_ROOT,
    AI_VIDEO_FFMPEG_PATH: FFMPEG_EXE,
    // Full per-user env — mirrors assemble ENV_BLOCK so the Electron entry and the
    // cmd-mode entry resolve identical config/data/log paths under %APPDATA%.
    AI_VIDEO_HOME: layout.home,
    AI_VIDEO_CONFIG_DIR: layout.configDir,
    AI_VIDEO_CONFIG_PATH: layout.configPath,
    AI_VIDEO_LOG_DIR: layout.logDir,
    AI_VIDEO_RUNTIME_ROOT: layout.runtimeRoot,
    WORKFLOW_DATA_ROOT: layout.workflowDataRoot,
    N8N_USER_FOLDER: layout.n8nUserFolder,
  }, [NODE_BIN_DIR, path.join(PROJECT_ROOT, 'bin')]);

  launcherProcess = spawn(NODE_EXE, [LAUNCHER, '--no-browser'], {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'pipe',
  });

  launcherProcess.stdout.on('data', (d) => process.stdout.write(d));
  launcherProcess.stderr.on('data', (d) => process.stderr.write(d));
  launcherProcess.on('exit', (code) => {
    if (!isQuitting && code && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox(
        'AI Video 本地服务已停止',
        `本地服务意外退出（错误码 ${code}）。\n\n日志目录：\n${logDir()}\n\n可双击 tools\\Export-Diagnostics.cmd 一键导出诊断包。`
      );
    }
  });
}

async function boot() {
  writePidFile(userDataLayout());
  createWindow();
  startLauncher();

  const ok = await waitForUi();
  if (!ok) {
    dialog.showErrorBox(
      'AI Video 启动超时',
      `工作台未能在预期时间内启动。\n\n日志目录：\n${logDir()}\n\n可双击 tools\\Export-Diagnostics.cmd 一键导出诊断包。`
    );
    return;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(UI_URL);
  }
}

app.whenReady().then(boot);

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (launcherProcess && !launcherProcess.killed) {
    launcherProcess.kill('SIGTERM');
  }
  removePidFile(userDataLayout());
});
