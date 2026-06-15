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
//   no_paid_full — launch → submit the real UI product form with the bundled fish-rod
//       image → select concept → confirm script → review storyboard → confirm video.
//       The app server is forced into AI_VIDEO_NO_PAID_SMOKE=1 and writes local fixture
//       artifacts instead of calling n8n/model/image/video webhooks.
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
  guardExport,
  guardFinalMerge,
  guardReviewRerunShot,
  guardReviewSubmit,
  guardReviewSubmitVeoV2,
  guardVeo,
  guardVideoGeneration,
  selfTest,
  smokeScope,
  videoGenerationAllowed,
} from './smoke-guard.mjs';

// ── Safety: MUST be the first code executed ───────────────────────────────────
// Scope-aware: image_only (default) forbids all video; minimal_video allows EXACTLY one
// clip (video generation only) and still forbids final-merge + export.
assertImageOnlyScope();
const VIDEO_AUTHORIZED = videoGenerationAllowed(process.env);
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
const NO_PAID_FULL = MODE === 'no_paid_full';
const FULL = MODE === 'full' || NO_PAID_FULL;

// ── Fast-fail budgets (B8C) ───────────────────────────────────────────────────
const APP_LAUNCH_MS = 60_000;   // <=60s to spawn the Electron app
const WORKBENCH_MS = 90_000;    // <=90s for the workbench to load (else fast fail)
// image_only hard cap is unchanged (<=9min). minimal_video needs the full image pipeline
// (~7-8min) PLUS a real Veo video generation (~several min), so it gets a longer cap.
const TOTAL_MS = VIDEO_AUTHORIZED ? 20 * 60_000 : 9 * 60_000;
// How long to wait for the single video clip to land — bounded, and well inside TOTAL_MS so
// the verdict (which collects video diagnostics) always runs before the overall watchdog.
const VIDEO_WAIT_MS = 11 * 60_000;

const UI_PORT = Number(process.env.AI_VIDEO_UI_PORT || 18788);
const N8N_PORT = Number(process.env.AI_VIDEO_N8N_PORT || 5678);

// Output base: repo root by default (CI uploads from there); tests redirect to a
// temp dir via AI_VIDEO_SMOKE_OUT so they never write into the working tree.
const OUT_DIR = process.env.AI_VIDEO_SMOKE_OUT ? path.resolve(process.env.AI_VIDEO_SMOKE_OUT) : ROOT;
const REPORT_PATH = path.join(OUT_DIR, 'smoke-report.json');
const DIAG_DIR = path.join(OUT_DIR, 'smoke-diagnostics');
const SHOTS_DIR = path.join(DIAG_DIR, 'screenshots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

// final-merge / export / rerun-shot must NEVER fire in ANY smoke scope.
const ALWAYS_FORBIDDEN_REQUEST = [
  /final-merge/i,
  /mergeWithAudio/i,
  /review-rerun-shot/i,
  /\/api\/export-project/i,
  /\/api\/export-diagnostics/i,
];
// Video-generation triggers: forbidden in image_only; ALLOWED in minimal_video (which
// produces exactly one capped clip). Submitting the storyboard (/review-submit →
// reviewSubmitVeoV2) is how the single clip is generated.
const VIDEO_TRIGGER_REQUEST = [
  /review-submit/i,
  /reviewSubmitVeoV2/i,
  /\/v1\/veo/i,
  /veo\/generate/i,
  /image[_-]?to[_-]?video/i,
];
// The effective block-list for THIS run: always-forbidden, plus the video triggers unless
// a single video clip is explicitly authorized.
const FORBIDDEN_REQUEST = VIDEO_AUTHORIZED
  ? ALWAYS_FORBIDDEN_REQUEST
  : (NO_PAID_FULL
      ? [
          ...ALWAYS_FORBIDDEN_REQUEST,
          ...VIDEO_TRIGGER_REQUEST.filter((rx) => !String(rx).includes('review-submit')),
        ]
      : [...ALWAYS_FORBIDDEN_REQUEST, ...VIDEO_TRIGGER_REQUEST]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Shared run state (the watchdog and the main path both finalize through it) ──
const requestLog = [];
const electronOut = { buf: '', cap: 128 * 1024 };
let appRef = null;
let electronProc = null;
let finalized = false;

const report = {
  scope: smokeScope(),
  ui_driven: true,
  mode: MODE,
  no_paid_full: NO_PAID_FULL,
  no_paid_smoke_env: process.env.AI_VIDEO_NO_PAID_SMOKE === '1',
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
  wf01_diagnostics: null,               // B8X1: redacted WF01 execution diagnostics (see collectWf01ExecutionDiagnostics)
  task_runner_diagnostics: null,        // B8AB: n8n JS Task Runner offer/reject stats (redacted, read-only)
  wf01_concept_output: null,            // B8AB: did WF01 actually produce selectable concepts? (UI status + /active state)
  wf02b_diagnostics: null,              // B8AF: WF02B storyboard-image execution / Nano-call / binary / image-path (redacted)
  review_page_reached: null,            // B8AF: the storyboard review page loaded
  review_panel_image_present: null,     // B8AF: a storyboard panel image was visible on review
  review_render_diagnostics: null,      // B8AH: decisive review-context↔/local-file↔DOM render proof + downstream audit
  // full-mode pipeline milestones
  brief_submitted_via_ui: false,
  concept_ready_via_ui: false,
  concept_selected_via_ui: false,
  script_generated_via_ui: false,
  script_confirmed_via_ui: false,
  storyboard_image_generated_via_ui: false,
  no_paid_video_submitted_via_ui: false,
  no_paid_video_status_reached: false,
  no_paid_video_completed_count: null,
  image_ok: null,
  image_url: null,
  // stop-proof — image_only never reaches video; minimal_video reaches EXACTLY one clip.
  video_generation_skipped: true,
  veo_not_called: true,
  final_merge_not_called: true,
  stopped_at: NO_PAID_FULL ? 'no_paid_full_pending' : (FULL ? 'storyboard_ready_for_review' : 'diagnostic_no_generation'),
  // ── P14-C1: license-gate diagnostics (redacted — no activation code / key / device raw) ──
  license_required: null,
  license_present: null,
  license_valid: null,
  license_error_code: null,
  machine_id_hash_prefix: null,
  license_plan: null,
  license_expires_at: null,
  license_bypass: process.env.AI_VIDEO_LICENSE_BYPASS === '1',
  // ── B8AJ0: minimal_video scope (default image_only → all below stay safe/false) ──
  smoke_scope: smokeScope(),
  allow_video_generation: process.env.ALLOW_VIDEO_GENERATION === 'true',
  max_shots: Number(process.env.MAX_SHOTS || 0),
  video_generation_attempted: false,
  video_model_called: false,
  video_http_status: null,
  video_response_redacted_summary: null,
  video_clip_generated: false,
  video_clip_path: null,
  video_clip_file_exists: false,
  video_clip_duration: null,
  video_clip_size_bytes: null,
  video_save_path_allowed: null,
  final_merge_called: false,
  export_called: false,
  video_error_message: null,
  video_skipped_reason: VIDEO_AUTHORIZED ? null : 'scope_image_only',
  video_cap_file_written: null,
  video_submit_status: null,
  // ── B8AM: timeout-resilient video diagnostics ──
  video_wait_timed_out: false,
  video_diagnostics_collected: false,
  latest_video_task_status: null,
  // ── B8AO: WF03 Veo status-poll config-path visibility (the "缺少 Kie API Key" node) ──
  veo_status_poll_missing_key: null,
  veo_status_poll_config_path_used: null,
  veo_status_poll_config_file_exists: null,
  veo_status_poll_config_key_present: null,
  // ── B8AK: Kie first-frame upload (the pre-Veo step that hit Windows ENAMETOOLONG) ──
  first_frame_upload_attempted: null,
  first_frame_upload_method: null,
  first_frame_payload_size_bytes: null,
  first_frame_spawn_enametoolong: null,
  first_frame_upload_http_status: null,
  first_frame_upload_response_redacted_summary: null,
  first_frame_upload_succeeded: null,
  first_frame_uploaded_url_present: null,
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

// B8X1: read-only, REDACTED WF01 execution diagnostics — the hard fields the B8W
// artifact lacked (execution id, last node, stored error, http status, runner
// rejection). Names/enums/booleans/short-redacted strings only — never the full
// prompt, full model response, base64, paths, or any secret. Best-effort: never throws.
function collectWf01ExecutionDiagnostics(report) {
  const D = {
    execution_created: false,
    classification: 'unknown', // execution_db_not_found|no_execution|started_but_failed[_task_runner_rejected]|succeeded_ui_no_concept|running_or_timeout
    execution_id: null, workflow_id: null, workflow_name: null,
    status: null, started_at: null, stopped_at: null,
    last_node_executed: null, error_node: null, error_message: null, error_type: null, error_stack_present: false,
    model_call_seen: false, http_status: null, model_provider: null, model_name: null,
    response_redacted_summary: null, json_parse_error: false,
    input_keys: [], binary_keys: [], binary_local_paths_exist: [],
    // B8Z: config visibility — where WF01 should read the saved Kie key.
    wf01_config_path_used: null, wf01_config_file_exists: null, wf01_config_key_present: null,
    n8n_env_has_ai_video_config_path: null, task_runner_env_has_ai_video_config_path: null,
    task_runner_rejected: false, task_runner_reject_reason: null,
  };
  // Model route (provider/name) from config — these are NOT secrets (the key is not read).
  try {
    const cfgPath = path.join(userSupportDir(), 'config', 'local-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const cd = (cfg.tasks && cfg.tasks.creative_direction) || {};
      D.model_provider = cd.provider || (cfg.providers && cfg.providers.kie ? 'kie' : null);
      D.model_name = cd.model || null;
    }
  } catch {}
  // n8n.log task-runner rejection (redacted reason only — the reason has no secrets).
  try {
    const logPath = path.join(userSupportDir(), 'logs', 'launcher', 'n8n.log');
    if (fs.existsSync(logPath)) {
      const log = fs.readFileSync(logPath, 'utf8');
      const m = log.match(/rejected by Runner with reason "([^"]+)"/i) || log.match(/(Offer expired[^"\n]{0,80})/i);
      if (m) { D.task_runner_rejected = true; D.task_runner_reject_reason = redactString(m[1]).slice(0, 120); }
    }
  } catch {}

  const dbPath = path.join(userSupportDir(), 'workflow-data', '.n8n', 'database.sqlite');
  if (!fs.existsSync(dbPath)) { D.classification = 'execution_db_not_found'; report.wf01_diagnostics = D; return; }

  const wf01Id = 'rKHHjD2QBlL6EhaM';
  let ex = null;
  try {
    let rows = [];
    try {
      rows = JSON.parse(runSqlite(['-json', dbPath,
        `SELECT id, status, "startedAt" AS startedAt, "stoppedAt" AS stoppedAt, "workflowId" AS workflowId FROM execution_entity WHERE "workflowId"='${wf01Id}' ORDER BY id DESC LIMIT 1;`,
      ], { encoding: 'utf8' }) || '[]');
    } catch {
      rows = JSON.parse(runSqlite(['-json', dbPath,
        `SELECT id, status, "workflowId" AS workflowId FROM execution_entity WHERE "workflowId"='${wf01Id}' ORDER BY id DESC LIMIT 1;`,
      ], { encoding: 'utf8' }) || '[]');
    }
    ex = rows[0] || null;
  } catch (e) { D.error_message = redactString(String(e.message || e)).slice(0, 200); }

  if (!ex) { D.classification = 'no_execution'; report.wf01_diagnostics = D; return; }
  D.execution_created = true;
  D.execution_id = String(ex.id);
  D.workflow_id = String(ex.workflowId || wf01Id);
  D.status = ex.status != null ? String(ex.status) : null;
  D.started_at = ex.startedAt != null ? String(ex.startedAt) : null;
  D.stopped_at = ex.stoppedAt != null ? String(ex.stoppedAt) : null;
  try {
    const w = JSON.parse(runSqlite(['-json', dbPath, `SELECT name FROM workflow_entity WHERE id='${wf01Id}';`], { encoding: 'utf8' }) || '[]');
    D.workflow_name = w[0] ? String(w[0].name) : null;
  } catch {}

  // Execution data → flatted parse (best-effort) → last node / error / http / keys.
  let parsed = null; let text = '';
  try {
    const d = JSON.parse(runSqlite(['-json', dbPath, `SELECT data FROM execution_data WHERE "executionId"=${Number(ex.id)} LIMIT 1;`], { encoding: 'utf8' }) || '[]');
    const dataStr = d[0] ? String(d[0].data || '') : '';
    if (dataStr) {
      try { parsed = _require('flatted').parse(dataStr); } catch {}
      try { text = JSON.stringify(parsed); } catch { text = dataStr; }
      D.binary_keys = [...new Set((text.match(/"(product_images_\d+|image_\d+)"/g) || []).map((s) => s.replace(/"/g, '')))].slice(0, 20);
      for (const mm of [...text.matchAll(/"(?:image_\d+_path|product_image_local_path[s]?)"\s*:\s*"([^"]+)"/g)].slice(0, 8)) {
        try { D.binary_local_paths_exist.push(fs.existsSync(mm[1])); } catch { D.binary_local_paths_exist.push(false); }
      }
      D.input_keys = [...new Set((text.match(/"(product_name|target_market|target_language|creative_task_type|product_image_count|product_images_\d+|image_\d+_path)"/g) || []).map((s) => s.replace(/"/g, '')))].slice(0, 25);
      // B8Z: json_parse_error must reflect a REAL JSON-parse / model-response error,
      // not merely the words appearing somewhere in the (large) execution data.
    }
  } catch (e) { if (!D.error_message) D.error_message = redactString(String(e.message || e)).slice(0, 200); }

  if (parsed && parsed.resultData && typeof parsed.resultData === 'object') {
    const rd = parsed.resultData;
    if (typeof rd.lastNodeExecuted === 'string') D.last_node_executed = rd.lastNodeExecuted;
    const err = rd.error;
    if (err && typeof err === 'object') {
      D.error_node = (err.node && err.node.name) ? String(err.node.name) : null;
      D.error_message = redactString(String(err.message || '')).slice(0, 300);
      D.error_type = err.name ? String(err.name) : (err.constructor && err.constructor.name) || null;
      D.error_stack_present = Boolean(err.stack);
      const httpCode = err.httpCode || (err.cause && (err.cause.httpCode || (err.cause.response && err.cause.response.status))) || null;
      if (httpCode != null) { D.http_status = Number(httpCode); D.model_call_seen = true; }
      if (/Api/i.test(D.error_type || '')) D.model_call_seen = true;
      const resp = err.cause && err.cause.response;
      if (resp) { try { D.response_redacted_summary = redactString(JSON.stringify(resp)).slice(0, 200); } catch {} }
      // Real JSON-parse / model-response errors only (not any message mentioning "json").
      if (/Unexpected token|Unexpected end of JSON|is not valid JSON|JSON\.parse|SyntaxError.*JSON|failed to parse/i.test(D.error_message || '')) D.json_parse_error = true;
    }
  }

  // B8Z: config visibility — confirm the saved key lives at the unified config path
  // WF01 now reads (presence + masked-via-summary only; the value is never emitted).
  try {
    const cs = configSummary();
    D.wf01_config_path_used = cs.config_path || null;
    D.wf01_config_file_exists = Boolean(cs.exists);
    D.wf01_config_key_present = Boolean(cs.key_present);
  } catch {}

  const st = String(D.status || '').toLowerCase();
  if (st === 'success') D.classification = 'succeeded_ui_no_concept';
  else if (st === 'running' || st === 'new' || st === 'waiting' || st === 'unknown' || st === '') D.classification = 'running_or_timeout';
  else D.classification = D.task_runner_rejected ? 'started_but_failed_task_runner_rejected' : 'started_but_failed';
  report.wf01_diagnostics = D;
}

// B8AB: read-only n8n JS Task Runner offer/reject stats from the launcher n8n.log.
// Counts only + redacted reasons — no secrets. Notes the HARDCODED 5s offer window
// (OFFER_VALID_TIME_MS in @n8n/task-runner — not env-configurable in n8n 2.16.x).
function collectTaskRunnerDiagnostics(report) {
  const D = {
    task_runner_mode: 'internal_js',
    task_runner_ready: null,
    registered_runner_seen: false,
    registered_runner_name: null,
    runner_ready_before_first_task: null,
    rejected_task_count: 0,
    rejected_task_ids: [],
    rejected_node_names: [], // n8n.log reject lines carry task ids, not node names
    reject_reasons: [],
    offer_expired_count: 0,
    code_node_tasks_seen: 0,
    runner_config_redacted: {
      offer_valid_time_ms_hardcoded: 5000,
      offer_window_configurable: false,
      max_concurrency_default: 10,
      heartbeat_interval_default_s: 30,
      task_timeout_s_launcher: 900,
      task_request_timeout_s_launcher: 1200,
    },
    n8n_runner_env_redacted: null, // not readable from the smoke process (separate proc)
  };
  try {
    const logPath = path.join(userSupportDir(), 'logs', 'launcher', 'n8n.log');
    if (!fs.existsSync(logPath)) { report.task_runner_diagnostics = D; return; }
    const log = fs.readFileSync(logPath, 'utf8');
    const reg = log.match(/Registered runner "([^"]+)"/);
    D.registered_runner_seen = Boolean(reg);
    D.registered_runner_name = reg ? reg[1] : null;
    D.task_runner_ready = D.registered_runner_seen;
    const rejects = [...log.matchAll(/Task \(([^)]+)\) rejected by Runner with reason "([^"]+)"/g)];
    D.rejected_task_count = rejects.length;
    D.rejected_task_ids = rejects.map((m) => m[1]).slice(0, 20);
    D.reject_reasons = [...new Set(rejects.map((m) => redactString(m[2]).slice(0, 80)))].slice(0, 5);
    D.offer_expired_count = rejects.filter((m) => /Offer expired/i.test(m[2])).length;
    D.code_node_tasks_seen = (log.match(/Task \([^)]+\)/g) || []).length;
    const regIdx = reg ? log.indexOf(reg[0]) : -1;
    const firstTaskMatch = log.search(/Task \([^)]+\)/);
    D.runner_ready_before_first_task = (regIdx >= 0 && firstTaskMatch >= 0) ? (regIdx < firstTaskMatch) : null;
  } catch (e) { D.error = redactString(String(e.message || e)).slice(0, 150); }
  report.task_runner_diagnostics = D;
}

// B8AB: when WF01 "succeeds" but no concept becomes selectable, capture WHETHER the
// concept output actually exists — the UI's own /api/wf01-status, the /active page
// state, and a best-effort concept count from the execution data. Redacted; counts
// and short status only — never a full prompt/model response.
async function collectConceptOutputDiagnostics(report, page, uiBase, since) {
  const D = { wf01_status_api: null, active_url: null, concept_count_in_execution: null };
  try {
    const raw = await httpGetJson(`http://127.0.0.1:${UI_PORT}/api/wf01-status`);
    if (raw) { try { D.wf01_status_api = JSON.parse(redactString(JSON.stringify(raw)).slice(0, 800)); } catch { D.wf01_status_api = { unparsed: true }; } }
  } catch {}
  try {
    await page.goto(`${uiBase}/active?since=${encodeURIComponent(since)}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    D.active_url = page.url();
    await captureDomSummary(page, 'concept-not-ready-active-dom.json');
    await screenshot(page, '05b-concept-not-ready.png');
  } catch {}
  // B8AD: did WF01 write the concept-context to the UNIFIED Windows path the UI reads,
  // or to the Mac fallback? (path-only existence booleans — no file contents.)
  try {
    const projectId = (D.wf01_status_api && D.wf01_status_api.projectId) || null;
    const readDir = path.join(userSupportDir(), 'workflow-data', '.n8n-local-cache', 'concept-context');
    const macDir = path.join(os.homedir(), 'Library', 'Application Support', 'AI Video', 'workflow-data', '.n8n-local-cache', 'concept-context');
    const hasFile = (dir) => {
      try {
        if (projectId && fs.existsSync(path.join(dir, `concept_context_${projectId}.json`))) return true;
        return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith('concept_context_') && f.endsWith('.json'));
      } catch { return false; }
    };
    D.workflow_data_root_ui_read = path.join(userSupportDir(), 'workflow-data');
    D.concept_context_read_dir = readDir;
    D.concept_context_read_file_exists = hasFile(readDir);
    D.concept_context_mac_fallback_file_exists = hasFile(macDir);
    D.mac_fallback_path_used_on_windows = process.platform === 'win32' && D.concept_context_mac_fallback_file_exists;
    D.path_mismatch_detected = Boolean(D.concept_context_mac_fallback_file_exists && !D.concept_context_read_file_exists);
  } catch {}
  try {
    const dbPath = path.join(userSupportDir(), 'workflow-data', '.n8n', 'database.sqlite');
    if (fs.existsSync(dbPath)) {
      const d = JSON.parse(runSqlite(['-json', dbPath, 'SELECT data FROM execution_data ORDER BY "executionId" DESC LIMIT 1;'], { encoding: 'utf8' }) || '[]');
      const dataStr = d[0] ? String(d[0].data || '') : '';
      let text = dataStr; try { text = JSON.stringify(_require('flatted').parse(dataStr)); } catch {}
      const counts = ['"concept_id"', '"video_type"', '"selectedConceptVideoType"', '"creative_direction"'].map((k) => (text.split(k).length - 1));
      D.concept_count_in_execution = Math.max(0, ...counts) || 0;
    }
  } catch {}
  report.wf01_concept_output = D;
}

// B8AF: read-only, REDACTED WF02B (storyboard image) diagnostics — pinpoints WHICH
// layer failed: execution / Nano-image-API call / task-runner offer / binary restore /
// image write-vs-read path. Names/counts/booleans/short-redacted only; never a full
// prompt, full model response, base64, or secret. Best-effort: never throws.
function collectWf02bDiagnostics(report) {
  const CACHE = path.join(userSupportDir(), 'workflow-data', '.n8n-local-cache');
  const MAC_CACHE = path.join(os.homedir(), 'Library', 'Application Support', 'AI Video', 'workflow-data', '.n8n-local-cache');
  const dbPath = path.join(userSupportDir(), 'workflow-data', '.n8n', 'database.sqlite');
  const has = (d, re) => { try { return fs.existsSync(d) && fs.readdirSync(d).some((f) => (re ? re.test(f) : true)); } catch { return false; } };
  const D = {
    // ── execution ──
    wf02b_execution_id: null, wf02b_workflow_id: 'storyboardGenerateV1', wf02b_workflow_name: null,
    wf02b_status: null, wf02b_started_at: null, wf02b_stopped_at: null,
    wf02b_last_node_executed: null, wf02b_error_node: null, wf02b_error_message: null, wf02b_error_type: null,
    wf02b_classification: 'unknown',
    // ── Nano / image API ──
    nano_call_seen: false, nano_http_status: null, nano_model_name: null,
    nano_response_redacted_summary: null, nano_error_message: null, image_api_called_before_failure: false,
    // ── task runner (whole-log scan, redacted) ──
    wf02b_task_runner: null,
    // ── binary restore ──
    binary_restore_error: null, binary_restore_detail: null,
    // ── storyboard image path ──
    storyboard_image_generated: false, storyboard_image_write_dir: null, storyboard_image_write_file_exists: false,
    panel_preview_read_dir: null, panel_preview_file_exists: false,
    storyboard_path_mismatch_detected: false, mac_fallback_image_exists_on_windows: false,
  };
  // model name (config route value — not a secret)
  try { const cfg = JSON.parse(fs.readFileSync(path.join(userSupportDir(), 'config', 'local-config.json'), 'utf8')); D.nano_model_name = (cfg.tasks && cfg.tasks.storyboard_image && cfg.tasks.storyboard_image.model) || null; } catch {}

  // 1) WF02B execution (storyboardGenerateV1)
  if (!fs.existsSync(dbPath)) { D.wf02b_classification = 'execution_db_not_found'; }
  else {
    try {
      let rows = [];
      try { rows = JSON.parse(runSqlite(['-json', dbPath, `SELECT id, status, "startedAt" AS startedAt, "stoppedAt" AS stoppedAt FROM execution_entity WHERE "workflowId"='storyboardGenerateV1' ORDER BY id DESC LIMIT 1;`], { encoding: 'utf8' }) || '[]'); }
      catch { rows = JSON.parse(runSqlite(['-json', dbPath, `SELECT id, status FROM execution_entity WHERE "workflowId"='storyboardGenerateV1' ORDER BY id DESC LIMIT 1;`], { encoding: 'utf8' }) || '[]'); }
      const ex = rows[0];
      if (!ex) { D.wf02b_classification = 'no_wf02b_execution'; }
      else {
        D.wf02b_execution_id = String(ex.id);
        D.wf02b_status = ex.status != null ? String(ex.status) : null;
        D.wf02b_started_at = ex.startedAt != null ? String(ex.startedAt) : null;
        D.wf02b_stopped_at = ex.stoppedAt != null ? String(ex.stoppedAt) : null;
        try { const w = JSON.parse(runSqlite(['-json', dbPath, `SELECT name FROM workflow_entity WHERE id='storyboardGenerateV1';`], { encoding: 'utf8' }) || '[]'); D.wf02b_workflow_name = w[0] ? String(w[0].name) : null; } catch {}
        try {
          const d = JSON.parse(runSqlite(['-json', dbPath, `SELECT data FROM execution_data WHERE "executionId"=${Number(ex.id)} LIMIT 1;`], { encoding: 'utf8' }) || '[]');
          const dataStr = d[0] ? String(d[0].data || '') : '';
          let parsed = null; let text = dataStr; try { parsed = _require('flatted').parse(dataStr); text = JSON.stringify(parsed); } catch {}
          if (parsed && parsed.resultData && typeof parsed.resultData === 'object') {
            const rd = parsed.resultData;
            if (typeof rd.lastNodeExecuted === 'string') D.wf02b_last_node_executed = rd.lastNodeExecuted;
            const err = rd.error;
            if (err && typeof err === 'object') {
              D.wf02b_error_node = (err.node && err.node.name) ? String(err.node.name) : null;
              D.wf02b_error_message = redactString(String(err.message || '')).slice(0, 300);
              D.wf02b_error_type = err.name ? String(err.name) : null;
              const hc = err.httpCode || (err.cause && (err.cause.httpCode || (err.cause.response && err.cause.response.status))) || null;
              if (hc != null) { D.nano_http_status = Number(hc); D.nano_call_seen = true; D.nano_error_message = D.wf02b_error_message; }
            }
          }
          // The Nano Code node throws "HTTP <code>: ..." on a failed call — capture the status.
          const hm = text.match(/HTTP (\d{3})[:\s]/); if (hm && D.nano_http_status == null) { D.nano_http_status = Number(hm[1]); D.nano_call_seen = true; }
        } catch {}
        const st = String(D.wf02b_status || '').toLowerCase();
        D.wf02b_classification = st === 'success' ? 'succeeded'
          : (st === 'error' || st === 'crashed' || st === 'failed') ? 'started_but_failed'
          : (st === '' || st === 'running' || st === 'new' || st === 'waiting') ? 'running_or_timeout' : 'unknown';
      }
    } catch (e) { if (!D.wf02b_error_message) D.wf02b_error_message = redactString(String(e.message || e)).slice(0, 200); }
  }

  // 2) Nano / image API — request/response files prove the call was attempted
  D.image_api_called_before_failure = has(path.join(CACHE, 'gemini-requests')) || has(path.join(CACHE, 'gemini-responses'));
  if (D.image_api_called_before_failure) D.nano_call_seen = true;
  try {
    const respDir = path.join(CACHE, 'gemini-responses');
    if (fs.existsSync(respDir)) {
      const files = fs.readdirSync(respDir).filter((f) => f.endsWith('.json'));
      if (files.length) {
        const raw = fs.readFileSync(path.join(respDir, files.sort().slice(-1)[0]), 'utf8');
        D.nano_response_redacted_summary = redactString(raw).slice(0, 200);
        const sm = raw.match(/"(?:statusCode|code|status)"\s*:\s*(\d{3})/); if (sm && D.nano_http_status == null) D.nano_http_status = Number(sm[1]);
      }
    }
  } catch {}

  // 3) storyboard image write/read paths (after B8AD both should be %APPDATA%)
  D.storyboard_image_write_dir = path.join(CACHE, 'nanobanana');
  D.storyboard_image_write_file_exists = has(D.storyboard_image_write_dir, /^storyboard_.*\.(png|jpe?g)$/i);
  D.storyboard_image_generated = D.storyboard_image_write_file_exists;
  D.panel_preview_read_dir = path.join(CACHE, '分镜图裁剪', 'previews');
  D.panel_preview_file_exists = has(D.panel_preview_read_dir, /^panel_preview_.*\.(jpe?g|png)$/i);
  D.mac_fallback_image_exists_on_windows = process.platform === 'win32'
    && (has(path.join(MAC_CACHE, 'nanobanana'), /^storyboard_/i) || has(path.join(MAC_CACHE, '分镜图裁剪', 'previews'), /^panel_preview_/i));
  // mismatch: an image landed on the Mac path (write) but not on the %APPDATA% read path.
  D.storyboard_path_mismatch_detected = Boolean(D.mac_fallback_image_exists_on_windows && !D.storyboard_image_write_file_exists && !D.panel_preview_file_exists);

  // 4) task runner (whole-log) + binary restore
  try {
    const logPath = path.join(userSupportDir(), 'logs', 'launcher', 'n8n.log');
    if (fs.existsSync(logPath)) {
      const log = fs.readFileSync(logPath, 'utf8');
      const rejects = [...log.matchAll(/Task \(([^)]+)\) rejected by Runner with reason "([^"]+)"/g)];
      D.wf02b_task_runner = {
        rejected_task_count: rejects.length,
        offer_expired_count: rejects.filter((m) => /Offer expired/i.test(m[2])).length,
        rejected_task_ids: rejects.map((m) => m[1]).slice(0, 20),
        rejected_node_names: [], // n8n.log carries task ids only, not node names
        code_node_tasks_seen: (log.match(/Task \([^)]+\)/g) || []).length,
        runner_reject_reasons: [...new Set(rejects.map((m) => redactString(m[2]).slice(0, 80)))].slice(0, 5),
      };
      const br = log.match(/Failed to restore binary data[^\n]*/i);
      if (br) {
        D.binary_restore_error = redactString(br[0]).slice(0, 200);
        const idm = br[0].match(/ID[\s:\-]*([A-Za-z0-9_\-/.]+)/i);
        D.binary_restore_detail = { binary_id_redacted: idm ? redactString(idm[1]).slice(0, 60) : null, no_such_file: /No such file/i.test(br[0]) };
      }
    }
  } catch {}
  report.wf02b_diagnostics = D;
}

// B8AH: the DECISIVE review-render proof — read the review context the page is showing,
// confirm the panel record + its panel_preview_path field, the exact preview file, the
// /local-file URL + its HTTP status (fetched from inside the page), whether the DOM img
// actually loaded, and an end-to-end write-vs-read path check + a downstream (WF03/video/
// final/export) contract-audit summary. Read-only; paths/counts/booleans only — no secret.
async function collectReviewRenderDiagnostics(report, page, uiBase) {
  const CACHE = path.join(userSupportDir(), 'workflow-data', '.n8n-local-cache');
  const D = {
    review_context_path: null, review_context_file_exists: false, review_context_panel_count: null,
    review_context_panel_image_fields: [],
    review_panel_image_src: null, review_panel_image_src_status: null,
    local_file_url: null, local_file_http_status: null, local_file_resolved_path: null,
    local_file_resolved_path_exists: null, local_file_within_allowed_root: null,
    preview_file_exact_path: null, preview_file_exists: null, preview_file_size: null,
    review_dom_img_count: null, review_panel_image_load_error: null,
    storyboard_image_write_dir: null, storyboard_image_write_exact_path: null,
    storyboard_image_review_dir: null, storyboard_image_review_exact_path: null,
    storyboard_path_mismatch_detected: null,
    downstream_contract_audit_summary: null,
    wf03_video_context_risk: null, final_video_context_risk: null, export_context_risk: null, local_file_mapping_risk: null,
  };
  // 1) which review context is the page showing?
  try {
    const u = new URL(page.url());
    const ctxName = u.searchParams.get('context') || '';
    if (ctxName && /^review_context_[\w.\-]+\.json$/.test(ctxName)) {
      const ctxPath = path.join(CACHE, 'review-context', ctxName);
      D.review_context_path = ctxPath;
      D.review_context_file_exists = fs.existsSync(ctxPath);
      if (D.review_context_file_exists) {
        const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
        const panels = Array.isArray(ctx.panel_review_pack) ? ctx.panel_review_pack : [];
        D.review_context_panel_count = panels.length;
        const p0 = panels[0] || {};
        D.review_context_panel_image_fields = Object.keys(p0).filter((k) => /path|url|preview|image|full/i.test(k)).slice(0, 12);
        const previewPath = String(p0.panel_preview_path || '');
        if (previewPath) {
          D.preview_file_exact_path = previewPath;
          D.preview_file_exists = fs.existsSync(previewPath);
          try { D.preview_file_size = D.preview_file_exists ? fs.statSync(previewPath).size : 0; } catch {}
          D.local_file_url = `/local-file?path=${encodeURIComponent(previewPath)}`;
          // within-allowed-root mirror of the serve allowlist (read-only check)
          const roots = [path.join(CACHE, 'videos'), path.join(CACHE, 'final-video'), path.join(CACHE, '分镜图裁剪')].map((r) => path.resolve(r) + path.sep);
          D.local_file_resolved_path = path.resolve(previewPath);
          D.local_file_resolved_path_exists = fs.existsSync(D.local_file_resolved_path);
          D.local_file_within_allowed_root = roots.some((r) => D.local_file_resolved_path.startsWith(r));
        }
      }
    }
  } catch (e) { D.review_context_error = redactString(String(e.message || e)).slice(0, 160); }

  // 2) does /local-file actually serve it? (fetch the real URL from inside the page)
  try {
    if (D.local_file_url) {
      const st = await page.evaluate(async (u) => {
        try { const r = await fetch(u, { method: 'GET' }); return { status: r.status, type: r.headers.get('content-type') || '' }; }
        catch (e) { return { status: -1, type: String((e && e.message) || e).slice(0, 80) }; }
      }, `${uiBase}${D.local_file_url}`).catch(() => null);
      if (st) { D.local_file_http_status = st.status; D.review_panel_image_src_status = st.status; }
    }
  } catch {}

  // 3) DOM image reality — count + the first panel img + its load state/error
  try {
    const dom = await page.evaluate((reSrc) => {
      const PANEL = new RegExp(reSrc, 'i');
      const SKIP = /logo|favicon|\bicon\b|product-|ui-smoke-product/i;
      const imgs = Array.from(document.images || []);
      const panels = imgs.filter((im) => PANEL.test(im.src) && !SKIP.test(im.src));
      const first = panels[0];
      return {
        total: imgs.length, panelCount: panels.length,
        firstSrc: first ? first.src : null,
        firstComplete: first ? first.complete : null,
        firstNaturalWidth: first ? first.naturalWidth : null,
        firstLoadError: first ? (first.complete && first.naturalWidth === 0) : null,
      };
    }, 'panel_preview_|panel_full_|storyboard|nanobanana|local-file').catch(() => null);
    if (dom) {
      D.review_dom_img_count = dom.panelCount;
      D.review_panel_image_src = dom.firstSrc;
      D.review_panel_image_load_error = dom.firstLoadError === true ? 'img.complete && naturalWidth===0 (load failed)' : (dom.firstLoadError === false ? null : 'no panel img element');
    }
  } catch {}

  // 4) write-vs-read EXACT FILE paths (after B8AD both should be %APPDATA%). The
  // *_dir fields keep the directory; the *_exact_path fields are the actual newest
  // matching file on disk (so they prove a real file, not just a folder).
  const newestFile = (dir, re) => {
    try {
      if (!fs.existsSync(dir)) return null;
      const hit = fs.readdirSync(dir)
        .filter((f) => re.test(f))
        .map((f) => { const p = path.join(dir, f); let m = 0; try { m = fs.statSync(p).mtimeMs; } catch {} return { p, m }; })
        .sort((a, b) => b.m - a.m)[0];
      return hit ? hit.p : null;
    } catch { return null; }
  };
  try {
    const nanoDir = path.join(CACHE, 'nanobanana');
    const prevDir = path.join(CACHE, '分镜图裁剪', 'previews');
    D.storyboard_image_write_dir = nanoDir;
    D.storyboard_image_review_dir = prevDir;
    // exact file paths: nanobanana storyboard_*.{png,jpg} and the previews panel_preview_*.jpg.
    // prefer the context-recorded preview file when present, else the newest on disk.
    D.storyboard_image_write_exact_path = newestFile(nanoDir, /^storyboard_.*\.(png|jpe?g)$/i);
    D.storyboard_image_review_exact_path = (D.preview_file_exact_path && fs.existsSync(D.preview_file_exact_path))
      ? D.preview_file_exact_path
      : newestFile(prevDir, /^panel_preview_.*\.(jpe?g|png)$/i);
    const macPrev = path.join(os.homedir(), 'Library', 'Application Support', 'AI Video', 'workflow-data', '.n8n-local-cache', '分镜图裁剪', 'previews');
    const macHas = (() => { try { return fs.existsSync(macPrev) && fs.readdirSync(macPrev).some((f) => /^panel_preview_/.test(f)); } catch { return false; } })();
    const winHas = D.preview_file_exists === true || Boolean(D.storyboard_image_review_exact_path);
    D.storyboard_path_mismatch_detected = Boolean(process.platform === 'win32' && macHas && !winHas);
  } catch {}

  // 5) downstream contract audit (static, derived from the known field/route map)
  D.wf03_video_context_risk = 'low: WF03 writes video_path under .n8n-local-cache/videos; serve reads shotProg.video_path via /local-file (root videos allowed)';
  D.final_video_context_risk = 'low: WF03 writes final_merged_video_path under .n8n-local-cache/final-video; serve reads final_merged_video_path via /local-file (root final-video allowed)';
  D.export_context_risk = 'low: export/open-folder uses the same review-progress/export context fields; no separate file-URL map';
  D.local_file_mapping_risk = 'low: single /local-file handler + isAllowedLocalAssetPath allowlist (ROOT, videos, final-video, 分镜图裁剪); ext-gated to mp4/mov/webm/png/jpg/jpeg; rejects out-of-root';
  D.downstream_contract_audit_summary = 'storyboard(panel_preview_path), video(video_path), final(final_merged_video_path) all use one /local-file URL builder + one allowlist; field names match write↔read; Windows %APPDATA% + 中文(分镜图裁剪) paths URL-encoded then decoded by URL.searchParams';
  report.review_render_diagnostics = D;
}

// P14-C1: read the license-gate state from the UI server (/license/status) + the license
// file presence. REDACTED — emits only required/valid/error/plan/expiry + a machine-id-hash
// PREFIX; never the activation code, the raw device id, the private key, or the API key.
async function collectLicenseDiagnostics(report) {
  try {
    const st = await httpGetJson(`http://127.0.0.1:${UI_PORT}/license/status`);
    if (st && typeof st === 'object') {
      report.license_required = Boolean(st.required);
      report.license_valid = Boolean(st.ok);
      report.license_error_code = st.ok ? null : redactString(String(st.message || '')).slice(0, 80);
      report.machine_id_hash_prefix = st.device_id ? String(st.device_id).slice(0, 8) : null;
      report.license_plan = st.plan ? String(st.plan).slice(0, 24) : (st.customer ? 'customer' : null);
      report.license_expires_at = st.expires_at ? String(st.expires_at).slice(0, 32) : null;
    }
  } catch {}
  // license file presence (boolean only — never read/emit its contents).
  try {
    const lf = path.join(userSupportDir(), 'license.json');
    report.license_present = fs.existsSync(lf);
  } catch { report.license_present = false; }
}

// ── B8AJ0: minimal_video (EXACTLY one video clip via the real UI) ──────────────
function videoCacheDir() { return path.join(userSupportDir(), 'workflow-data', '.n8n-local-cache', 'videos'); }

// Minimal, dependency-free mp4 duration (seconds) from the moov/mvhd box. Returns null
// if it can't be parsed — size is the authoritative "a real clip exists" signal.
function readMp4DurationSec(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const idx = buf.indexOf(Buffer.from('mvhd'));
    if (idx < 0) return null;
    const version = buf[idx + 4];
    let timescale; let duration;
    if (version === 1) { timescale = buf.readUInt32BE(idx + 24); duration = Number(buf.readBigUInt64BE(idx + 28)); }
    else { timescale = buf.readUInt32BE(idx + 16); duration = buf.readUInt32BE(idx + 20); }
    if (timescale > 0 && duration > 0) return Math.round((duration / timescale) * 100) / 100;
  } catch {}
  return null;
}

// Read the WF03 (reviewSubmitVeoV2) execution — redacted — for model-called / http / error.
function collectVideoDiagnostics(report) {
  try {
    const dbPath = path.join(userSupportDir(), 'workflow-data', '.n8n', 'database.sqlite');
    if (!fs.existsSync(dbPath)) return;
    const rows = JSON.parse(runSqlite(['-json', dbPath, `SELECT id, status FROM execution_entity WHERE "workflowId"='reviewSubmitVeoV2' ORDER BY id DESC LIMIT 1;`], { encoding: 'utf8' }) || '[]');
    const ex = rows[0];
    if (!ex) return;
    const d = JSON.parse(runSqlite(['-json', dbPath, `SELECT data FROM execution_data WHERE "executionId"=${Number(ex.id)} LIMIT 1;`], { encoding: 'utf8' }) || '[]');
    const dataStr = d[0] ? String(d[0].data || '') : '';
    let parsed = null; let text = dataStr; try { parsed = _require('flatted').parse(dataStr); text = JSON.stringify(parsed); } catch {}
    if (parsed && parsed.resultData && parsed.resultData.error) {
      const err = parsed.resultData.error;
      report.video_error_message = redactString(String(err.message || '')).slice(0, 300);
      const hc = err.httpCode || (err.cause && (err.cause.httpCode || (err.cause.response && err.cause.response.status))) || null;
      if (hc != null) { report.video_http_status = Number(hc); report.video_model_called = true; }
    }
    const hm = text.match(/HTTP (\d{3})[:\s]/); if (hm && report.video_http_status == null) { report.video_http_status = Number(hm[1]); report.video_model_called = true; }
    // a redacted one-line response summary (no full response / no key)
    const sm = text.match(/"(?:operationName|name|taskId|videoUrl|status)"\s*:\s*"[^"]{0,40}"/);
    if (sm) report.video_response_redacted_summary = redactString(sm[0]).slice(0, 160);
    // B8AM: latest Veo task status (processing / completed / failed / submitted) — evidence
    // that the model WAS called even when the clip hasn't landed yet. A submitted task id /
    // operationName implies the Veo HTTP call happened.
    const ts = text.match(/"(?:successFlag|veo_done|status|state)"\s*:\s*"?(processing|pending|running|queued|completed|done|success|succeeded|failed|error)"?/i);
    if (ts) report.latest_video_task_status = String(ts[1]).toLowerCase();
    if (/"(?:taskId|operationName|veo_task_id|modelhub_task_id)"\s*:\s*"[^"]{4,}"/.test(text)) { report.video_model_called = true; if (!report.latest_video_task_status) report.latest_video_task_status = report.latest_video_task_status || 'submitted'; }
    // ── B8AK first-frame upload diagnostics ──
    // 1) ENAMETOOLONG must be GONE (the whole point of the fix): scan the WF03 execution +
    //    n8n.log. spawn_enametoolong=false proves the temp-file transport replaced --data-raw.
    let logText = '';
    try { const lp = path.join(userSupportDir(), 'logs', 'launcher', 'n8n.log'); if (fs.existsSync(lp)) logText = fs.readFileSync(lp, 'utf8'); } catch {}
    report.first_frame_spawn_enametoolong = /ENAMETOOLONG/i.test(text) || /ENAMETOOLONG/i.test(logText);
    // 2) method + payload size from the node's REDACTED sidecar (no body, no key).
    try {
      const sc = path.join(userSupportDir(), 'workflow-data', '.n8n-local-cache', '.firstframe-upload-diag.json');
      if (fs.existsSync(sc)) {
        const j = JSON.parse(fs.readFileSync(sc, 'utf8'));
        report.first_frame_upload_attempted = Boolean(j.attempted);
        report.first_frame_upload_method = j.method ? String(j.method).slice(0, 40) : null;
        report.first_frame_payload_size_bytes = Number.isFinite(j.payload_size_bytes) ? j.payload_size_bytes : null;
      }
    } catch {}
    // 3) upload outcome (attempted/http/url) derived from the WF03 execution (redacted).
    if (report.first_frame_upload_attempted == null) report.first_frame_upload_attempted = /Kie首帧图上传|首帧/.test(text) || /Kie首帧图上传|首帧/.test(logText);
    const um = text.match(/Kie首帧图上传[^]{0,80}?HTTP (\d{3})/);
    if (um) report.first_frame_upload_http_status = Number(um[1]);
    const urlPresent = /"(?:downloadUrl|download_url|fileUrl|file_url|url|publicUrl|public_url)"\s*:\s*"https?:\/\//.test(text);
    report.first_frame_uploaded_url_present = urlPresent || null;
    // succeeded = no enametoolong + a URL present (or the run progressed past upload to Veo).
    const uploadFailed = /Kie首帧图上传 连续重试失败|spawn ENAMETOOLONG/i.test(text) || report.first_frame_spawn_enametoolong === true;
    report.first_frame_upload_succeeded = uploadFailed ? false : (urlPresent || report.video_model_called === true ? true : null);
    if (uploadFailed) {
      const fm = text.match(/Kie首帧图上传[^]{0,120}/); if (fm) report.first_frame_upload_response_redacted_summary = redactString(fm[0]).slice(0, 160);
    }
    // ── B8AO: the Veo status-poll node must read the SAME unified Kie key. "缺少 Kie API
    // Key" here = the poll node's config-path couldn't see the key (the bug being fixed).
    report.veo_status_poll_missing_key = /缺少 Kie API Key/.test(report.video_error_message || '') || /缺少 Kie API Key/.test(text);
    try {
      const cs = configSummary();
      report.veo_status_poll_config_path_used = cs.config_path || null;
      report.veo_status_poll_config_file_exists = Boolean(cs.exists);
      report.veo_status_poll_config_key_present = Boolean(cs.key_present);
    } catch {}
  } catch {}
}

// Generate exactly ONE clip: write the 1-shot cap marker, click the real "确认分镜图 →
// 开始生成视频" button, wait for the single new mp4 to land, verify it. final-merge /
// export are NEVER triggered (and the interceptor still aborts them).
async function runMinimalVideo(report, page, uiBase, apiKey) {
  if (report.review_panel_image_present !== true) { report.video_skipped_reason = 'review_panel_missing_before_video'; return; }
  // 1) test-only cap marker WF03 reads (production never writes this → no cap).
  const capDir = path.join(userSupportDir(), 'workflow-data', '.n8n-local-cache');
  try { fs.mkdirSync(capDir, { recursive: true }); fs.writeFileSync(path.join(capDir, '.smoke-max-shots'), String(report.max_shots || 1)); report.video_cap_file_written = true; }
  catch (e) { report.video_cap_file_written = false; report.video_error_message = redactString(String(e.message || e)).slice(0, 200); }
  // 2) snapshot existing clips so we detect the NEW one (not a stale file).
  const vDir = videoCacheDir();
  const before = new Set();
  try { if (fs.existsSync(vDir)) for (const f of fs.readdirSync(vDir)) if (/\.mp4$/i.test(f)) before.add(f); } catch {}
  // 3) click the REAL generate button (form action=/review-submit, NOT the 重做 form).
  const submitResp = page.waitForResponse((r) => /\/review-submit\b/.test(r.url()) && r.request().method() === 'POST', { timeout: 60000 });
  const clicked = await page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form[action="/review-submit"]'));
    const genForm = forms.find((f) => !Array.from(f.querySelectorAll('input[name="review_decision"]')).some((i) => i.value === '重做'));
    const btn = genForm && genForm.querySelector('button[type="submit"]');
    if (btn) { try { btn.removeAttribute('onclick'); } catch {} btn.click(); return true; }
    return false;
  }).catch(() => false);
  if (!clicked) { report.video_skipped_reason = 'video_button_or_ui_action_missing'; return; }
  report.video_generation_attempted = true;
  report.stages.push('video_generation_attempted');
  const sResp = await submitResp.catch(() => null);
  report.video_submit_status = sResp ? sResp.status() : null;
  // 4) wait for the SINGLE new clip (Veo is slow; cap=1 keeps it to one generation). The
  // wait is bounded by VIDEO_WAIT_MS and ends well before the overall watchdog, so the
  // diagnostics below ALWAYS run (the report never ends with all-null video fields).
  const deadline = Date.now() + VIDEO_WAIT_MS;
  let newClip = null;
  while (Date.now() < deadline) {
    if (report.forbidden_requests_blocked.length > 0) break;
    try {
      if (fs.existsSync(vDir)) {
        const fresh = fs.readdirSync(vDir).filter((f) => /\.mp4$/i.test(f)).find((f) => !before.has(f));
        if (fresh) { const p = path.join(vDir, fresh); try { if (fs.statSync(p).size > 0) { newClip = p; break; } } catch {} }
      }
    } catch {}
    await sleep(8000);
  }
  if (!newClip && Date.now() >= deadline) report.video_wait_timed_out = true;
  // 5) redacted WF03 execution diagnostics (model called / http / error / task status).
  try { collectVideoDiagnostics(report); report.video_diagnostics_collected = true; } catch {}
  if (!newClip) {
    // Distinguish "Veo accepted, still processing" from "never called" / "no file".
    report.video_skipped_reason = report.video_skipped_reason
      || (report.video_wait_timed_out && (report.video_model_called === true || report.latest_video_task_status) ? 'video_api_called_but_still_processing' : 'video_file_not_saved');
    return;
  }
  // 6) verify the single clip.
  report.video_clip_path = newClip;
  report.video_clip_file_exists = true;
  report.video_model_called = true; // a clip on disk implies the Veo call happened
  try { report.video_clip_size_bytes = fs.statSync(newClip).size; } catch {}
  report.video_clip_duration = readMp4DurationSec(newClip);
  const allowedRoot = path.resolve(vDir) + path.sep;
  report.video_save_path_allowed = path.resolve(newClip).startsWith(allowedRoot);
  report.video_clip_generated = (report.video_clip_size_bytes || 0) > 0 && report.video_save_path_allowed === true;
  if (report.video_clip_generated) report.stages.push('video_clip_generated');
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
  // Stop-proof invariant: final-merge is ALWAYS not-called (no scope ever triggers it).
  // In image_only, video / Veo are likewise ALWAYS reported skipped/not-called (the
  // interceptor aborts any attempt; the attempt is recorded in forbidden_requests_blocked
  // and fails the run separately). In minimal_video the video fields reflect what the
  // single-clip flow actually observed and are NOT overwritten here.
  report.final_merge_not_called = true;
  report.final_merge_called = report.final_merge_called === true; // never set true by us
  if (!VIDEO_AUTHORIZED) {
    report.video_generation_skipped = true;
    report.veo_not_called = true;
    report.stages.push('video_skipped');
  } else {
    report.video_generation_skipped = report.video_clip_generated !== true;
    report.veo_not_called = report.video_model_called !== true;
    report.stages.push(report.video_clip_generated ? 'video_clip_generated' : 'video_not_generated');
  }
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
  if (MODE === 'full' && !apiKey) { fail('api_key_missing', new Error('AI_VIDEO_API_KEY is required for full mode'), apiKey); return; }
  if (NO_PAID_FULL && process.env.AI_VIDEO_NO_PAID_SMOKE !== '1') {
    fail('no_paid_smoke_env_missing', new Error('no_paid_full requires AI_VIDEO_NO_PAID_SMOKE=1'), apiKey);
    return;
  }

  // Hard overall watchdog — never hang to the GitHub job timeout. B8AM: if a video clip
  // was being generated when the cap hit, collect the video diagnostics FIRST (so the
  // report never ends with all-null video fields) and classify the timeout precisely.
  const watchdog = setTimeout(() => {
    if (VIDEO_AUTHORIZED && report.video_generation_attempted) {
      report.video_wait_timed_out = true;
      try { collectVideoDiagnostics(report); report.video_diagnostics_collected = true; } catch {}
      let stage = 'overall_timeout';
      if (report.first_frame_spawn_enametoolong === true) stage = 'first_frame_upload_spawn_enametoolong';
      else if (report.video_http_status && report.video_http_status >= 400) stage = 'video_api_failed';
      else if (report.video_model_called === true || report.latest_video_task_status) stage = 'video_api_called_but_still_processing';
      else if (report.video_generation_attempted) stage = 'video_api_not_called';
      report.error_message = report.error_message || `UI smoke exceeded hard cap ${TOTAL_MS}ms (video ${report.latest_video_task_status || 'state unknown'})`;
      fail(stage, new Error(report.error_message), apiKey);
      return;
    }
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
    appRef = await electron.launch({
      executablePath: exe,
      args: [],
      timeout: APP_LAUNCH_MS,
      env: {
        ...process.env,
        AI_VIDEO_NO_PAID_SMOKE: NO_PAID_FULL ? '1' : (process.env.AI_VIDEO_NO_PAID_SMOKE || ''),
      },
    });
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
  // P14-C1: capture the license-gate state once the UI server is up (redacted — never the
  // activation code, never the raw device id, never the API key).
  try { await collectLicenseDiagnostics(report); } catch {}
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

    const conceptReady = await waitForStage(/\/concepts\/item/, 'concept ready (WF01)', 4 * 60 * 1000);
    if (!conceptReady) {
      // B8AB: WF01 may report success yet no concept becomes selectable — capture the
      // UI's own concept view + /active state + concept output count to pinpoint the
      // real cause (empty concept output vs UI-not-rendered vs task-runner timeout).
      try { await collectConceptOutputDiagnostics(report, page, uiBase, since); } catch {}
    }
    if (conceptReady) {
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
          report.review_page_reached = true;
          // B8AH: the storyboard panel previews render as <img loading="lazy"> served
          // over /local-file — so they are NOT loaded the instant we reach the page.
          // FIRST trigger lazy-load (scroll into view + force eager) and WAIT for a panel
          // image to actually finish loading, only THEN judge. Never declare "no image"
          // before the network images have had a chance to load.
          const PANEL_SRC = 'panel_preview_|panel_full_|storyboard|nanobanana|local-file';
          await page.evaluate(() => {
            try {
              for (const im of Array.from(document.images || [])) {
                try { im.loading = 'eager'; im.scrollIntoView({ block: 'center' }); } catch {}
              }
              window.scrollTo(0, document.body.scrollHeight);
            } catch {}
          }).catch(() => {});
          await page.waitForFunction((reSrc) => {
            const PANEL = new RegExp(reSrc, 'i');
            const SKIP = /logo|favicon|\bicon\b|product-|ui-smoke-product/i;
            return Array.from(document.images || []).some((im) => PANEL.test(im.src) && !SKIP.test(im.src) && im.complete && im.naturalWidth > 16);
          }, PANEL_SRC, { timeout: 90000 }).catch(() => {});
          const panel = await page.evaluate((reSrc) => {
            const PANEL = new RegExp(reSrc, 'i');
            const SKIP = /logo|favicon|\bicon\b|product-|ui-smoke-product/i;
            const hit = Array.from(document.images || []).find((im) => PANEL.test(im.src) && !SKIP.test(im.src) && im.naturalWidth > 16);
            return hit ? hit.src : null;
          }, PANEL_SRC).catch(() => null);
          const reviewText = await page.locator('body').innerText().catch(() => '');
          if (panel && /分镜审核|分镜图/.test(reviewText)) {
            report.storyboard_image_generated_via_ui = true;
            report.image_ok = true;
            report.image_url = panel;
            report.review_panel_image_present = true;
            await screenshot(page, '07-storyboard-review.png');
            // B8AH: capture the render diagnostics on SUCCESS too (proves /local-file 200,
            // exact file paths, DOM load) — must NOT flip review_panel_image_present.
            try { await collectReviewRenderDiagnostics(report, page, uiBase); } catch {}
            if (NO_PAID_FULL) {
              const videoResp = page.waitForResponse((r) => /\/review-submit\b/.test(r.url()) && r.request().method() === 'POST', { timeout: 60000 });
              const videoBtn = await firstLocator(page, [
                'form[action="/review-submit"] button.btn-primary',
                'button:has-text("确认分镜图")',
              ]);
              if (!videoBtn) {
                report.errors.push('no_paid_full: review-submit button not found');
              } else {
                await videoBtn.scrollIntoViewIfNeeded().catch(() => {});
                await videoBtn.click();
                const vr = await videoResp.catch(() => null);
                report.no_paid_video_submitted_via_ui = Boolean(vr && vr.status() < 400);
                await page.waitForURL(/\/review-status/, { timeout: 60000 }).catch(() => {});
                const onVideoStatus = /\/review-status/.test(page.url());
                report.no_paid_video_status_reached = onVideoStatus;
                if (onVideoStatus) {
                  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                  await screenshot(page, '08-no-paid-video-status.png');
                  const videoText = await page.locator('body').innerText().catch(() => '');
                  const m = videoText.match(/完成：\s*(\d+)/);
                  report.no_paid_video_completed_count = m ? Number(m[1]) : null;
                  if (!/视频生成状态/.test(videoText) || !(report.no_paid_video_completed_count > 0)) {
                    report.errors.push('no_paid_full: video status page did not show completed fixture clips');
                  }
                } else {
                  report.errors.push('no_paid_full: review-submit did not reach video status page');
                }
              }
            }
          } else {
            report.image_ok = false; report.errors.push('storyboard review reached but no panel image');
            report.review_panel_image_present = false;
            // B8AF/B8AH: review reached but no image — capture WHICH layer failed.
            try { await captureDomSummary(page, 'storyboard-review-no-image-dom.json'); } catch {}
            await screenshot(page, '07b-storyboard-no-image.png');
            try { collectWf02bDiagnostics(report); } catch {}
            try { await collectReviewRenderDiagnostics(report, page, uiBase); } catch {}
          }
        } else {
          report.image_ok = false; report.errors.push('storyboard images did not reach the review page before timeout');
          report.review_page_reached = false;
          report.review_panel_image_present = false;
          try { collectWf02bDiagnostics(report); } catch {}
          try { await collectReviewRenderDiagnostics(report, page, uiBase); } catch {}
        }
      } else { report.image_ok = false; report.errors.push('script-review page / #confirm-script-btn not reached'); }
    } else { report.image_ok = false; report.errors.push('WF01 concept did not become selectable before timeout'); }
  } catch (e) {
    try { collectWf01BinaryDiagnostics(report); } catch {}
    try { collectWf01ExecutionDiagnostics(report); } catch {}
    try { collectTaskRunnerDiagnostics(report); } catch {}
    fail('ui_pipeline', e, apiKey);
    return;
  }

  // ── FULL-mode verdict ───────────────────────────────────────────────────────
  // B8V: now that WF01 has executed (succeeded or failed), capture its product-image
  // binary presence so a storyboard miss can be traced to upload/binary, not config.
  // B8X1: also capture the WF01 execution id / last node / stored error / http /
  // task-runner rejection (all redacted) so the cause is hard data, not inference.
  try { collectWf01BinaryDiagnostics(report); } catch (e) { report.binary_restore_error = report.binary_restore_error || redactString(String(e.message || e)).slice(0, 200); }
  try { collectWf01ExecutionDiagnostics(report); } catch {}
  try { collectTaskRunnerDiagnostics(report); } catch {}
  // B8AF: if the front half passed but the storyboard image didn't, capture WF02B.
  if (report.script_confirmed_via_ui && !report.storyboard_image_generated_via_ui && !report.wf02b_diagnostics) {
    try { collectWf02bDiagnostics(report); } catch {}
  }
  const storyboardOk = report.storyboard_image_generated_via_ui === true && report.image_ok === true;

  // ── B8AJ0: minimal_video continuation (EXACTLY one clip) ──────────────────────
  if (VIDEO_AUTHORIZED) {
    // In minimal_video the video triggers are NOT forbidden; only a final-merge/export
    // attempt would be in forbidden_requests_blocked — which fails the run below.
    if (!storyboardOk) {
      report.error_message = report.error_message || 'storyboard not ready before video';
      fail('storyboard_ready_restore_failed', new Error(report.error_message), apiKey); return; // B
    }
    if (report.review_panel_image_present !== true) {
      fail('review_panel_missing_before_video', new Error('review panel image missing before video'), apiKey); return; // C
    }
    try { await runMinimalVideo(report, page, uiBase, apiKey); }
    catch (e) { report.video_error_message = report.video_error_message || redactString(String(e.message || e)).slice(0, 300); }
    // Safety net: a final-merge / export must NEVER have fired.
    if (report.forbidden_requests_blocked.length > 0) {
      const f = report.forbidden_requests_blocked.join(' ');
      if (/final-merge|mergeWithAudio/i.test(f)) { report.final_merge_called = true; fail('final_merge_unexpectedly_called', new Error('final-merge fired during minimal_video'), apiKey); return; } // K
      if (/export/i.test(f)) { report.export_called = true; fail('export_unexpectedly_called', new Error('export fired during minimal_video'), apiKey); return; } // L
      fail('forbidden_request', new Error('forbidden request during minimal_video'), apiKey); return;
    }
    if (report.video_clip_generated === true && report.video_clip_file_exists === true
        && report.final_merge_called === false && report.export_called === false) {
      report.status = 'passed';
      report.stopped_at = 'minimal_video_one_clip_generated';
      console.log('[ui-smoke] PASS: one video clip generated (no final-merge, no export).');
      finalize(0, apiKey); return;
    }
    // Classify the minimal_video failure. B8AK: the first-frame upload (pre-Veo) is
    // distinguished from the Veo call. B8AM: a clip still generating at the wait deadline
    // is "called but still processing", NOT "not called" / "no file".
    let stage = report.video_skipped_reason || 'video_file_not_saved';
    if (['review_panel_missing_before_video', 'video_button_or_ui_action_missing', 'video_api_called_but_still_processing'].includes(stage)) { /* keep — already classified */ }
    else if (report.first_frame_spawn_enametoolong === true) stage = 'first_frame_upload_spawn_enametoolong'; // B8AK-A (the bug being fixed)
    else if (report.first_frame_upload_succeeded === false && report.first_frame_upload_http_status && report.first_frame_upload_http_status >= 400) stage = 'first_frame_upload_http_failed'; // B8AK-B
    else if (report.first_frame_upload_succeeded === false && report.first_frame_uploaded_url_present === false) stage = 'first_frame_uploaded_url_missing'; // B8AK-D
    else if (report.video_http_status && report.video_http_status >= 400) stage = 'video_api_failed'; // F
    else if (report.video_generation_attempted && report.video_model_called === false && report.video_clip_file_exists === false) stage = 'video_api_not_called'; // E
    else if (report.video_clip_file_exists === true && report.video_save_path_allowed === false) stage = 'video_path_not_allowed'; // I
    else if (report.video_clip_file_exists === true && report.video_clip_generated === false) stage = 'video_file_saved_but_ui_not_rendered'; // J
    else stage = 'video_file_not_saved'; // H
    report.error_message = report.error_message || report.video_error_message || 'minimal video clip was not generated';
    fail(stage, new Error(report.error_message), apiKey); return;
  }

  if (NO_PAID_FULL) {
    if (report.forbidden_requests_blocked.length > 0) { fail('forbidden_request', new Error('forbidden paid/video request attempted during no_paid_full'), apiKey); return; }
    if (storyboardOk && report.no_paid_video_submitted_via_ui === true && report.no_paid_video_status_reached === true && report.no_paid_video_completed_count > 0) {
      report.status = 'passed';
      report.stopped_at = 'no_paid_full_video_status';
      report.video_generation_skipped = true;
      report.veo_not_called = true;
      console.log('[ui-smoke] PASS: no-paid full UI flow reached video status with local fixture clips.');
      finalize(0, apiKey);
      return;
    }
    report.error_message = report.error_message || 'no_paid_full did not reach the mocked video status page';
    fail('no_paid_full_video_status_not_reached', new Error(report.error_message), apiKey);
    return;
  }

  // ── image_only verdict (default — unchanged) ──────────────────────────────────
  if (report.forbidden_requests_blocked.length > 0) { fail('forbidden_request', new Error('forbidden video/Veo request attempted'), apiKey); return; }
  if (storyboardOk) {
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
