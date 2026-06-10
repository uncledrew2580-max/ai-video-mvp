#!/usr/bin/env node
// P14-B8 / B8C: Windows UI-DRIVEN image-only smoke with startup diagnostics.
//
// Drives the REAL AI Video.exe Electron window via Playwright — it does NOT write
// config files directly or call backend HTTP endpoints to stand in for the user.
//
// MODES (UI_SMOKE_MODE):
//   diagnostic (default) — launch → detect window → (if the workbench loads) save
//       the API Key in the UI, verify 已配置, read output dir, read WF presence.
//       It STOPS there and NEVER submits the brief, so NO model/image generation
//       happens. Used by CI to validate the startup + fast-fail + diagnostics path.
//   full — the complete image-only pipeline (submit brief → select concept → wait
//       for script → confirm script → storyboard/Nano image on the review page),
//       stopping before any video. Only for an explicitly authorized real run.
//
// Fast-fail (B8C): the run never hangs to the GitHub job timeout. App launch is
// capped (<=60s), the workbench-ready wait is capped (<=90s), and a hard overall
// watchdog (<=9min) forces a failure report + child-process cleanup + exit.
//
// On success OR failure a smoke-report.json is ALWAYS written, plus redacted
// diagnostics (window URL/title/state, blank/splash screenshots, log tails,
// process + port summaries). Veo / video / final-merge are blocked and the API
// Key is never logged, never written to the report, never copied into diagnostics.

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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { redactObject, redactString } from '../../app-server/shared/redact.mjs';
import { runSqlite } from '../../lib/sqlite-exec.mjs';
import { n8nDbReadinessReport } from './n8n-db-ready.mjs';

const _require = createRequire(import.meta.url);

// Expose guard stubs so they are importable; calling them intentionally blocks the op.
export { guardFinalMerge, guardReviewRerunShot, guardReviewSubmit, guardReviewSubmitVeoV2, guardVeo, guardVideoGeneration };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGE_ARG = process.argv[2];
const STAGE = STAGE_ARG
  ? path.resolve(STAGE_ARG)
  : path.join(ROOT, 'dist-win', 'AI-Video-Win-x64-Portable-RC-0001');

const MODE = (process.env.UI_SMOKE_MODE || 'diagnostic').trim().toLowerCase();
const FULL = MODE === 'full';

// ── Fast-fail budgets (B8C) ───────────────────────────────────────────────────
const APP_LAUNCH_MS = 60_000;   // <=60s to spawn the Electron app
const WORKBENCH_MS = 90_000;    // <=90s for the workbench to load (else fast fail)
const TOTAL_MS = 9 * 60_000;    // <=9min hard cap for the whole smoke

const UI_PORT = Number(process.env.AI_VIDEO_UI_PORT || 18788);
const N8N_PORT = Number(process.env.AI_VIDEO_N8N_PORT || 5678);

// Output base: repo root by default (CI uploads from there); tests redirect to a
// temp dir via AI_VIDEO_SMOKE_OUT so they never write into the working tree.
const OUT_DIR = process.env.AI_VIDEO_SMOKE_OUT ? path.resolve(process.env.AI_VIDEO_SMOKE_OUT) : ROOT;
const REPORT_PATH = path.join(OUT_DIR, 'smoke-report.json');
const DIAG_DIR = path.join(OUT_DIR, 'smoke-diagnostics');
const SHOTS_DIR = path.join(DIAG_DIR, 'screenshots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

// Renderer requests that would start video must never fire in an image-only run.
const FORBIDDEN_REQUEST = [
  /review-submit/i,
  /review-rerun-shot/i,
  /reviewSubmitVeoV2/i,
  /\/v1\/veo/i,
  /veo\/generate/i,
  /image[_-]?to[_-]?video/i,
  /final-merge/i,
  /mergeWithAudio/i,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Shared run state (the watchdog and the main path both finalize through it) ──
const requestLog = [];
const electronOut = { buf: '', cap: 128 * 1024 };
let appRef = null;
let electronProc = null;
let finalized = false;

const report = {
  scope: 'image_only',
  ui_driven: true,
  mode: MODE,
  real_smoke_scope: process.env.REAL_SMOKE_SCOPE,
  disable_video_generation: process.env.DISABLE_VIDEO_GENERATION,
  timestamp: new Date().toISOString(),
  status: 'failed',                 // 'passed' | 'passed_diagnostic' | 'failed'
  failed_stage: null,
  error_message: null,
  error_stack: null,
  // startup diagnostics
  app_started: false,
  window_detected: false,
  window_title: null,
  window_url: null,
  window_state: 'unknown',          // unknown | blank | splash | loaded
  screenshot_available: false,      // a screenshot was captured
  no_window_reason: null,           // why no workbench window (blank/splash/exit)
  launcher_tail: null,              // redacted tail of AI Video.exe launcher output
  runtime_healthz: null,            // UI server (REVIEW_ASSET_PORT) probe
  n8n_healthz: null,                // n8n /healthz probe
  // B8G: launcher-side workflow sync failure diagnostics (if the workbench never
  // started because workflow sync aborted).
  workflow_sync_failed: false,
  sync_stage: null,
  workflow_ids_checked: [],
  sqlite_foreign_key_check: null,
  // B8K: n8n migration-readiness diagnostics (bootstrap ran before the schema was
  // complete — e.g. "no such table: workflow_published_version").
  n8n_migration_readiness_failed: false,
  db_readiness: null, // { healthz_ready, db_file_exists, schema_ready, missing_tables, migration_log_state, waited_ms }
  // config / presence milestones (best-effort, no generation)
  api_key_provided: false,
  api_key_input_selector_matched: false, // the Kie API Key input was located
  api_key_input_filled: false,          // the key was actually typed into the input
  save_button_selector_matched: false,  // the 保存配置 button was located
  save_button_visible: null,
  save_button_enabled: null,
  save_button_click_attempted: false,
  save_handler_present: null,           // a real save handler is bound (marker/window/data-bound-save)
  handler_detection_method: null,       // which signal proved it: marker | data-bound-save | window.saveConfig | none
  config_save_post_seen: false,         // a POST /config-save request was observed
  config_save_post_status: null,        // its HTTP status (or null)
  renderer_requests: [],                // origin+pathname of requests seen (no secrets)
  renderer_console_errors: [],          // redacted pageerror/console.error messages
  script_assets_loaded: [],             // external <script src> on the config page (diagnostic)
  config_save_script_present: null,     // the config page HTML references the save handler/button
  packaged_renderer_asset_check: null,  // { save_button, data_testid, handler_marker_or_window } booleans
  visible_buttons: [],                  // button labels on the config page (diagnostic)
  api_key_saved_via_ui: false,          // UI /config-save returned 2xx
  configured_reported_by_ui: false,     // KEY-specific UI status (badge/effective), NOT route tags
  api_key_loaded_from_config: false,    // local-config.json actually holds a key (masked)
  api_key_effective_for_runtime: false, // server /health/meta reports kie_api_key_configured
  config_save_mismatch: false,          // UI says configured but the config is not saved
  config_path: null,
  redacted_config_summary: null,        // { key_present, key_masked, base_url_present, effective_route_present }
  visible_config_status_texts: [],      // the on-page key/effective status texts (no secrets)
  brief_form_found: false,              // the /new-project intake form was located
  output_dir: null,
  output_dir_confirmed: false,
  workflow_presence: { WF01: false, WF02: false, WF02a: false, WF02b: false, WF03: false },
  workflow_presence_all: false,
  // B8V: product-image UI upload + n8n/WF01 binary presence diagnostics
  product_image_upload_attempted: false,
  product_image_input_matched: false,
  product_image_file_path: null,        // repo fixture path (not a secret)
  product_image_attached_to_brief: false, // locator.files actually has the file
  brief_submit_request_seen: false,
  brief_submit_status: null,
  n8n_binary_present: null,             // n8n binaryData dir exists with >=1 file
  wf01_binary_present: null,            // latest WF01 execution carries product-image binary/paths
  wf01_binary_keys: [],                 // binary key NAMES only (no data)
  wf01_product_image_count: null,
  wf01_product_image_local_paths_exist: [], // booleans only (no paths/base64)
  n8n_binary_storage_summary: null,     // { dir_exists, file_count } only
  binary_restore_error: null,           // redacted n8n "restore binary" error if any
  // full-mode pipeline milestones
  brief_submitted_via_ui: false,
  concept_ready_via_ui: false,
  concept_selected_via_ui: false,
  script_generated_via_ui: false,
  script_confirmed_via_ui: false,
  storyboard_image_generated_via_ui: false,
  image_ok: null,
  image_url: null,
  // stop-proof — we never reach video in either mode
  video_generation_skipped: true,
  veo_not_called: true,
  final_merge_not_called: true,
  stopped_at: FULL ? 'storyboard_ready_for_review' : 'diagnostic_no_generation',
  api_key_leaked: false,
  forbidden_requests_blocked: [],
  stages: [],
  errors: [],
};

// ── User-data paths (for redacted diagnostics only — never written by the smoke) ──
function userSupportDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AI Video');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AI Video');
  }
  return path.join(os.homedir(), '.ai-video');
}

// Minimal dependency-free PNG encoder — the "product image" upload (full mode only).
function makeSolidPng(w, h, [r, g, b]) {
  function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── HTTP healthz probe (no app needed) ────────────────────────────────────────
function httpProbe(urlStr, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const req = http.get(urlStr, { timeout: timeoutMs }, (res) => { res.resume(); resolve(`HTTP ${res.statusCode}`); });
      req.on('error', () => resolve('no_response'));
      req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    } catch { resolve('no_response'); }
  });
}

// GET JSON (for /health/meta). Returns parsed object or null. Never logs bodies.
function httpGetJson(urlStr, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const req = http.get(urlStr, { timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

// Mask a secret to a short, non-reversible hint (sk-****abcd). NEVER the full key.
function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

// Read-only summary of the effective config — PRESENCE + masked hint only. The
// full API key / plaintext local-config is never read into the report or uploaded.
function configSummary() {
  const config_path = path.join(userSupportDir(), 'config', 'local-config.json');
  try {
    if (!fs.existsSync(config_path)) {
      return { config_path, exists: false, key_present: false, key_masked: '', base_url_present: false, effective_route_present: false };
    }
    const cfg = JSON.parse(fs.readFileSync(config_path, 'utf8'));
    const key = String(cfg?.providers?.kie?.api_key || cfg?.kie?.api_key || '').trim();
    const base = String(cfg?.providers?.kie?.base_url || cfg?.kie?.base_url || '').trim();
    const route = Boolean(cfg?.tasks?.storyboard_image?.model || cfg?.tasks?.creative_direction?.model || cfg?.providers?.kie);
    return {
      config_path,
      exists: true,
      key_present: key.length > 0,
      key_masked: key ? maskKey(key) : '',
      base_url_present: base.length > 0,
      effective_route_present: route,
    };
  } catch (e) {
    return { config_path, exists: true, key_present: false, key_masked: '', base_url_present: false, effective_route_present: false, read_error: String(e.message || e) };
  }
}

// Read the KEY-SPECIFIC config status from the rendered page — distinguishing the
// Kie API Key badge / effective-config key from the "当前接口路由" route tags (which
// are always 已配置 regardless of whether the key was saved — the B8L false positive).
async function readConfigStatus(page) {
  try {
    return await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      // The "Kie API Key" heading is immediately followed by its status badge.
      let keyBadge = '';
      const h3 = Array.from(document.querySelectorAll('h3')).find((h) => /Kie API Key/.test(h.textContent || ''));
      if (h3 && h3.nextElementSibling) keyBadge = norm(h3.nextElementSibling.textContent);
      // The "当前实际生效配置" section labels an "API Key" value (未填写 / a masked key).
      let effectiveKeyText = '';
      const apiKeyLabels = Array.from(document.querySelectorAll('*')).filter(
        (el) => el.children.length === 0 && norm(el.textContent) === 'API Key',
      );
      for (const lbl of apiKeyLabels) {
        const sib = lbl.nextElementSibling;
        if (sib) { const t = norm(sib.textContent); if (t) { effectiveKeyText = t; break; } }
      }
      const out = document.getElementById('output-base-display');
      const output_dir = out ? norm(out.textContent) : null;
      // key_configured ONLY when the key-specific signals say so — NOT route tags.
      const badgeOk = /已配置/.test(keyBadge) && !/未填写/.test(keyBadge);
      const effOk = effectiveKeyText !== '' && !/未填写/.test(effectiveKeyText);
      return {
        key_configured: badgeOk || effOk,
        key_badge: keyBadge,
        effective_key_text: effectiveKeyText,
        texts: [keyBadge, effectiveKeyText].filter(Boolean),
        output_dir,
      };
    });
  } catch (e) {
    return { key_configured: false, key_badge: '', effective_key_text: '', texts: [], output_dir: null, error: String(e.message || e) };
  }
}

// B8V: read-only n8n / WF01 product-image binary diagnostics. Summarizes ONLY
// key names, counts, booleans and redacted errors — never image base64, paths, or
// secrets. Best-effort: any failure leaves fields null and never throws upward.
function collectWf01BinaryDiagnostics(report) {
  const dataRoot = path.join(userSupportDir(), 'workflow-data', '.n8n');
  const dbPath = path.join(dataRoot, 'database.sqlite');

  // 1) n8n binary storage dir summary (existence + count only).
  let dirExists = false; let fileCount = 0;
  try {
    const binDir = path.join(dataRoot, 'binaryData');
    if (fs.existsSync(binDir)) {
      dirExists = true;
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else fileCount++; } };
      walk(binDir);
    }
  } catch {}
  report.n8n_binary_storage_summary = { dir_exists: dirExists, file_count: fileCount };
  report.n8n_binary_present = dirExists && fileCount > 0;

  if (!fs.existsSync(dbPath)) {
    report.wf01_binary_present = false;
    report.binary_restore_error = report.binary_restore_error || 'wf01_execution_db_not_found';
    return;
  }

  // 2) latest WF01 (concept) execution data — WF01 id, else most recent execution.
  let dataStr = null;
  try {
    const wf01Id = 'rKHHjD2QBlL6EhaM';
    let raw = runSqlite(['-json', dbPath,
      `SELECT ed.data AS data FROM execution_data ed JOIN execution_entity ee ON ee.id = ed."executionId" WHERE ee."workflowId"='${wf01Id}' ORDER BY ee.id DESC LIMIT 1;`,
    ], { encoding: 'utf8' });
    let rows = raw ? JSON.parse(raw) : [];
    if (!rows.length) {
      raw = runSqlite(['-json', dbPath, 'SELECT data FROM execution_data ORDER BY "executionId" DESC LIMIT 1;'], { encoding: 'utf8' });
      rows = raw ? JSON.parse(raw) : [];
    }
    dataStr = rows.length ? String(rows[0].data || '') : null;
  } catch (e) { report.binary_restore_error = report.binary_restore_error || redactString(String(e.message || e)).slice(0, 200); }

  if (!dataStr) { report.wf01_binary_present = false; return; }

  // 3) parse (flatted if available) then scan for product-image binary key NAMES,
  //    the image count, and local-path EXISTENCE booleans — never the values.
  let text = dataStr;
  try { const flatted = _require('flatted'); text = JSON.stringify(flatted.parse(dataStr)); } catch {}
  report.wf01_binary_keys = [...new Set((text.match(/"(product_images_\d+|image_\d+|data\d+)"/g) || []).map((m) => m.replace(/"/g, '')))].slice(0, 20);
  const cm = text.match(/"product_image_count"\s*:\s*"?(\d+)"?/) || text.match(/"image_count"\s*:\s*"?(\d+)"?/);
  report.wf01_product_image_count = cm ? Number(cm[1]) : null;
  const exists = [];
  for (const m of [...text.matchAll(/"(?:image_\d+_path|product_image_local_path[s]?)"\s*:\s*"([^"]+)"/g)].slice(0, 8)) {
    try { exists.push(fs.existsSync(m[1])); } catch { exists.push(false); }
  }
  report.wf01_product_image_local_paths_exist = exists;
  const errM = text.match(/(Failed to restore binary data[^"\\]*|No such file[^"\\]*)/i);
  if (errM && !report.binary_restore_error) report.binary_restore_error = redactString(errM[1]).slice(0, 200);
  report.wf01_binary_present = report.wf01_binary_keys.length > 0 || (report.wf01_product_image_count || 0) > 0 || exists.some(Boolean);
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
async function screenshot(page, name) {
  try { await page.screenshot({ path: path.join(SHOTS_DIR, name), fullPage: true }); } catch {}
}

// Snapshot the current page (url/title/visible buttons+inputs/short DOM text) so a
// missing form is debuggable without secrets. Writes to smoke-diagnostics.
async function captureDomSummary(page, name) {
  let summary = { url: null, title: null, buttons: [], inputs: [], headings: [] };
  try {
    summary.url = page.url();
    summary.title = await page.title().catch(() => null);
    summary = await page.evaluate((base) => {
      const txt = (el) => (el.innerText || el.textContent || '').trim().slice(0, 60);
      const out = { ...base };
      out.buttons = Array.from(document.querySelectorAll('button, a.btn, [role="button"]')).map(txt).filter(Boolean).slice(0, 25);
      out.inputs = Array.from(document.querySelectorAll('input, textarea, select')).map((el) => ({
        tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '', id: el.id || '',
      })).slice(0, 30);
      out.headings = Array.from(document.querySelectorAll('h1, h2, .form-section-title, .premium-label')).map(txt).filter(Boolean).slice(0, 20);
      return out;
    }, { url: summary.url, title: summary.title }).catch(() => summary);
  } catch {}
  try { fs.writeFileSync(path.join(DIAG_DIR, name), JSON.stringify(summary, null, 2)); } catch {}
  return summary;
}

// Resilient locator: first selector that resolves to a present element, else null.
async function firstLocator(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) return loc;
    } catch {}
  }
  return null;
}

// Capture every window's url/title/visibility — and the main window state.
async function captureWindowDiagnostics(app) {
  const windows = [];
  let main = null;
  try {
    const wins = app.windows();
    for (const w of wins) {
      let url = ''; let title = ''; let visible = null; let closed = null;
      try { url = w.url(); } catch {}
      try { title = await w.title(); } catch {}
      try { closed = w.isClosed(); } catch {}
      try { visible = await w.evaluate(() => document.visibilityState !== 'hidden').catch(() => null); } catch {}
      windows.push({ url, title, isVisible: visible, isClosed: closed });
    }
    main = windows[0] || null;
  } catch {}
  try {
    fs.writeFileSync(path.join(DIAG_DIR, 'window-diagnostics.json'), JSON.stringify({ count: windows.length, windows }, null, 2));
  } catch {}
  if (main) {
    report.window_detected = true;
    report.window_url = main.url || null;
    report.window_title = main.title || null;
    const u = String(main.url || '');
    report.window_state = /^https?:\/\/127\.0\.0\.1:\d+/.test(u) ? 'loaded'
      : u.startsWith('data:') ? 'splash'
      : (u === '' || u === 'about:blank') ? 'blank'
      : 'unknown';
  }
  return main;
}

function runCmd(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return `(${cmd} unavailable: ${e.code || e.message})`; }
}

// Logs / process / port diagnostics — no live app required, all redacted.
function exportEnvDiagnostics() {
  // 1. Redacted config snapshot — NEVER copy the raw local-config.json.
  try {
    const cfgPath = path.join(userSupportDir(), 'config', 'local-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      fs.writeFileSync(path.join(DIAG_DIR, 'local-config.redacted.json'), JSON.stringify(redactObject(parsed), null, 2));
    }
  } catch (e) { report.errors.push(`diag config: ${e.message}`); }

  // 2. %APPDATA%/AI Video/logs — launcher.log / n8n.log / ui-*.log tails, redacted.
  try {
    const base = userSupportDir();
    const summary = [];
    for (const sub of ['logs', path.join('logs', 'launcher')]) {
      const dir = path.join(base, sub);
      if (!fs.existsSync(dir)) continue;
      const outDir = path.join(DIAG_DIR, 'logs');
      fs.mkdirSync(outDir, { recursive: true });
      for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f);
        let st; try { st = fs.statSync(full); } catch { continue; }
        if (!st.isFile() || !/\.log$/i.test(f)) continue;
        summary.push(`${path.join(sub, f)} (${st.size} bytes)`);
        const raw = fs.readFileSync(full, 'utf8');
        const tail = raw.split('\n').slice(-200).join('\n');
        fs.writeFileSync(path.join(outDir, f.replace(/[\\/]/g, '_')), redactString(tail));
      }
    }
    fs.writeFileSync(path.join(DIAG_DIR, 'appdata-logs-summary.txt'), summary.join('\n') || '(no logs found)');
  } catch (e) { report.errors.push(`diag logs: ${e.message}`); }

  // 3. Electron app stdout/stderr captured live (launcher + n8n console), redacted.
  try {
    if (electronOut.buf) {
      fs.writeFileSync(path.join(DIAG_DIR, 'electron-stdout.log'), redactString(electronOut.buf.slice(-electronOut.cap)));
    }
  } catch (e) { report.errors.push(`diag electron stdout: ${e.message}`); }

  // 4. Process list + port-listen summary, redacted.
  try {
    let procList; let ports;
    if (process.platform === 'win32') {
      procList = runCmd('tasklist', ['/FO', 'CSV', '/NH']);
      ports = runCmd('netstat', ['-ano', '-p', 'TCP']);
    } else {
      procList = runCmd('ps', ['-A', '-o', 'pid,comm']);
      ports = runCmd('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n']);
    }
    const procFiltered = String(procList).split('\n').filter((l) => /node|electron|AI Video|ffmpeg|n8n/i.test(l)).slice(0, 80).join('\n');
    const portFiltered = String(ports).split('\n').filter((l) => /LISTEN/i.test(l)).slice(0, 80).join('\n');
    fs.writeFileSync(path.join(DIAG_DIR, 'process-list.txt'), redactString(procFiltered || '(none matched)'));
    fs.writeFileSync(path.join(DIAG_DIR, 'ports-listening.txt'), redactString(portFiltered || '(none)'));
  } catch (e) { report.errors.push(`diag procs/ports: ${e.message}`); }

  // 5. Renderer request audit — origin + pathname only (no query, no headers).
  try {
    fs.writeFileSync(path.join(DIAG_DIR, 'renderer-requests.txt'), [...new Set(requestLog)].sort().join('\n'));
  } catch (e) { report.errors.push(`diag requests: ${e.message}`); }
}

// Force-kill the Electron app process tree (never hangs on app.close()).
function killAppTree() {
  const pid = electronProc && electronProc.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 });
    else { try { process.kill(pid, 'SIGKILL'); } catch {} }
  } catch {}
}

// Self-check: the raw API key must never appear in the report or captured diag.
function assertNoKeyLeak(apiKey) {
  if (!apiKey) { report.api_key_leaked = false; return; }
  let leaked = false;
  try { if (JSON.stringify(report).includes(apiKey)) leaked = true; } catch {}
  try { if (electronOut.buf.includes(apiKey)) leaked = true; } catch {}
  report.api_key_leaked = leaked;
}

// Write report + env diagnostics + cleanup, then exit. Idempotent; never hangs.
function finalize(exitCode, apiKey) {
  if (finalized) return;
  finalized = true;
  // Stop-proof invariant (P14-B8C): video / Veo / final-merge are ALWAYS reported
  // as not-called / skipped — even when a forbidden attempt was observed, because
  // the renderer interceptor ABORTS it (nothing actually executes). The attempt
  // itself is recorded in forbidden_requests_blocked and fails the run separately.
  report.video_generation_skipped = true;
  report.veo_not_called = true;
  report.final_merge_not_called = true;
  report.stages.push('video_skipped');
  try { exportEnvDiagnostics(); } catch {}
  assertNoKeyLeak(apiKey);
  try { fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); } catch {}
  try {
    console.log(`[ui-smoke] Report → ${REPORT_PATH}`);
    console.log('[ui-smoke] Summary:', JSON.stringify({
      mode: report.mode, status: report.status, failed_stage: report.failed_stage,
      app_started: report.app_started, window_detected: report.window_detected, window_state: report.window_state,
      runtime_healthz: report.runtime_healthz, n8n_healthz: report.n8n_healthz,
      api_key_saved_via_ui: report.api_key_saved_via_ui, configured_reported_by_ui: report.configured_reported_by_ui,
      workflow_presence_all: report.workflow_presence_all,
      storyboard_image_generated_via_ui: report.storyboard_image_generated_via_ui,
      forbidden_blocked: report.forbidden_requests_blocked.length, errors: report.errors.length,
      api_key_leaked: report.api_key_leaked,
    }));
  } catch {}
  killAppTree();
  process.exit(exitCode);
}

function fail(stage, err, apiKey) {
  report.status = 'failed';
  report.failed_stage = report.failed_stage || stage;
  report.error_message = report.error_message || (err && err.message) || String(err || stage);
  report.error_stack = report.error_stack || (err && err.stack) || null;
  console.error(`[ui-smoke] FAIL @ ${report.failed_stage}: ${report.error_message}`);
  finalize(1, apiKey);
}

// Wait for the workbench, fast. Returns the loaded page or null (fast fail).
async function waitForWorkbench(app, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const page = await app.firstWindow({ timeout: 5000 });
      const url = page.url();
      if (/^https?:\/\/127\.0\.0\.1:\d+/.test(url)) {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        return page;
      }
    } catch {}
    await sleep(2000);
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[ui-smoke] mode=${MODE} stage=${STAGE}`);

  const apiKey = (process.env.AI_VIDEO_API_KEY || '').trim();
  report.api_key_provided = Boolean(apiKey);
  if (apiKey) console.log('[ui-smoke] AI_VIDEO_API_KEY present (value hidden)');
  else console.log('[ui-smoke] AI_VIDEO_API_KEY not provided');
  if (FULL && !apiKey) { fail('api_key_missing', new Error('AI_VIDEO_API_KEY is required for full mode'), apiKey); return; }

  // Hard overall watchdog — never hang to the GitHub job timeout.
  const watchdog = setTimeout(() => {
    report.error_message = report.error_message || `UI smoke exceeded hard cap ${TOTAL_MS}ms`;
    fail('overall_timeout', new Error(report.error_message), apiKey);
  }, TOTAL_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  const exe = path.join(STAGE, 'AI Video.exe');
  if (!fs.existsSync(exe)) {
    fail('app_binary_missing', new Error(`AI Video.exe not found at ${exe}`), apiKey);
    return;
  }

  let electron;
  try { ({ _electron: electron } = await import('playwright')); }
  catch (e) { fail('playwright_unavailable', e, apiKey); return; }

  // ── Launch (fast, <=60s) ────────────────────────────────────────────────────
  try {
    appRef = await electron.launch({ executablePath: exe, args: [], timeout: APP_LAUNCH_MS });
    report.app_started = true;
    report.stages.push('app_started');
    try {
      electronProc = appRef.process();
      const grab = (s) => { if (!s) return; s.on('data', (d) => { electronOut.buf += d.toString(); if (electronOut.buf.length > electronOut.cap * 2) electronOut.buf = electronOut.buf.slice(-electronOut.cap); }); };
      grab(electronProc && electronProc.stdout); grab(electronProc && electronProc.stderr);
    } catch {}
  } catch (e) {
    fail('app_launch', e, apiKey);
    return;
  }

  // Renderer-level guard: inspect every request the window makes.
  try {
    await appRef.context().route('**/*', async (route) => {
      const url = route.request().url();
      if (FORBIDDEN_REQUEST.some((rx) => rx.test(url))) {
        const clean = url.replace(/[?#].*$/, '');
        report.forbidden_requests_blocked.push(clean);
        console.error(`[ui-smoke] BLOCKED forbidden request: ${clean}`);
        try { await route.abort(); } catch {}
        return;
      }
      try { await route.continue(); } catch {}
    });
    appRef.context().on('request', (req) => { try { const u = new URL(req.url()); requestLog.push(u.origin + u.pathname); } catch {} });
  } catch {}

  // ── Wait for the workbench (fast, <=90s) ────────────────────────────────────
  // Hard race (B8E): a hung app.firstWindow() must never run to the overall
  // watchdog — the wait resolves within ~WORKBENCH_MS even if Playwright blocks
  // internally, so a no-window app fails near the window timeout, not the 9-min cap.
  const page = await Promise.race([
    waitForWorkbench(appRef, WORKBENCH_MS),
    sleep(WORKBENCH_MS + 5000).then(() => null),
  ]);
  // Always probe health + capture window diagnostics (whether or not it loaded).
  report.runtime_healthz = await httpProbe(`http://127.0.0.1:${UI_PORT}/`);
  report.n8n_healthz = await httpProbe(`http://127.0.0.1:${N8N_PORT}/healthz`);
  // Race the window-diagnostics capture too — w.title()/w.evaluate() on an
  // unresponsive window can hang, and must not run to the overall watchdog.
  const mainWin = await Promise.race([
    captureWindowDiagnostics(appRef),
    sleep(15000).then(() => null),
  ]);

  if (!page || !/^https?:\/\/127\.0\.0\.1:\d+/.test(page.url())) {
    // No-window / blank-splash diagnostics (B8E): record why, capture a screenshot
    // of any window that exists, and the launcher state tail (redacted).
    report.no_window_reason = !report.window_detected
      ? ((electronProc && electronProc.exitCode != null)
          ? `AI Video.exe process exited (code ${electronProc.exitCode}) — no window created`
          : 'AI Video.exe created no window within the window timeout')
      : `window stuck at state=${report.window_state} (runtime=${report.runtime_healthz}, n8n=${report.n8n_healthz})`;
    try { report.launcher_tail = redactString(electronOut.buf.split('\n').filter(Boolean).slice(-8).join('\n')); } catch {}

    // Classify WHY the workbench never started. Order matters: a missing table /
    // readiness timeout is a SCHEMA readiness problem (B8K), NOT a sync FK problem.
    const dbPath = path.join(userSupportDir(), 'workflow-data', '.n8n', 'database.sqlite');
    const n8nLogPath = path.join(userSupportDir(), 'logs', 'launcher', 'n8n.log');
    // Prefer the launcher's own structured [db-readiness] line; else recompute.
    const parsedReadiness = (() => {
      const m = electronOut.buf.match(/\[db-readiness\]\s*(\{[^\n]*\})/);
      if (m) { try { return JSON.parse(m[1]); } catch {} }
      return null;
    })();
    try {
      report.db_readiness = parsedReadiness || {
        healthz_ready: /n8n 就绪/.test(electronOut.buf) || report.n8n_healthz === 'HTTP 200',
        ...n8nDbReadinessReport(dbPath, { logPath: n8nLogPath }),
      };
    } catch (e) { report.db_readiness = { error: e.message }; }

    if (/no such table|n8n 数据库初始化未完成|database schema is not ready/i.test(electronOut.buf)) {
      // B8K: bootstrap ran before the schema was complete (e.g. workflow_published_version).
      report.n8n_migration_readiness_failed = true;
      report.failed_stage = 'n8n_migration_readiness';
      const m = electronOut.buf.match(/no such table:\s*([A-Za-z0-9_]+)/i);
      if (m && report.db_readiness && typeof report.db_readiness === 'object') report.db_readiness.error_missing_table = m[1];
    } else if (/工作流(版本)?同步失败|FOREIGN KEY/i.test(electronOut.buf)) {
      // B8G: schema WAS ready but the workflow version SYNC failed (e.g. an FK error).
      report.workflow_sync_failed = true;
      report.failed_stage = 'workflow_sync';
      report.sync_stage = 'workflow_sync';
      report.workflow_ids_checked = ['rKHHjD2QBlL6EhaM', 'conceptSelectStoryboardV1', 'scriptGenerateV1', 'storyboardGenerateV1', 'reviewSubmitVeoV2'];
      try {
        if (fs.existsSync(dbPath)) {
          const raw = runSqlite(['-json', dbPath, 'PRAGMA foreign_key_check;'], { encoding: 'utf8' });
          report.sqlite_foreign_key_check = raw ? JSON.parse(raw) : [];
        } else {
          report.sqlite_foreign_key_check = 'db_not_found';
        }
      } catch (e) { report.sqlite_foreign_key_check = `check_error: ${e.message}`; }
    }
    if (mainWin) {
      const wins = appRef.windows();
      if (wins[0]) { await screenshot(wins[0], `00-${report.window_state || 'unknown'}.png`); report.screenshot_available = true; }
    }
    report.error_message = `workbench window did not load within ${WORKBENCH_MS}ms ` +
      `(state=${report.window_state}, runtime=${report.runtime_healthz}, n8n=${report.n8n_healthz})`;
    fail('workbench_load_timeout', new Error(report.error_message), apiKey);
    return;
  }

  report.screenshot_available = true; // window loaded; subsequent steps screenshot
  report.window_state = 'loaded';
  report.stages.push('window_loaded');
  page.on('dialog', (d) => { d.accept().catch(() => {}); });
  // B8T: capture renderer JS errors (redacted) so a non-executing page script /
  // ReferenceError is visible in the report.
  const pushConsoleError = (s) => {
    try { const t = redactString(String(s || '')).slice(0, 300); if (t && report.renderer_console_errors.length < 25 && !report.renderer_console_errors.includes(t)) report.renderer_console_errors.push(t); } catch {}
  };
  page.on('pageerror', (err) => pushConsoleError((err && err.message) || err));
  page.on('console', (msg) => { try { if (msg.type() === 'error') pushConsoleError(msg.text()); } catch {} });
  const uiBase = new URL(page.url()).origin;
  await screenshot(page, '01-workbench.png');

  try {
    // ── Config: REALLY save the API Key through the UI, then VERIFY the closure ─
    if (apiKey) {
      await page.goto(`${uiBase}/config`, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      const visibleButtons = async () => page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a.btn')).map((b) => (b.innerText || b.textContent || '').trim()).filter(Boolean).slice(0, 30),
      ).catch(() => []);

      // The Kie API Key input is the password field bound to providers.kie.api_key.
      const keyInput = await firstLocator(page, [
        'input[data-testid="kie-api-key-input"]',
        'input[data-path="providers.kie.api_key"]',
      ]);
      report.api_key_input_selector_matched = Boolean(keyInput);
      if (!keyInput) {
        report.visible_buttons = await visibleButtons();
        await captureDomSummary(page, 'config-dom-summary.json');
        fail('config_input_missing', new Error('Kie API Key input not found on /config'), apiKey);
        return;
      }
      await keyInput.waitFor({ state: 'visible', timeout: 20000 });
      await keyInput.fill(apiKey); // typed into a type=password field; never logged
      // Don't just set the DOM value — fire framework-recognizable events + blur so
      // the value is committed before the save click.
      try {
        await keyInput.dispatchEvent('input');
        await keyInput.dispatchEvent('change');
        await keyInput.press('Tab').catch(() => {});
        await keyInput.evaluate((el) => { if (el && el.blur) el.blur(); }).catch(() => {});
      } catch {}
      report.api_key_input_filled = ((await keyInput.inputValue().catch(() => '')) || '').length > 0;
      if (!report.api_key_input_filled) {
        await captureDomSummary(page, 'config-input-not-filled-dom.json');
        fail('config_input_not_filled', new Error('Kie API Key input value did not update after fill'), apiKey);
        return;
      }

      // Packaged-renderer asset diagnostics: does the served config page reference
      // the save button + a handler at all (rules out a missing/stale asset)?
      try {
        const html = await page.content();
        report.config_save_script_present = /data-testid="save-config-button"/.test(html) && /saveConfig|config-save/.test(html);
        report.packaged_renderer_asset_check = {
          save_button: /data-testid="save-config-button"|id="save-btn"/.test(html),
          data_testid: /data-testid="save-config-button"/.test(html) && /data-testid="kie-api-key-input"/.test(html),
          handler_marker_or_window: /AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND|window\.saveConfig/.test(html),
        };
      } catch (e) { report.packaged_renderer_asset_check = { error: String(e.message || e) }; }
      report.script_assets_loaded = await page.evaluate(() =>
        Array.from(document.scripts).map((s) => s.src).filter(Boolean).slice(0, 20),
      ).catch(() => []);

      // The desktop-shell injection (B8T) binds the handler on did-finish-load, which
      // is async — wait briefly for its marker before judging handler presence.
      await page.waitForFunction(
        () => window.AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND === true
          || (document.body && document.body.dataset && document.body.dataset.configSaveHandlerBound === 'true')
          || !!document.querySelector('[data-bound-save="1"]')
          || typeof window.saveConfig === 'function',
        { timeout: 6000 },
      ).catch(() => {});

      // Locate the 保存配置 button and confirm it is actually clickable.
      const saveBtn = await firstLocator(page, ['button[data-testid="save-config-button"]', '#save-btn', 'button:has-text("保存配置")']);
      report.save_button_selector_matched = Boolean(saveBtn);
      // The handler is "present" when ANY real binding is detectable: the desktop-shell
      // marker (window or body dataset), the data-bound-save attribute, or window.saveConfig.
      const det = await page.evaluate(() => {
        const out = { marker_window: false, marker_body: false, data_bound_save: false, window_saveconfig: false, button_onclick: null, button_testid: null };
        out.marker_window = window.AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND === true;
        out.marker_body = !!(document.body && document.body.dataset && document.body.dataset.configSaveHandlerBound === 'true');
        out.data_bound_save = !!document.querySelector('[data-testid="save-config-button"][data-bound-save="1"], #save-btn[data-bound-save="1"]');
        out.window_saveconfig = typeof window.saveConfig === 'function';
        const sb = document.querySelector('[data-testid="save-config-button"]') || document.getElementById('save-btn');
        if (sb) { out.button_onclick = sb.getAttribute('onclick'); out.button_testid = sb.getAttribute('data-testid'); }
        return out;
      }).catch(() => null);
      report.save_handler_present = !!(det && (det.marker_window || det.marker_body || det.data_bound_save || det.window_saveconfig));
      report.handler_detection_method = !det ? 'eval_error'
        : (det.marker_window || det.marker_body) ? 'marker'
        : det.data_bound_save ? 'data-bound-save'
        : det.window_saveconfig ? 'window.saveConfig'
        : 'none';
      report._handler_detail = det; // captured into the failure diagnostics below
      if (!saveBtn) {
        report.visible_buttons = await visibleButtons();
        await captureDomSummary(page, 'save-button-missing-dom.json');
        await screenshot(page, '02b-save-button-missing.png');
        fail('config_save_button_missing', new Error('保存配置 button not found on /config'), apiKey);
        return;
      }
      report.save_button_visible = await saveBtn.isVisible().catch(() => null);
      report.save_button_enabled = await saveBtn.isEnabled().catch(() => null);
      if (!report.save_button_visible || !report.save_button_enabled) {
        const state = await saveBtn.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { disabled: el.disabled, ariaDisabled: el.getAttribute('aria-disabled'), className: el.className, text: (el.innerText || '').trim(), rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
        }).catch(() => null);
        report.visible_buttons = await visibleButtons();
        try { fs.writeFileSync(path.join(DIAG_DIR, 'save-button-state.json'), JSON.stringify(state, null, 2)); } catch {}
        await screenshot(page, '02b-save-button-not-actionable.png');
        fail('config_save_button_not_actionable', new Error(`保存配置 button not actionable (visible=${report.save_button_visible}, enabled=${report.save_button_enabled})`), apiKey);
        return;
      }

      // Real click → saveConfig() → POST /config-save. Listen for the REQUEST (to
      // detect whether the action even fires) AND the response (for its status).
      const saveReq = page.waitForRequest((r) => r.url().includes('/config-save') && r.method() === 'POST', { timeout: 12000 });
      const saveResp = page.waitForResponse((r) => r.url().includes('/config-save') && r.request().method() === 'POST', { timeout: 25000 });
      await saveBtn.scrollIntoViewIfNeeded().catch(() => {});
      await saveBtn.click();
      report.save_button_click_attempted = true;
      report.stages.push('config_save_clicked');

      const req = await saveReq.catch(() => null);
      report.config_save_post_seen = Boolean(req);
      if (!req) {
        // The precise B8N/B8S blocker: the click did NOT trigger a /config-save POST.
        report.renderer_requests = [...new Set(requestLog)];
        report.visible_buttons = await visibleButtons();
        const ui0 = await readConfigStatus(page);
        report.visible_config_status_texts = ui0.texts;
        try { fs.writeFileSync(path.join(DIAG_DIR, 'config-save-handler-detail.json'), JSON.stringify({ handler_detection_method: report.handler_detection_method, detail: report._handler_detail, packaged_renderer_asset_check: report.packaged_renderer_asset_check, config_save_script_present: report.config_save_script_present, script_assets_loaded: report.script_assets_loaded, renderer_console_errors: report.renderer_console_errors }, null, 2)); } catch {}
        await captureDomSummary(page, 'config-save-action-not-triggered-dom.json');
        await screenshot(page, '02b-config-save-action-not-triggered.png');
        fail('config_save_action_not_triggered', new Error(
          `保存配置 click did not POST /config-save ` +
          `(save_button_visible=${report.save_button_visible}, save_button_enabled=${report.save_button_enabled}, ` +
          `save_handler_present=${report.save_handler_present}, handler_detection_method=${report.handler_detection_method}, ` +
          `api_key_input_filled=${report.api_key_input_filled})`,
        ), apiKey);
        return;
      }
      const resp = await saveResp.catch(() => null);
      report.config_save_post_status = resp ? resp.status() : null;
      let saveOk = false;
      try { const b = resp ? JSON.parse(await resp.text()) : null; saveOk = Boolean(resp && resp.status() >= 200 && resp.status() < 300 && (!b || b.ok !== false)); } catch { saveOk = Boolean(resp && resp.status() >= 200 && resp.status() < 300); }
      report.api_key_saved_via_ui = saveOk;
      report.stages.push('config_saved_via_ui');
      if (!saveOk) {
        // The POST fired but the save did not succeed (non-2xx). Hard gate.
        report.renderer_requests = [...new Set(requestLog)];
        await captureDomSummary(page, 'config-save-failed-dom.json');
        await screenshot(page, '02b-config-save-failed.png');
        fail('config_save_mismatch', new Error(`/config-save returned non-2xx (status=${report.config_save_post_status})`), apiKey);
        return;
      }

      // saveConfig redirects to /config ~700ms after a successful save; let it
      // settle, then load a fresh /config for the authoritative status read.
      await page.waitForTimeout(1500).catch(() => {});
      await page.goto(`${uiBase}/config`, { waitUntil: 'domcontentloaded' });

      // KEY-specific UI status (NOT the "当前接口路由" route 已配置 tags).
      const uiStatus = await readConfigStatus(page);
      report.configured_reported_by_ui = uiStatus.key_configured;
      report.visible_config_status_texts = uiStatus.texts;
      report.output_dir = uiStatus.output_dir;
      report.output_dir_confirmed = Boolean(uiStatus.output_dir && uiStatus.output_dir.trim());
      await screenshot(page, '02-config-configured.png');

      // Authoritative readback: the actual config file (presence + masked hint only)
      // and runtime effectiveness (server /health/meta).
      const summary = configSummary();
      report.redacted_config_summary = summary;
      report.config_path = summary.config_path;
      report.api_key_loaded_from_config = Boolean(summary.key_present);
      const meta = await httpGetJson(`http://127.0.0.1:${UI_PORT}/health/meta`);
      report.api_key_effective_for_runtime = Boolean(meta && meta.kie_api_key_configured);
      report.stages.push('configured_verified_via_ui');

      // Gate: proceed to the brief ONLY when the REAL save closed THIS run. A
      // pre-existing key in config + runtime effective is NOT enough — the current
      // run must have typed the key (api_key_input_filled) AND the actual UI save
      // must have succeeded (api_key_saved_via_ui, i.e. /config-save returned 200),
      // in addition to the KEY-specific UI status, config key_present and runtime
      // effective. Otherwise config_save_mismatch.
      const closureOk = report.api_key_input_filled
        && report.api_key_saved_via_ui
        && report.configured_reported_by_ui
        && report.api_key_loaded_from_config
        && report.api_key_effective_for_runtime;
      if (!closureOk) {
        report.config_save_mismatch = true;
        await captureDomSummary(page, 'config-save-mismatch-dom.json');
        await screenshot(page, '02b-config-save-mismatch.png');
        fail('config_save_mismatch', new Error(
          `config save not closed (configured_reported_by_ui=${report.configured_reported_by_ui}, ` +
          `api_key_input_filled=${report.api_key_input_filled}, api_key_saved_via_ui=${report.api_key_saved_via_ui}, ` +
          `key_present=${report.api_key_loaded_from_config}, effective=${report.api_key_effective_for_runtime})`,
        ), apiKey);
        return;
      }
    }

    // ── Workflow presence from /system (read-only) ────────────────────────────
    await page.goto(`${uiBase}/system`, { waitUntil: 'domcontentloaded' });
    const sysText = await page.locator('body').innerText();
    for (const label of ['WF01', 'WF02', 'WF02a', 'WF02b', 'WF03']) {
      const missing = new RegExp(`${label}[^\\n]*未找到`).test(sysText);
      report.workflow_presence[label] = sysText.includes(label) && !missing;
    }
    report.workflow_presence_all = Object.values(report.workflow_presence).every(Boolean) && !sysText.includes('部分工作流未找到');
    report.stages.push('workflow_presence_via_ui');
    await screenshot(page, '03-system-workflows.png');

    if (!FULL) {
      // Diagnostic mode STOPS here — no brief, no concept, no model/image generation.
      // But the API-key save closure must hold when a key was provided (a route/UI
      // "configured" is not sufficient — the key must persist + be runtime-effective).
      if (apiKey && !(report.api_key_loaded_from_config && report.api_key_effective_for_runtime)) {
        fail('config_save_not_effective', new Error(
          `API key not effective after UI save ` +
          `(loaded_from_config=${report.api_key_loaded_from_config}, effective=${report.api_key_effective_for_runtime})`,
        ), apiKey);
        return;
      }
      report.status = 'passed_diagnostic';
      report.stopped_at = 'diagnostic_no_generation';
      console.log('[ui-smoke] diagnostic mode complete (no generation).');
      finalize(0, apiKey);
      return;
    }

    // ── FULL mode only: complete image-only pipeline → Nano storyboard image ───
    // The creative-brief intake form lives at /new-project (the / route is a hub
    // dashboard). Navigate there explicitly; do NOT hard-wait field-0 on the hub.
    await page.goto(`${uiBase}/new-project`, { waitUntil: 'domcontentloaded' });
    // Record what the page actually shows BEFORE touching selectors.
    await captureDomSummary(page, 'new-project-dom-summary.json');
    await screenshot(page, '04a-new-project.png');

    // Wait for the intake form itself (stable id), not a single field.
    const briefForm = await firstLocator(page, ['#product-intake-form', 'form[action="/submit-product"]']);
    if (briefForm) { await briefForm.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {}); }

    // Resilient product-name locator: stable field name first, then label/placeholder.
    const nameInput = await firstLocator(page, [
      'input[name="field-0"]',
      'input[placeholder*="补光灯"]',
      'input[placeholder*="宠物梳"]',
    ]);
    if (!nameInput) {
      report.brief_form_found = false;
      await captureDomSummary(page, 'brief-form-missing-dom-summary.json');
      await screenshot(page, '04b-brief-form-missing.png');
      fail('brief_form_missing', new Error('creative-brief intake form / product-name field not found on /new-project'), apiKey);
      return;
    }
    report.brief_form_found = true;

    // Product name (required); description / selling points (optional); market +
    // language already default to "United States" / "English" — set them anyway
    // so the brief is explicit; then upload a test image.
    await nameInput.fill('Smoke Test Product — telescopic fishing rod');
    const descInput = await firstLocator(page, ['textarea[name="field-1"]', 'textarea']);
    if (descInput) await descInput.fill('Image-only smoke: telescopic fishing rod product photo with segmented dark rods and metal caps.').catch(() => {});
    const marketInput = await firstLocator(page, ['input[name="field-2"]']);
    if (marketInput) await marketInput.fill('United States').catch(() => {});
    const langInput = await firstLocator(page, ['input[name="field-3"]']);
    if (langInput) await langInput.fill('English').catch(() => {});
    // B8V: upload a FIXED, repo-bundled product image (a real photo, derived from a
    // provided WebP and stored as a small JPEG) through the real file input — not a
    // dynamic blank PNG. This gives WF01/WF02b stable, realistic binary input.
    const productImage = path.join(ROOT, 'tests', 'fixtures', 'ui-smoke-product.jpg');
    report.product_image_file_path = path.relative(ROOT, productImage);
    if (!fs.existsSync(productImage)) {
      fail('product_image_fixture_missing', new Error(`fixture not found: ${report.product_image_file_path}`), apiKey);
      return;
    }
    const fileInput = await firstLocator(page, ['input[type="file"][name="field-5"]', 'input[type="file"]']);
    report.product_image_input_matched = Boolean(fileInput);
    if (!fileInput) {
      await captureDomSummary(page, 'brief-form-no-file-input.json');
      fail('brief_form_missing', new Error('product image file input not found on /new-project'), apiKey);
      return;
    }
    report.product_image_upload_attempted = true;
    await fileInput.setInputFiles(productImage);
    // Verify the file is REALLY attached to the input (name/type/size present) —
    // never read the bytes; only metadata.
    const attached = await fileInput.evaluate((el) => {
      const f = el.files && el.files[0];
      return f ? { count: el.files.length, name: f.name, type: f.type, size: f.size } : { count: 0 };
    }).catch(() => ({ count: 0 }));
    report.product_image_attached_to_brief = Boolean(attached && attached.count > 0 && attached.size > 0);
    if (!report.product_image_attached_to_brief) {
      await captureDomSummary(page, 'brief-image-not-attached.json');
      fail('product_image_not_attached', new Error('product image did not attach to the file input (files.count=0)'), apiKey);
      return;
    }
    await screenshot(page, '04c-brief-filled.png');

    // Submit the brief and OBSERVE the /submit-product response — if it does not
    // accept (no 2xx/redirect to /submitted), fail BEFORE blaming WF01.
    const submitResp = page.waitForResponse(
      (r) => /\/submit-product\b/.test(r.url()) && r.request().method() === 'POST',
      { timeout: 60000 },
    );
    const submitBtn = await firstLocator(page, ['#product-submit-button', 'button[type="submit"]']);
    await (submitBtn || page.locator('#product-submit-button')).click();
    const sResp = await submitResp.catch(() => null);
    report.brief_submit_request_seen = Boolean(sResp);
    report.brief_submit_status = sResp ? sResp.status() : null;
    await page.waitForURL(/\/submitted/, { timeout: 60000 }).catch(() => {});
    const reachedSubmitted = /\/submitted/.test(page.url());
    if (!reachedSubmitted && !(sResp && sResp.status() >= 200 && sResp.status() < 400)) {
      await captureDomSummary(page, 'brief-submit-not-accepted.json');
      await screenshot(page, '04b-brief-submit-not-accepted.png');
      fail('brief_submit_not_accepted', new Error(
        `/submit-product not accepted (request_seen=${report.brief_submit_request_seen}, status=${report.brief_submit_status})`,
      ), apiKey);
      return;
    }
    let since = '0';
    try { since = new URL(page.url()).searchParams.get('since') || '0'; } catch {}
    report.brief_submitted_via_ui = true;
    report.stages.push('brief_submitted_via_ui');
    await screenshot(page, '04-brief-submitted.png');

    async function gotoActiveStage() {
      await page.goto(`${uiBase}/active?since=${encodeURIComponent(since)}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      return page.url();
    }
    async function waitForStage(match, label, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (report.forbidden_requests_blocked.length > 0) return false;
        const url = await gotoActiveStage();
        if (match.test(url)) return true;
        const body = await page.locator('body').innerText().catch(() => '');
        if (/生成失败|脚本框架生成失败|分镜图生成失败/.test(body)) { report.errors.push(`${label}: UI reports generation failed`); return false; }
        console.log(`[ui-smoke] waiting for ${label} … now at ${new URL(url).pathname}`);
        await sleep(8000);
      }
      report.errors.push(`${label}: timed out`);
      return false;
    }

    if (await waitForStage(/\/concepts\/item/, 'concept ready (WF01)', 4 * 60 * 1000)) {
      report.concept_ready_via_ui = true;
      report.stages.push('concept_ready_via_ui');
      await screenshot(page, '05-concept-ready.png');
      const selResp = page.waitForResponse((r) => r.url().includes('/concept-select-with-edit'), { timeout: 60000 });
      await page.locator('button[formaction="/concept-select-with-edit"]').first().click();
      const sr = await selResp.catch(() => null);
      report.concept_selected_via_ui = Boolean(sr && sr.status() < 400);
      report.stages.push('concept_selected_via_ui');

      const onScript = await waitForStage(/\/script-review/, 'script generated (scriptGenerateV1)', 4 * 60 * 1000);
      const hasConfirm = onScript && await page.locator('#confirm-script-btn').count().then((n) => n > 0).catch(() => false);
      if (hasConfirm) {
        report.script_generated_via_ui = true;
        report.stages.push('script_generated_via_ui');
        await screenshot(page, '06-script-ready.png');
        const confResp = page.waitForResponse((r) => r.url().includes('/script-confirm'), { timeout: 60000 });
        await page.locator('#confirm-script-btn').click();
        const cr = await confResp.catch(() => null);
        report.script_confirmed_via_ui = Boolean(cr && cr.status() < 400);
        report.stages.push('script_confirmed_via_ui');

        await page.waitForURL(/\/storyboard-status/, { timeout: 60000 }).catch(() => {});
        const onReview = await page.waitForURL(/\/reviews\/item/, { timeout: 4 * 60 * 1000 }).then(() => true).catch(() => false);
        if (onReview || /\/reviews\/item/.test(page.url())) {
          const panel = await page.evaluate(() => {
            const PANEL = /panel_preview_|panel_full_|storyboard|nanobanana|review_context/i;
            const SKIP = /logo|favicon|\bicon\b|product-|ui-smoke-product/i;
            const imgs = Array.from(document.images || []);
            const hit = imgs.find((im) => PANEL.test(im.src) && !SKIP.test(im.src) && im.naturalWidth > 16);
            return hit ? hit.src : null;
          }).catch(() => null);
          const reviewText = await page.locator('body').innerText().catch(() => '');
          if (panel && /分镜审核|分镜图/.test(reviewText)) {
            report.storyboard_image_generated_via_ui = true;
            report.image_ok = true;
            report.image_url = panel;
            await screenshot(page, '07-storyboard-review.png');
          } else { report.image_ok = false; report.errors.push('storyboard review reached but no panel image'); }
        } else { report.image_ok = false; report.errors.push('storyboard images did not reach the review page before timeout'); }
      } else { report.image_ok = false; report.errors.push('script-review page / #confirm-script-btn not reached'); }
    } else { report.image_ok = false; report.errors.push('WF01 concept did not become selectable before timeout'); }
  } catch (e) {
    try { collectWf01BinaryDiagnostics(report); } catch {}
    fail('ui_pipeline', e, apiKey);
    return;
  }

  // ── FULL-mode verdict ───────────────────────────────────────────────────────
  // B8V: now that WF01 has executed (succeeded or failed), capture its product-image
  // binary presence so a storyboard miss can be traced to upload/binary, not config.
  try { collectWf01BinaryDiagnostics(report); } catch (e) { report.binary_restore_error = report.binary_restore_error || redactString(String(e.message || e)).slice(0, 200); }
  if (report.forbidden_requests_blocked.length > 0) { fail('forbidden_request', new Error('forbidden video/Veo request attempted'), apiKey); return; }
  if (report.storyboard_image_generated_via_ui === true && report.image_ok === true) {
    report.status = 'passed';
    report.stopped_at = 'storyboard_ready_for_review';
    console.log('[ui-smoke] PASS: storyboard/Nano image generated (stopped before video).');
    finalize(0, apiKey);
    return;
  }
  report.error_message = report.error_message || 'storyboard/Nano image was not generated through the UI pipeline';
  fail('storyboard_not_generated', new Error(report.error_message), apiKey);
}

main().catch((e) => {
  try { fail('fatal', e, (process.env.AI_VIDEO_API_KEY || '').trim()); }
  catch {
    try { fs.writeFileSync(REPORT_PATH, JSON.stringify({ ...report, status: 'failed', failed_stage: 'fatal', error_message: e && e.message }, null, 2)); } catch {}
    process.exit(1);
  }
});
