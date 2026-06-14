#!/usr/bin/env node
/**
 * P14-C1B — Windows new-machine restart / persistence smoke (real packaged AI Video.exe).
 *
 * On a clean Windows runner, with the license gate ENFORCED (AI_VIDEO_LICENSE_REQUIRED=1, NO
 * bypass): verify first-launch + n8n /healthz; the unlicensed gate blocks the workbench /
 * config-save / workflow; invalid licenses (mismatch / expired / tampered / wrong-key) are
 * rejected; a valid TEST license activates and unlocks the workbench; then STOP the app,
 * RELAUNCH it, and confirm the license PERSISTS (still valid, workbench + config-save allowed,
 * NO re-activation needed).
 *
 * SECURITY: the Ed25519 TEST keypair is generated IN-MEMORY ONCE and reused across both
 * launches (so the persisted license re-verifies on restart). The test PRIVATE key NEVER
 * touches disk/logs/report/artifact; only the test PUBLIC key is handed to the app. The REAL
 * production private key is not used and is not present in CI. NO model / image / video / final
 * merge / export. Reports redacted; never the activation code / API key / any private key.
 *
 * Usage: node scripts/win/new-machine-restart-smoke.mjs <STAGE_DIR>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const STAGE = process.argv[2] || process.env.AI_VIDEO_STAGE_DIR || '';
const UI_PORT = Number(process.env.AI_VIDEO_UI_PORT || 18788);
const APP_ID = 'ai-video-mvp';
const TOTAL_MS = 12 * 60_000; // two cold launches (n8n bootstrap each), NO model calls.

const OUT_DIR = process.env.AI_VIDEO_SMOKE_OUT || process.cwd();
const DIAG_DIR = path.join(OUT_DIR, 'smoke-diagnostics');
const SHOTS_DIR = path.join(DIAG_DIR, 'screenshots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });
const REPORT_PATH = path.join(OUT_DIR, 'smoke-report.json');
const GATE_REPORT_PATH = path.join(OUT_DIR, 'new-machine-restart-report.json');

// userSupportDir mirror — where the serve writes license.json (%APPDATA%\AI Video on win32).
function userSupportDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'), 'AI Video');
  return path.join(os.homedir(), 'Library', 'Application Support', 'AI Video');
}
const LICENSE_FILE = path.join(userSupportDir(), 'license.json');

// ── In-memory test keypair (ONCE; reused across restart). Private key never on disk. ──
const { publicKey: TEST_PUB_OBJ, privateKey: TEST_PRIV } = crypto.generateKeyPairSync('ed25519');
const TEST_PUBLIC_PEM = TEST_PUB_OBJ.export({ type: 'spki', format: 'pem' });
const WRONG_PRIV = crypto.generateKeyPairSync('ed25519').privateKey;

// Enforce the gate for BOTH launches: required on, bypass OFF, verify with the TEST public key.
process.env.AI_VIDEO_LICENSE_REQUIRED = '1';
delete process.env.AI_VIDEO_LICENSE_BYPASS;
process.env.AI_VIDEO_LICENSE_PUBLIC_KEY = TEST_PUBLIC_PEM;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function redactString(s) {
  let t = String(s ?? '');
  t = t.replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[REDACTED_PEM]');
  t = t.replace(/AIV1\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, '[REDACTED_LICENSE_CODE]');
  t = t.replace(/(?:Bearer|Authorization:?)\s*[A-Za-z0-9._-]{8,}/gi, '[REDACTED_AUTH]');
  t = t.replace(/\b(AIza[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{16,})\b/g, '[REDACTED_KEY]');
  return t;
}

const report = {
  scope: 'new_machine_restart',
  stage_dir: STAGE,
  clean_runner: null,
  app_started_first_launch: false,
  window_detected: false,
  healthz_ok: false,
  // unlicensed gate
  activation_page_visible: null,
  unlicensed_workbench_blocked: null,
  unlicensed_config_save_blocked: null,
  unlicensed_submit_product_blocked: null,
  license_status_unlicensed_ok: null,
  machine_id_hash_prefix: null,
  // reject-invalid
  mismatch_rejected: null,
  expired_rejected: null,
  tampered_rejected: null,
  wrong_key_rejected: null,
  api_key_cannot_bypass_license: null,
  // activation
  test_license_issued: false,
  test_license_activated: false,
  license_file_exists: null,
  license_status_valid_before_restart: null,
  workbench_allowed_before_restart: null,
  // restart persistence
  app_stopped: false,
  app_restarted: false,
  license_status_valid_after_restart: null,
  workbench_allowed_after_restart: null,
  config_save_allowed_after_restart: null,
  license_present: null,
  license_valid: null,
  // generation MUST stay off
  model_called: false,
  final_merge_called: false,
  export_called: false,
  // leak scan
  api_key_leaked: false,
  activation_code_leaked: false,
  private_key_leaked: false,
  screenshot_paths: [],
  license_error_codes: [],
  failed_stage: null,
  status: null,
  errors: [],
};

let appRef = null;
let curProc = null;
let finalized = false;

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: UI_PORT, path: urlPath, method, headers: { ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, timeout: 8000 },
      (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') })); });
    req.on('error', () => resolve({ status: -1, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: -1, body: '' }); });
    if (data) req.write(data); req.end();
  });
}
const getText = (p) => request('GET', p);
const postForm = (p, o) => request('POST', p, new URLSearchParams(o).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
const postJson = (p, o) => request('POST', p, JSON.stringify(o), { 'Content-Type': 'application/json' });
async function getJson(p) { const r = await getText(p); try { return JSON.parse(r.body); } catch { return null; } }
const isActivationPage = (h) => /<title>激活/.test(h || '') && /name="license_code"/.test(h || '');
function issueLicense(o, k) { const p = Buffer.from(JSON.stringify(o)).toString('base64url'); const sig = crypto.sign(null, Buffer.from(p), k).toString('base64url'); return `AIV1.${p}.${sig}`; }
async function screenshot(page, name) { try { if (page) { await page.screenshot({ path: path.join(SHOTS_DIR, name), fullPage: true }); report.screenshot_paths.push(`smoke-diagnostics/screenshots/${name}`); } } catch {} }

function killTreeOf(proc) {
  const pid = proc && proc.pid; if (!pid) return;
  try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 }); else { try { process.kill(pid, 'SIGKILL'); } catch {} } } catch {}
}

async function launchApp() {
  const { _electron } = await import('playwright');
  const exe = path.join(STAGE, 'AI Video.exe');
  const app = await _electron.launch({ executablePath: exe, args: [], timeout: 60_000 });
  const proc = app.process();
  let page = null; try { page = await app.firstWindow({ timeout: 60_000 }); } catch {}
  return { app, proc, page };
}
async function stopApp(app, proc) {
  try { await app.close(); } catch {}
  killTreeOf(proc);
  const deadline = Date.now() + 60_000; // wait for the port to free
  while (Date.now() < deadline) { const r = await getText('/healthz'); if (r.status !== 200) return true; await sleep(2000); }
  return false;
}
async function waitServerUp(deadline) { while (Date.now() < deadline) { const r = await getText('/healthz'); if (r.status === 200) return true; await sleep(3000); } return false; }

function* walk(dir) { let e = []; try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const x of e) { const p = path.join(dir, x.name); if (x.isDirectory()) yield* walk(p); else yield p; } }
function leakScan() {
  const privBody = TEST_PRIV.export({ type: 'pkcs8', format: 'pem' }).replace(/-----[^-]*-----/g, '').replace(/\s+/g, '').slice(0, 40);
  const hay = [];
  try { hay.push(JSON.stringify(report)); } catch {}
  try { for (const f of walk(DIAG_DIR)) { try { hay.push(fs.readFileSync(f, 'utf8')); } catch {} } } catch {}
  const blob = hay.join('\n');
  report.private_key_leaked = blob.includes('BEGIN PRIVATE KEY') || (privBody.length > 20 && blob.includes(privBody));
  report.activation_code_leaked = /AIV1\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/.test(blob);
  report.api_key_leaked = /\b(AIza[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{16,})\b/.test(blob) || /Authorization:\s*Bearer\s+\S{8,}/i.test(blob);
}

function finalize(code) {
  if (finalized) return; finalized = true;
  try { leakScan(); } catch {}
  try { fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); } catch {}
  try { fs.writeFileSync(GATE_REPORT_PATH, JSON.stringify(report, null, 2)); } catch {}
  console.log('[new-machine-restart] report →', REPORT_PATH);
  console.log('[new-machine-restart] summary:', JSON.stringify({
    status: report.status, failed_stage: report.failed_stage,
    unlicensed_blocked: report.unlicensed_workbench_blocked && report.unlicensed_config_save_blocked,
    activated: report.test_license_activated, before: report.license_status_valid_before_restart,
    after_restart: report.license_status_valid_after_restart, workbench_after: report.workbench_allowed_after_restart,
    rejects: { mismatch: report.mismatch_rejected, expired: report.expired_rejected, tampered: report.tampered_rejected, wrong_key: report.wrong_key_rejected },
    leaks: { api_key: report.api_key_leaked, activation_code: report.activation_code_leaked, private_key: report.private_key_leaked },
  }));
  try { killTreeOf(curProc); } catch {}
  process.exit(code);
}
function fail(stage, err) { report.status = 'failed'; report.failed_stage = stage; if (err) report.errors.push(redactString(String(err.message || err)).slice(0, 200)); finalize(1); }

async function main() {
  const watchdog = setTimeout(() => fail('overall_timeout', new Error(`exceeded ${TOTAL_MS}ms`)), TOTAL_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  if (!fs.existsSync(path.join(STAGE, 'AI Video.exe'))) return fail('app_binary_missing', new Error('AI Video.exe not found'));
  // clean state: a fresh runner has no prior license.
  report.clean_runner = !fs.existsSync(LICENSE_FILE);

  // ── Launch #1 ──
  let l1; try { l1 = await launchApp(); } catch (e) { return fail('app_launch_failed', e); }
  appRef = l1.app; curProc = l1.proc; report.app_started_first_launch = true; report.window_detected = Boolean(l1.page);
  if (!(await waitServerUp(Date.now() + 4 * 60_000))) return fail('ui_server_not_up', new Error('first launch /healthz never 200'));
  report.healthz_ok = true;

  // ── Unlicensed gate ──
  const st0 = await getJson('/license/status');
  report.license_status_unlicensed_ok = Boolean(st0 && st0.required === true && st0.ok === false);
  const deviceId = st0 && st0.device_id ? String(st0.device_id) : '';
  report.machine_id_hash_prefix = deviceId ? deviceId.slice(0, 8) : null;
  if (!(st0 && st0.required === true)) return fail('gate_not_enforced', new Error('REQUIRED=1 did not enforce'));
  const homeUn = await getText('/');
  report.activation_page_visible = isActivationPage(homeUn.body);
  report.unlicensed_workbench_blocked = isActivationPage(homeUn.body);
  report.unlicensed_new_project_blocked = isActivationPage((await getText('/new-project')).body);
  report.unlicensed_submit_product_blocked = isActivationPage((await postForm('/submit-product', { product_name: 'x' })).body);
  report.unlicensed_config_save_blocked = isActivationPage((await postJson('/config-save', { providers: { kie: { api_key: 'sk-NOTREAL' } } })).body);
  await screenshot(l1.page, '01-activation-page.png');

  // ── Reject invalid (while unlicensed) ──
  const tryAct = async (code) => { await postForm('/activate', { license_code: code }); const a = await getJson('/license/status'); return !(a && a.ok === true); };
  report.mismatch_rejected = await tryAct(issueLicense({ app_id: APP_ID, device_id: 'WRONG-DEVICE-ID', expires_at: '2099-01-01' }, TEST_PRIV));
  report.expired_rejected = await tryAct(issueLicense({ app_id: APP_ID, device_id: deviceId, expires_at: '2020-01-01' }, TEST_PRIV));
  const good = issueLicense({ app_id: APP_ID, device_id: deviceId, plan: 'pro', expires_at: '2099-01-01' }, TEST_PRIV);
  report.tampered_rejected = await tryAct(good.slice(0, -6) + 'AAAAAA');
  report.wrong_key_rejected = await tryAct(issueLicense({ app_id: APP_ID, device_id: deviceId, expires_at: '2099-01-01' }, WRONG_PRIV));
  report.api_key_cannot_bypass_license = Boolean((await getJson('/license/status'))?.ok === false) && isActivationPage((await getText('/')).body);

  // ── Activate (valid) ──
  report.test_license_issued = true;
  await postForm('/activate', { license_code: good });
  const stB = await getJson('/license/status');
  report.test_license_activated = Boolean(stB && stB.ok === true);
  report.license_status_valid_before_restart = report.test_license_activated;
  report.license_file_exists = fs.existsSync(LICENSE_FILE);
  report.workbench_allowed_before_restart = !isActivationPage((await getText('/')).body);
  await screenshot(l1.page, '02-activated-before-restart.png');
  if (!report.test_license_activated) return fail('valid_license_not_activated', new Error('activation failed'));

  // ── Stop the app ──
  report.app_stopped = await stopApp(l1.app, l1.proc);
  appRef = null; curProc = null;
  if (!report.app_stopped) return fail('app_did_not_stop', new Error('app/port did not free after stop'));
  await sleep(3000);

  // ── Relaunch #2 (SAME env + SAME test public key; NO re-activation) ──
  let l2; try { l2 = await launchApp(); } catch (e) { return fail('app_relaunch_failed', e); }
  appRef = l2.app; curProc = l2.proc; report.app_restarted = true;
  if (!(await waitServerUp(Date.now() + 4 * 60_000))) return fail('relaunch_server_not_up', new Error('relaunch /healthz never 200'));

  const stA = await getJson('/license/status');
  report.license_status_valid_after_restart = Boolean(stA && stA.ok === true);
  report.license_present = fs.existsSync(LICENSE_FILE);
  report.license_valid = report.license_status_valid_after_restart;
  report.workbench_allowed_after_restart = !isActivationPage((await getText('/')).body);
  // config-save is now allowed (no longer gated) — a benign (non-real-key) POST is processed.
  const cfgA = await postJson('/config-save', { providers: { kie: {} } });
  report.config_save_allowed_after_restart = !isActivationPage(cfgA.body);
  await screenshot(l2.page, '03-after-restart-workbench.png');

  // ── verdict ──
  leakScan();
  const leaked = report.api_key_leaked || report.activation_code_leaked || report.private_key_leaked;
  const ok = report.clean_runner === true && report.app_started_first_launch && report.healthz_ok
    && report.unlicensed_workbench_blocked === true && report.unlicensed_config_save_blocked === true && report.unlicensed_submit_product_blocked === true
    && report.license_status_unlicensed_ok === true
    && report.mismatch_rejected === true && report.expired_rejected === true && report.tampered_rejected === true && report.wrong_key_rejected === true
    && report.api_key_cannot_bypass_license === true
    && report.test_license_activated === true && report.license_file_exists === true && report.workbench_allowed_before_restart === true
    && report.app_stopped === true && report.app_restarted === true
    && report.license_status_valid_after_restart === true && report.workbench_allowed_after_restart === true && report.config_save_allowed_after_restart === true;
  if (ok && !leaked) { report.status = 'passed'; report.failed_stage = null; return finalize(0); }
  if (leaked) return fail('secret_leak_detected', new Error('secret found in report/artifact'));
  report.status = 'failed';
  report.failed_stage = report.unlicensed_workbench_blocked !== true ? 'unlicensed_gate_not_blocking'
    : report.test_license_activated !== true ? 'valid_license_not_activated'
    : report.license_status_valid_after_restart !== true ? 'license_did_not_persist_after_restart'
    : report.workbench_allowed_after_restart !== true ? 'workbench_blocked_after_restart'
    : 'invalid_license_not_rejected';
  return finalize(1);
}

main().catch((e) => { try { fail('fatal', e); } catch { try { fs.writeFileSync(REPORT_PATH, JSON.stringify({ ...report, status: 'failed', failed_stage: 'fatal' }, null, 2)); } catch {} process.exit(1); } });
