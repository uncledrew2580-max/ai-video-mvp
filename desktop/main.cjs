const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const UI_PORT = process.env.AI_VIDEO_UI_PORT || '18788';
const N8N_PORT = process.env.AI_VIDEO_N8N_PORT || '5678';
const UI_URL = `http://127.0.0.1:${UI_PORT}/`;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(PROJECT_ROOT, 'client', 'launcher.mjs');

let mainWindow;
let launcherProcess;
let isQuitting = false;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

function commonNodePath() {
  return [
    process.env.PATH || '',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(process.env.HOME || '', '.npm-global', 'bin'),
  ].filter(Boolean).join(':');
}

function findNode() {
  const bundledNode = path.join(PROJECT_ROOT, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  try {
    if (bundledNode && require('node:fs').existsSync(bundledNode)) return bundledNode;
  } catch {}

  const env = { ...process.env, PATH: commonNodePath() };
  try {
    const found = execFileSync('/usr/bin/env', ['which', 'node'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return found || null;
  } catch {
    return null;
  }
}

function httpOk(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForUi(timeoutMs = 70000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpOk(UI_URL)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function returnToWorkbench(options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  const forceHome = Boolean(options.forceHome);
  const currentUrl = mainWindow.webContents.getURL();
  const isLocalPage = currentUrl.startsWith(`http://127.0.0.1:${UI_PORT}`) || currentUrl.startsWith(`http://localhost:${UI_PORT}`);
  const isStartupPage = !currentUrl || currentUrl.startsWith('data:');
  if (forceHome || isStartupPage || !isLocalPage) {
    mainWindow.loadURL(UI_URL);
  }
}

function injectWorkbenchButton() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const currentUrl = mainWindow.webContents.getURL();
  if (!currentUrl.startsWith('http://')) return;

  mainWindow.webContents.executeJavaScript(`
    (() => {
      const id = 'ai-video-return-workbench';
      const existing = document.getElementById(id);
      if (existing) existing.remove();
      const btn = document.createElement('button');
      btn.id = id;
      btn.type = 'button';
      btn.textContent = '回到工作台';
      btn.setAttribute('aria-label', '回到 AI Video 工作台');
      Object.assign(btn.style, {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        zIndex: '2147483647',
        padding: '12px 18px',
        border: '1px solid rgba(37, 99, 235, .35)',
        borderRadius: '999px',
        background: 'linear-gradient(135deg, #2563eb, #06b6d4)',
        color: '#ffffff',
        fontSize: '15px',
        fontWeight: '800',
        letterSpacing: '0',
        boxShadow: '0 18px 42px rgba(37, 99, 235, .30)',
        cursor: 'pointer',
        userSelect: 'none'
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.filter = 'brightness(1.06)';
        btn.style.transform = 'translateY(-1px)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.filter = 'none';
        btn.style.transform = 'none';
      });
      btn.addEventListener('click', () => {
        window.location.href = ${JSON.stringify(UI_URL)};
      });
      document.documentElement.appendChild(btn);
    })();
  `).catch(() => {});
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

  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${UI_PORT}`) || url.startsWith(`http://localhost:${UI_PORT}`)) {
      mainWindow.loadURL(url);
      return { action: 'deny' };
    }
    if (url.startsWith(`http://127.0.0.1:${N8N_PORT}`) || url.startsWith(`http://localhost:${N8N_PORT}`)) {
      mainWindow.loadURL(url);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (
      url.startsWith('data:') ||
      url.startsWith(`http://127.0.0.1:${UI_PORT}`) ||
      url.startsWith(`http://localhost:${UI_PORT}`) ||
      url.startsWith(`http://127.0.0.1:${N8N_PORT}`) ||
      url.startsWith(`http://localhost:${N8N_PORT}`)
    ) {
      return;
    }
    event.preventDefault();
    shell.openExternal(url);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    injectWorkbenchButton();
  });

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <title>AI Video</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            height: 100vh;
            display: grid;
            place-items: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: #0f172a;
            background:
              radial-gradient(circle at 18% 16%, rgba(59,130,246,.20), transparent 32%),
              radial-gradient(circle at 82% 20%, rgba(14,165,233,.16), transparent 30%),
              linear-gradient(135deg, #f8fbff 0%, #eaf2fb 100%);
          }
          .card {
            width: min(560px, calc(100vw - 48px));
            padding: 34px 36px;
            border: 1px solid rgba(148, 163, 184, .28);
            border-radius: 18px;
            background: rgba(255,255,255,.78);
            box-shadow: 0 26px 80px rgba(15,23,42,.12);
            backdrop-filter: blur(18px);
          }
          h1 { margin: 0 0 12px; font-size: 32px; letter-spacing: 0; }
          p { margin: 0; color: #475569; font-size: 16px; line-height: 1.75; }
          .bar {
            margin-top: 26px;
            height: 8px;
            overflow: hidden;
            border-radius: 999px;
            background: #dbeafe;
          }
          .bar::before {
            content: "";
            display: block;
            height: 100%;
            width: 42%;
            border-radius: inherit;
            background: linear-gradient(90deg, #2563eb, #06b6d4);
            animation: move 1.15s ease-in-out infinite alternate;
          }
          @keyframes move { from { transform: translateX(-20%); } to { transform: translateX(160%); } }
        </style>
      </head>
      <body>
        <section class="card">
          <h1>AI Video 正在启动</h1>
          <p>正在自动启动本地 n8n 引擎和视频工作台。第一次启动可能需要稍等一会儿。</p>
          <div class="bar"></div>
        </section>
      </body>
    </html>
  `)}`);
}

function startLauncher() {
  const nodeBin = findNode();
  if (!nodeBin) {
    dialog.showErrorBox(
      'AI Video 缺少运行环境',
      '当前 Mac 没有找到 Node.js。请先安装 Node.js 18+，后续正式版会把这一步做成一键安装。',
    );
    return;
  }

  launcherProcess = spawn(nodeBin, [LAUNCHER, '--no-browser'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PATH: commonNodePath(),
      AI_VIDEO_NO_BROWSER: '1',
      AI_VIDEO_APP_MODE: '1',
      REVIEW_ASSET_PORT: UI_PORT,
      N8N_PORT,
      N8N_HOST: `http://127.0.0.1:${N8N_PORT}`,
      PROJECT_ROOT,
    },
    stdio: 'pipe',
  });

  launcherProcess.stdout.on('data', (chunk) => {
    console.log(chunk.toString());
  });
  launcherProcess.stderr.on('data', (chunk) => {
    console.error(chunk.toString());
  });
  launcherProcess.on('exit', (code) => {
    if (code && mainWindow && !mainWindow.isDestroyed()) {
      const logDir = path.join(app.getPath('appData'), 'AI Video', 'logs', 'launcher');
      dialog.showErrorBox('AI Video 启动失败', `本地服务启动失败，错误码：${code}\n请查看日志目录：\n${logDir}`);
    }
  });
}

async function boot() {
  createWindow();
  startLauncher();

  const ok = await waitForUi();
  if (!ok) {
    const logDir = path.join(app.getPath('appData'), 'AI Video', 'logs', 'launcher');
    dialog.showErrorBox('AI Video 启动超时', `工作台没有在预期时间内启动。\n请查看日志目录：\n${logDir}`);
    return;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(UI_URL);
  }
}

app.whenReady().then(boot);

app.on('second-instance', () => {
  returnToWorkbench();
});

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    returnToWorkbench();
  } else {
    boot();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (launcherProcess && !launcherProcess.killed) {
    launcherProcess.kill('SIGTERM');
  }
});
