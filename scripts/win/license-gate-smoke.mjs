#!/usr/bin/env node
/**
 * P14-C1A — Windows license-gate smoke (real packaged AI Video.exe).
 *
 * Drives the LICENSE GATE end-to-end against the packaged artifact with the gate ENFORCED
 * (AI_VIDEO_LICENSE_REQUIRED=1, NO bypass). Verifies: unlicensed blocks the workbench /
 * config-save / workflow (activation page shown); a valid test license activates and unlocks
 * the workbench; machine-mismatch / expired / tampered / wrong-key licenses are rejected; an
 * API key cannot bypass an invalid license.
 *
 * SECURITY: the Ed25519 TEST keypair is generated IN-MEMORY in this process. The test PRIVATE
 * key is NEVER written to disk, logs, the report, or the artifact — only the test PUBLIC key
 * is handed to the app (AI_VIDEO_LICENSE_PUBLIC_KEY). The REAL production private key is not
 * used and is not present in CI. Reports are redacted; never the activation code / API key /
 * any private key.
 *
 * Usage: node scripts/win/license-gate-smoke.mjs <STAGE_DIR>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const STAGE = process.argv[2] || process.env.AI_VIDEO_STAGE_DIR || '';
const UI_PORT = Number(process.env.AI_VIDEO_UI_PORT || 18788);
const N8N_PORT = Number(process.env.AI_VIDEO_N8N_PORT || 5678);
const APP_ID = 'ai-video-mvp';
const TOTAL_MS = 8 * 60_000; // hard cap — the gate flow makes NO model calls; it's fast.

const OUT_DIR = process.env.AI_VIDEO_SMOKE_OUT || process.cwd();
const DIAG_DIR = path.join(OUT_DIR, 'smoke-diagnostics');
const SHOTS_DIR = path.join(DIAG_DIR, 'screenshots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });
const REPORT_PATH = path.join(OUT_DIR, 'smoke-report.json');
const GATE_REPORT_PATH = path.join(OUT_DIR, 'license-gate-report.json');

// ── In-memory test keypair (private key NEVER leaves this process's memory) ──
const { publicKey: TEST_PUB_OBJ, privateKey: TEST_PRIV } = crypto.generateKeyPairSync('ed25519');
const TEST_PUBLIC_PEM = TEST_PUB_OBJ.export({ type: 'spki', format: 'pem' });
const WRONG_PRIV = crypto.generateKeyPairSync('ed25519').privateKey; // for the wrong-key case

// Enforce the gate for THIS run: required on, bypass OFF, verify against the TEST public key.
process.env.AI_VIDEO_LICENSE_REQUIRED = '1';
delete process.env.AI_VIDEO_LICENSE_BYPASS;
process.env.AI_VIDEO_LICENSE_PUBLIC_KEY = TEST_PUBLIC_PEM;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Redact anything secret-shaped (keys / bearer / PEM bodies / long base64 license codes).
function redactString(s) {
  let t = String(s ?? '');
  t = t.replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[REDACTED_PEM]');
  t = t.replace(/AIV1\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, '[REDACTED_LICENSE_CODE]');
  t = t.replace(/(?:Bearer|Authorization:?)\s*[A-Za-z0-9._-]{8,}/gi, '[REDACTED_AUTH]');
  t = t.replace(/\b(AIza[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{16,})\b/g, '[REDACTED_KEY]');
  return t;
}

const report = {
  scope: 'license_gate',
  stage_dir: STAGE,
  app_started: false,
  window_detected: false,
  failed_stage: null,
  status: null,
  // env
  license_required: null,
  license_bypass: process.env.AI_VIDEO_LICENSE_BYPASS === '1', // expected false
  // unlicensed gate
  unlicensed_activation_page_visible: null,
  unlicensed_workbench_blocked: null,
  unlicensed_new_project_blocked: null,
  unlicensed_submit_product_blocked: null,
  unlicensed_config_save_blocked: null,
  healthz_ok: null,
  license_status_unlicensed_ok: null, // /license/status reachable + ok===false
  machine_id_hash_prefix: null,
  // activation
  test_license_issued: false,
  test_license_activated: false,
  license_status_valid: null,
  activated_workbench_allowed: null,
  license_plan: null,
  license_expires_at: null,
  // reject-invalid
  mismatch_rejected: null,
  expired_rejected: null,
  tampered_rejected: null,
  wrong_key_rejected: null,
  api_key_cannot_bypass_license: null,
  // leak scan
  api_key_leaked: false,
  activation_code_leaked: false,
  private_key_leaked: false,
  license_private_key_in_artifact: false,
  license_error_codes: [],
  screenshot_paths: [],
  errors: [],
};

let appRef = null;
let electronProc = null;
let finalized = false;

// ── HTTP helpers (against the local UI server) ──
function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port: UI_PORT, path: urlPath, method, headers: { ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, timeout: 8000 },
      (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })); },
    );
    req.on('error', () => resolve({ status: -1, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, body: '' }); });
    if (data) req.write(data);
    req.end();
  });
}
const getText = (p) => request('GET', p);
const postForm = (p, obj) => request('POST', p, new URLSearchParams(obj).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
const postJson = (p, obj) => request('POST', p, JSON.stringify(obj), { 'Content-Type': 'application/json' });
async function getJson(p) { const r = await getText(p); try { return JSON.parse(r.body); } catch { return null; } }
// The gate shows renderActivationPage for every protected route when unlicensed.
const isActivationPage = (html) => /<title>激活/.test(html || '') && /name="license_code"/.test(html || '');

// AIV1.<base64url(payload)>.<base64url(sig)> — mirrors the serve verifier.
function issueLicense(payloadObj, privateKey) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url');
  return `AIV1.${payload}.${sig}`;
}

async function screenshot(page, name) {
  try { await page.screenshot({ path: path.join(SHOTS_DIR, name), fullPage: true }); report.screenshot_paths.push(`smoke-diagnostics/screenshots/${name}`); } catch {}
}

function killTree() {
  const pid = electronProc && electronProc.pid;
  try { if (appRef) appRef.close(); } catch {}
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 });
    else { try { process.kill(pid, 'SIGKILL'); } catch {} }
  } catch {}
}

// Scan the report + the uploaded diagnostics dir for any secret material.
function leakScan() {
  const priv = TEST_PRIV.export({ type: 'pkcs8', format: 'pem' });
  const privBody = priv.replace(/-----[^-]*-----/g, '').replace(/\s+/g, '').slice(0, 40);
  const hay = [];
  try { hay.push(JSON.stringify(report)); } catch {}
  try { for (const f of walk(DIAG_DIR)) { try { hay.push(fs.readFileSync(f, 'utf8')); } catch {} } } catch {}
  const blob = hay.join('\n');
  report.private_key_leaked = blob.includes('BEGIN PRIVATE KEY') || (privBody.length > 20 && blob.includes(privBody));
  report.activation_code_leaked = /AIV1\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/.test(blob);
  report.api_key_leaked = /\b(AIza[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{16,})\b/.test(blob) || /Authorization:\s*Bearer\s+\S{8,}/i.test(blob);
  // license.json (the activated record) lives in %APPDATA%, NOT the uploaded artifact.
  report.license_private_key_in_artifact = blob.includes('BEGIN PRIVATE KEY');
}
function* walk(dir) { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } }

function finalize(code) {
  if (finalized) return; finalized = true;
  try { leakScan(); } catch {}
  try { fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); } catch {}
  try { fs.writeFileSync(GATE_REPORT_PATH, JSON.stringify(report, null, 2)); } catch {}
  console.log('[license-gate] report →', REPORT_PATH);
  console.log('[license-gate] summary:', JSON.stringify({
    status: report.status, failed_stage: report.failed_stage,
    unlicensed_blocked: report.unlicensed_workbench_blocked && report.unlicensed_config_save_blocked,
    activated: report.test_license_activated, valid: report.license_status_valid,
    rejects: { mismatch: report.mismatch_rejected, expired: report.expired_rejected, tampered: report.tampered_rejected, wrong_key: report.wrong_key_rejected },
    leaks: { api_key: report.api_key_leaked, activation_code: report.activation_code_leaked, private_key: report.private_key_leaked },
  }));
  try { killTree(); } catch {}
  process.exit(code);
}
function fail(stage, err) { report.status = 'failed'; report.failed_stage = stage; if (err) report.errors.push(redactString(String(err.message || err)).slice(0, 200)); finalize(1); }

async function waitServerUp(deadline) {
  while (Date.now() < deadline) {
    const r = await getText('/healthz');
    if (r.status === 200) return true;
    await sleep(3000);
  }
  return false;
}

async function main() {
  const watchdog = setTimeout(() => { report.error_message = `license-gate smoke exceeded ${TOTAL_MS}ms`; fail('overall_timeout', new Error(report.error_message)); }, TOTAL_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  const exe = path.join(STAGE, 'AI Video.exe');
  if (!fs.existsSync(exe)) return fail('app_binary_missing', new Error(`AI Video.exe not found at ${exe}`));

  let electron;
  try { ({ _electron: electron } = await import('playwright')); } catch (e) { return fail('playwright_unavailable', e); }
  try { appRef = await electron.launch({ executablePath: exe, args: [], timeout: 60_000 }); report.app_started = true; electronProc = appRef.process(); }
  catch (e) { return fail('app_launch_failed', e); }

  let page = null;
  try { page = await appRef.firstWindow({ timeout: 60_000 }); report.window_detected = Boolean(page); } catch {}

  if (!(await waitServerUp(Date.now() + 4 * 60_000))) return fail('ui_server_not_up', new Error('UI server /healthz never reached 200'));
  report.healthz_ok = true;

  // ── 1) UNLICENSED gate ──
  const st0 = await getJson('/license/status');
  report.license_required = Boolean(st0 && st0.required);
  report.license_status_unlicensed_ok = Boolean(st0 && st0.required === true && st0.ok === false);
  const deviceId = st0 && st0.device_id ? String(st0.device_id) : '';
  report.machine_id_hash_prefix = deviceId ? deviceId.slice(0, 8) : null;
  if (!report.license_required) return fail('gate_not_enforced', new Error('AI_VIDEO_LICENSE_REQUIRED did not enforce the gate'));

  const homeUn = await getText('/');
  report.unlicensed_activation_page_visible = isActivationPage(homeUn.body);
  report.unlicensed_workbench_blocked = isActivationPage(homeUn.body);
  report.unlicensed_new_project_blocked = isActivationPage((await getText('/new-project')).body);
  report.unlicensed_submit_product_blocked = isActivationPage((await postForm('/submit-product', { product_name: 'x' })).body);
  const cfgResp = await postJson('/config-save', { providers: { kie: { api_key: 'sk-NOTREAL-should-not-save' } } });
  report.unlicensed_config_save_blocked = isActivationPage(cfgResp.body) || (cfgResp.status >= 300 && cfgResp.status < 400);
  if (page) await screenshot(page, '01-activation-page.png');

  // ── 2) REJECT invalid licenses (still unlicensed) ──
  const tryActivate = async (code) => { const r = await postForm('/activate', { license_code: code }); const after = await getJson('/license/status'); return { rejected: !(after && after.ok === true), body: r.body }; };
  const mism = await tryActivate(issueLicense({ app_id: APP_ID, device_id: 'WRONG-DEVICE-ID', expires_at: '2099-01-01' }, TEST_PRIV));
  report.mismatch_rejected = mism.rejected; if (mism.body && /不匹配|无效|失败|过期/.test(mism.body)) report.license_error_codes.push('mismatch');
  const expd = await tryActivate(issueLicense({ app_id: APP_ID, device_id: deviceId, expires_at: '2020-01-01' }, TEST_PRIV));
  report.expired_rejected = expd.rejected; if (expd.rejected) report.license_error_codes.push('expired');
  const goodForTamper = issueLicense({ app_id: APP_ID, device_id: deviceId, expires_at: '2099-01-01' }, TEST_PRIV);
  const tamp = await tryActivate(goodForTamper.slice(0, -6) + 'AAAAAA');
  report.tampered_rejected = tamp.rejected; if (tamp.rejected) report.license_error_codes.push('tampered');
  const wrong = await tryActivate(issueLicense({ app_id: APP_ID, device_id: deviceId, expires_at: '2099-01-01' }, WRONG_PRIV));
  report.wrong_key_rejected = wrong.rejected; if (wrong.rejected) report.license_error_codes.push('wrong_key');
  // an attempted API-key save while unlicensed must NOT have unlocked anything.
  const stillUn = await getJson('/license/status');
  report.api_key_cannot_bypass_license = Boolean(stillUn && stillUn.ok === false) && isActivationPage((await getText('/')).body);

  // ── 3) VALID activation ──
  const goodCode = issueLicense({ app_id: APP_ID, device_id: deviceId, plan: 'pro', license_id: 'C1A-TEST', expires_at: '2099-01-01' }, TEST_PRIV);
  report.test_license_issued = true;
  const act = await postForm('/activate', { license_code: goodCode });
  const stOk = await getJson('/license/status');
  report.license_status_valid = Boolean(stOk && stOk.ok === true);
  report.test_license_activated = report.license_status_valid;
  report.license_plan = stOk && stOk.plan ? String(stOk.plan).slice(0, 24) : null;
  report.license_expires_at = stOk && stOk.expires_at ? String(stOk.expires_at).slice(0, 32) : null;
  const homeOk = await getText('/');
  report.activated_workbench_allowed = !isActivationPage(homeOk.body) && (homeOk.status === 200);
  if (page) { try { await page.goto(`http://127.0.0.1:${UI_PORT}/`, { waitUntil: 'domcontentloaded' }).catch(() => {}); } catch {} await screenshot(page, '02-activated-workbench.png'); }

  // ── verdict ──
  const ok = report.license_required === true
    && report.unlicensed_workbench_blocked === true && report.unlicensed_new_project_blocked === true
    && report.unlicensed_submit_product_blocked === true && report.unlicensed_config_save_blocked === true
    && report.healthz_ok === true && report.license_status_unlicensed_ok === true
    && report.mismatch_rejected === true && report.expired_rejected === true
    && report.tampered_rejected === true && report.wrong_key_rejected === true
    && report.api_key_cannot_bypass_license === true
    && report.test_license_activated === true && report.license_status_valid === true && report.activated_workbench_allowed === true;
  // a leak makes the run fail regardless.
  leakScan();
  const leaked = report.api_key_leaked || report.activation_code_leaked || report.private_key_leaked || report.license_private_key_in_artifact;
  if (ok && !leaked) { report.status = 'passed'; report.failed_stage = null; return finalize(0); }
  if (leaked) return fail('secret_leak_detected', new Error('a secret was found in the report/artifact'));
  report.status = 'failed';
  report.failed_stage = report.unlicensed_workbench_blocked !== true ? 'unlicensed_gate_not_blocking'
    : report.test_license_activated !== true ? 'valid_license_not_activated'
    : (report.mismatch_rejected && report.expired_rejected && report.tampered_rejected && report.wrong_key_rejected) ? 'activated_workbench_not_allowed'
    : 'invalid_license_not_rejected';
  return finalize(1);
}

main().catch((e) => { try { fail('fatal', e); } catch { try { fs.writeFileSync(REPORT_PATH, JSON.stringify({ ...report, status: 'failed', failed_stage: 'fatal' }, null, 2)); } catch {} process.exit(1); } });
