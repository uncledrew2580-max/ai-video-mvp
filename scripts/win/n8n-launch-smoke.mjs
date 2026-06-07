#!/usr/bin/env node
// P14-B1: launch n8n from the portable STAGING tree using the bundled node.exe and
// confirm it starts and serves /healthz, then shut it down cleanly. This catches an
// incomplete n8n runtime (missing dist module) in CI before the artifact is shipped.
//
// No real workflows imported, no model calls, no paid APIs. Uses a throwaway
// N8N_USER_FOLDER + encryption key + a free port. Cross-platform (resolves
// node.exe on Windows, node on dev). Prints n8n.log tail on failure.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'dist-win', 'AI-Video-Win-x64-Portable-RC-0001');

function resolveNode() {
  for (const c of [path.join(STAGE, 'runtime', 'bin', 'node.exe'), path.join(STAGE, 'runtime', 'bin', 'node')]) {
    if (fs.existsSync(c)) return c;
  }
  return process.execPath; // dev fallback
}
const N8N_BIN = path.join(STAGE, 'node_modules', 'n8n', 'bin', 'n8n');

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
function get(url, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, (r) => { r.resume(); resolve(r.statusCode || 0); });
    req.setTimeout(timeout, () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(N8N_BIN)) { console.error(`[n8n-smoke] FAIL: missing ${N8N_BIN}`); process.exit(1); }
  const nodeBin = resolveNode();
  const userFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-smoke-'));
  const logPath = path.join(userFolder, 'n8n.log');
  const logFd = fs.openSync(logPath, 'a');
  const port = await freePort();
  const brokerPort = await freePort(); // task-runner broker — pick a free one to avoid collisions
  const env = {
    ...process.env,
    N8N_USER_FOLDER: userFolder,
    N8N_ENCRYPTION_KEY: 'p14b1smoke0000000000000000000000',
    N8N_PORT: String(port),
    N8N_RUNNERS_BROKER_PORT: String(brokerPort),
    N8N_HOST: '127.0.0.1',
    N8N_LISTEN_ADDRESS: '127.0.0.1',
    N8N_PROTOCOL: 'http',
    N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
    N8N_PERSONALIZATION_SURVEY_ENABLED: 'false',
    N8N_DISABLE_UI: 'true',
    DB_TYPE: 'sqlite',
    NODE_FUNCTION_ALLOW_BUILTIN: '*',
  };
  console.log(`[n8n-smoke] starting n8n on 127.0.0.1:${port} (node: ${path.basename(nodeBin)})`);
  const child = spawn(nodeBin, [N8N_BIN, 'start'], { env, stdio: ['ignore', logFd, logFd] });

  let exitedCode = null;
  child.on('exit', (code) => { exitedCode = code; });

  const healthUrl = `http://127.0.0.1:${port}/healthz`;
  const deadline = Date.now() + 120000; // up to 2 min for first boot
  let healthy = false;
  while (Date.now() < deadline) {
    if (exitedCode !== null && exitedCode !== 0) break; // crashed
    const code = await get(healthUrl);
    if (code === 200) { healthy = true; break; }
    await sleep(2000);
  }

  // keep it alive a few seconds to confirm it doesn't crash right after boot
  if (healthy) { await sleep(5000); if (exitedCode !== null && exitedCode !== 0) healthy = false; }

  // shut down cleanly
  try { child.kill('SIGTERM'); } catch {}
  await sleep(2000);
  try { child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(logFd); } catch {}

  if (!healthy) {
    console.error(`[n8n-smoke] FAIL: n8n did not become healthy (exitCode=${exitedCode}).`);
    try {
      const tail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-60).join('\n');
      console.error('---- n8n.log (tail) ----\n' + tail);
    } catch {}
    // n8n masks the start.js load error as "Command start not found". Run the
    // first-error diagnostic with the bundled node.exe from the staging tree to
    // surface the REAL stack (zod/config/module resolution, requireStack, etc.).
    try {
      const diagScript = path.join(STAGE, 'scripts', 'win', 'diagnose-start-command.mjs');
      const diagToRun = fs.existsSync(diagScript) ? diagScript : fileURLToPath(import.meta.url).replace('n8n-launch-smoke.mjs', 'diagnose-start-command.mjs');
      console.error('---- start-command first-error diagnostic ----');
      const r = spawnSync(nodeBin, [diagToRun, STAGE], {
        encoding: 'utf8',
        timeout: 120000,
        env: { ...process.env, N8N_USER_FOLDER: fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-diag-')), N8N_ENCRYPTION_KEY: 'p14diag00000000000000000000000000' },
      });
      if (r.stdout) console.error(r.stdout);
      if (r.stderr) console.error(r.stderr);
    } catch (e) { console.error('[n8n-smoke] diagnostic failed to run:', e.message); }
    process.exit(1);
  }
  console.log('[n8n-smoke] PASS: n8n started and served /healthz from the portable tree.');
  try { fs.rmSync(userFolder, { recursive: true, force: true }); } catch {}
}
main().catch((e) => { console.error('[n8n-smoke] error:', e.message); process.exit(1); });
