#!/usr/bin/env node
// P14-B6: Windows real smoke — image generation only.
// Validates image-only scope, starts n8n from portable tree (if present),
// checks API key reachability, then submits ONE image generation task and stops.
// Veo / video / final-merge are BLOCKED by smoke-guard.mjs.
// Writes smoke-report.json + smoke-diagnostics/ as uploadable artifacts.
//
// Security: AI_VIDEO_API_KEY is read from env (GitHub Secret), never logged.
// The Authorization header value never appears in console output or report JSON.

import {
  assertImageOnlyScope,
  guardFinalMerge,
  guardReviewRerunShot,
  guardReviewSubmit,
  guardReviewSubmitVeoV2,
  guardVeo,
  guardVideoGeneration,
  selfTest,
} from './smoke-guard.mjs';

// ── Safety: MUST be the first code executed ───────────────────────────────────
assertImageOnlyScope();
selfTest();

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Expose guard stubs so they are importable; calling them intentionally blocks the op.
export { guardFinalMerge, guardReviewRerunShot, guardReviewSubmit, guardReviewSubmitVeoV2, guardVeo, guardVideoGeneration };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGE_ARG = process.argv[2];
const STAGE = STAGE_ARG
  ? path.resolve(STAGE_ARG)
  : path.join(ROOT, 'dist-win', 'AI-Video-Win-x64-Portable-RC-0001');

const REPORT_PATH = path.join(ROOT, 'smoke-report.json');
const DIAG_DIR = path.join(ROOT, 'smoke-diagnostics');
fs.mkdirSync(DIAG_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveNode() {
  for (const c of [
    path.join(STAGE, 'resources', 'runtime', 'bin', 'node.exe'),
    path.join(STAGE, 'resources', 'runtime', 'bin', 'node'),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return process.execPath;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetStatus(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (r) => { r.resume(); resolve(r.statusCode || 0); });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

// GET with Authorization header — header VALUE is never logged.
function apiGet(url, apiKey, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    };
    const req = mod.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`GET timed out: ${parsed.pathname}`)); });
    req.on('error', reject);
    req.end();
  });
}

// POST JSON with Authorization header — header VALUE is never logged.
function apiPost(url, apiKey, bodyObj, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(bodyObj);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: timeoutMs,
    };
    const req = mod.request(options, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`POST timed out: ${parsed.pathname}`)); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── n8n lifecycle ─────────────────────────────────────────────────────────────

async function startN8n(port, brokerPort, userFolder) {
  const N8N_BIN = path.join(STAGE, 'resources', 'runtime', 'node_modules', 'n8n', 'bin', 'n8n');
  if (!fs.existsSync(N8N_BIN)) {
    console.log('[smoke] Portable tree not found — skipping n8n start (artifact not downloaded)');
    return null;
  }
  const nodeBin = resolveNode();
  const logPath = path.join(DIAG_DIR, 'n8n.log');
  const logFd = fs.openSync(logPath, 'a');
  const env = {
    ...process.env,
    N8N_USER_FOLDER: userFolder,
    N8N_ENCRYPTION_KEY: 'p14b6smoke000000000000000000000000',
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
  console.log(`[smoke] Starting n8n on 127.0.0.1:${port}`);
  const child = spawn(nodeBin, [N8N_BIN, 'start'], { env, stdio: ['ignore', logFd, logFd] });
  let exitedCode = null;
  child.on('exit', (code) => { exitedCode = code; });

  const healthUrl = `http://127.0.0.1:${port}/healthz`;
  const deadline = Date.now() + 120000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (exitedCode !== null && exitedCode !== 0) break;
    if ((await httpGetStatus(healthUrl)) === 200) { healthy = true; break; }
    await sleep(2000);
  }
  try { fs.closeSync(logFd); } catch {}

  if (!healthy) {
    console.error('[smoke] n8n did not become healthy');
    try {
      const tail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-30).join('\n');
      fs.writeFileSync(path.join(DIAG_DIR, 'n8n-fail-tail.txt'), tail);
    } catch {}
    try { child.kill('SIGTERM'); } catch {}
    return null;
  }
  console.log('[smoke] n8n healthy');
  return { child, logPath };
}

async function stopN8n(handle) {
  if (!handle) return;
  try { handle.child.kill('SIGTERM'); } catch {}
  await sleep(2000);
  try { handle.child.kill('SIGKILL'); } catch {}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const report = {
    scope: 'image_only',
    disable_video_generation: process.env.DISABLE_VIDEO_GENERATION,
    real_smoke_scope: process.env.REAL_SMOKE_SCOPE,
    timestamp: new Date().toISOString(),
    n8n_ok: null,
    api_key_ok: null,
    image_ok: null,
    task_id: null,
    image_url: null,
    video_generation_skipped: true,
    veo_not_called: true,
    final_merge_not_called: true,
    stopped_at: 'image_generation',
    stages: [],
    errors: [],
  };

  const apiKey = (process.env.AI_VIDEO_API_KEY || '').trim();
  if (!apiKey) {
    report.errors.push('AI_VIDEO_API_KEY is not set');
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.error('[smoke] FAIL: AI_VIDEO_API_KEY is required (set via GitHub Secret)');
    process.exit(1);
  }
  console.log('[smoke] AI_VIDEO_API_KEY present (value hidden)');

  const baseUrl = (process.env.AI_VIDEO_BASE_URL || 'https://api.kie.ai/api').replace(/\/+$/, '');
  const imageModel = (process.env.AI_VIDEO_IMAGE_MODEL || 'nano-banana-pro').trim();
  console.log(`[smoke] base_url: ${baseUrl}`);
  console.log(`[smoke] image_model: ${imageModel}`);

  let n8nHandle = null;
  try {
    // Start n8n from portable tree if the artifact was downloaded
    if (fs.existsSync(STAGE)) {
      const port = await freePort();
      const brokerPort = await freePort();
      const userFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-b6-n8n-'));
      n8nHandle = await startN8n(port, brokerPort, userFolder);
      report.n8n_ok = n8nHandle !== null;
      report.stages.push(report.n8n_ok ? 'n8n' : 'n8n_failed');
    } else {
      console.log('[smoke] Portable tree absent — skipping n8n (no artifact downloaded)');
      report.n8n_ok = null;
      report.stages.push('n8n_skipped');
    }

    // API key reachability: GET /v1/jobs/recordInfo with a dummy taskId.
    // Returns 200/400/404 for valid keys; 401/403 for bad keys. No charge.
    console.log('[smoke] Checking API key reachability (no generation)...');
    const pingUrl = `${baseUrl}/v1/jobs/recordInfo?taskId=smoke-b6-ping-${Date.now()}`;
    try {
      const { status, body } = await apiGet(pingUrl, apiKey);
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      // code 401/403 = bad key; any other response = reachable
      if (status === 401 || status === 403 || parsed.code === 401 || parsed.code === 403) {
        report.api_key_ok = false;
        report.errors.push(`API key rejected: HTTP ${status} code=${parsed.code ?? 'n/a'}`);
        console.error(`[smoke] API key check FAIL: HTTP ${status}`);
      } else {
        report.api_key_ok = true;
        console.log(`[smoke] API key check OK: HTTP ${status} code=${parsed.code ?? 'n/a'}`);
      }
    } catch (e) {
      report.api_key_ok = false;
      report.errors.push(`API key check network error: ${e.message}`);
      console.error(`[smoke] API key check error: ${e.message}`);
    }

    report.stages.push('api_key_check');

    if (!report.api_key_ok) {
      report.image_ok = false;
      process.exitCode = 1;
      return;
    }

    // Submit ONE minimal image generation task — 9:16, smoke-test prompt.
    console.log('[smoke] Submitting image generation task...');
    const createUrl = `${baseUrl}/v1/jobs/createTask`;
    const createBody = {
      model: imageModel,
      input: {
        prompt: 'Smoke test image: a white circle on a solid blue background, 9:16 aspect ratio.',
        aspect_ratio: '9:16',
        resolution: '720x1280',
        output_format: 'jpeg',
      },
    };

    let taskId = null;
    try {
      const { status, body } = await apiPost(createUrl, apiKey, createBody);
      fs.writeFileSync(path.join(DIAG_DIR, 'createTask-response.json'), body);
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      if (status !== 200 && status !== 201) {
        report.errors.push(`createTask HTTP ${status}`);
        report.image_ok = false;
        console.error(`[smoke] createTask FAIL: HTTP ${status}`);
      } else {
        taskId = (parsed.data?.taskId || parsed.taskId || '').toString() || null;
        report.task_id = taskId;
        if (!taskId) {
          report.errors.push('createTask returned no taskId');
          report.image_ok = false;
          console.error('[smoke] createTask FAIL: no taskId in response');
        } else {
          console.log(`[smoke] createTask OK: taskId=${taskId}`);
        }
      }
    } catch (e) {
      report.errors.push(`createTask error: ${e.message}`);
      report.image_ok = false;
      console.error(`[smoke] createTask error: ${e.message}`);
    }

    // Poll for result — max 60 × 5 s = 5 min. Stop at first success or failure.
    if (taskId) {
      console.log(`[smoke] Polling for image result (taskId=${taskId}, max 5 min)...`);
      const pollUrl = `${baseUrl}/v1/jobs/recordInfo?taskId=${taskId}`;
      let done = false;
      for (let attempt = 1; attempt <= 60 && !done; attempt++) {
        await sleep(5000);
        try {
          const { status, body } = await apiGet(pollUrl, apiKey);
          let parsed = {};
          try { parsed = JSON.parse(body); } catch {}
          const state = (parsed.data?.state || '').trim();
          console.log(`[smoke] poll ${attempt}/60 state=${state || '?'} HTTP ${status}`);
          if (state === 'success') {
            const rj = parsed.data?.resultJson;
            const urls = typeof rj === 'string'
              ? ((() => { try { return JSON.parse(rj).resultUrls || []; } catch { return []; } })())
              : (rj?.resultUrls || []);
            report.image_ok = urls.length > 0;
            report.image_url = urls[0] ?? null;
            done = true;
            if (report.image_ok) {
              console.log('[smoke] Image generation PASS');
              fs.writeFileSync(
                path.join(DIAG_DIR, 'image-result.json'),
                JSON.stringify({ task_id: taskId, result_urls: urls }, null, 2)
              );
            } else {
              report.errors.push('Image task succeeded but returned no result URLs');
              console.error('[smoke] Image task succeeded but no result URLs');
            }
          } else if (state === 'failed') {
            report.image_ok = false;
            report.errors.push(`Image task state=failed: ${JSON.stringify(parsed.data ?? {})}`);
            console.error('[smoke] Image task FAILED');
            done = true;
          }
        } catch (e) {
          console.log(`[smoke] poll attempt ${attempt} error: ${e.message}`);
        }
      }
      if (!done) {
        report.image_ok = false;
        report.errors.push(`Image task timed out (taskId=${taskId})`);
        console.error('[smoke] Image task TIMED OUT after 60 poll attempts');
      }
      report.stages.push('image_generation');
    }
  } finally {
    report.stages.push('video_skipped');
    await stopN8n(n8nHandle);
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`[smoke] Report → ${REPORT_PATH}`);
    console.log('[smoke] Summary:', JSON.stringify({
      scope: report.scope,
      n8n_ok: report.n8n_ok,
      api_key_ok: report.api_key_ok,
      image_ok: report.image_ok,
      errors: report.errors.length,
    }));
  }

  if (!report.image_ok || report.errors.length > 0) process.exit(1);
  console.log('[smoke] PASS: image-only smoke complete.');
}

main().catch((e) => {
  console.error('[smoke] Fatal:', e.message);
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify({
      scope: 'image_only',
      timestamp: new Date().toISOString(),
      error: e.message,
    }, null, 2));
  } catch {}
  process.exit(1);
});
