#!/usr/bin/env node
// P14-B8: Windows UI-DRIVEN image-only smoke.
//
// Drives the REAL AI Video.exe Electron window via Playwright — it does NOT write
// config files directly or call backend HTTP endpoints to stand in for the user.
// The flow mimics a real user:
//   1. launch AI Video.exe and wait for the workbench window
//   2. open the in-app config page, type the API Key, click 保存配置
//   3. reload the config page and read the "已配置" badge from the DOM
//   4. read the output folder shown in the UI
//   5. open the in-app /system page and read WF01/WF02/WF02a/WF02b/WF03 status
//   6. run the full image-only pipeline through the UI: submit the creative-brief
//      form (uploads a sample image) → WF01 创意方向 → select a direction → wait for
//      scriptGenerateV1 → confirm the script → storyboardGenerateV1 (Nano) →
//      verify the storyboard/Nano image on the /reviews/item page, then STOP
//      before video — never proceeds to Veo / video generation.
//
// Safety: Veo / video generation / final-merge / review-submit / review-rerun-shot
// are blocked three ways: (a) smoke-guard scope assertions at startup, (b) the
// smoke never clicks any video/submit affordance, (c) a renderer network
// interceptor that ABORTS and FAILS the run on any forbidden request.
//
// Secrets: AI_VIDEO_API_KEY is read from env (GitHub Secret) and typed into the
// password field. It is never logged, never written to the report, never copied
// into diagnostics. Config/log diagnostics are redacted before upload.

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
import { fileURLToPath } from 'node:url';
import { redactObject, redactString } from '../../app-server/shared/redact.mjs';

// Expose guard stubs so they are importable; calling them intentionally blocks the op.
export { guardFinalMerge, guardReviewRerunShot, guardReviewSubmit, guardReviewSubmitVeoV2, guardVeo, guardVideoGeneration };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGE_ARG = process.argv[2];
const STAGE = STAGE_ARG
  ? path.resolve(STAGE_ARG)
  : path.join(ROOT, 'dist-win', 'AI-Video-Win-x64-Portable-RC-0001');

const REPORT_PATH = path.join(ROOT, 'smoke-report.json');
const DIAG_DIR = path.join(ROOT, 'smoke-diagnostics');
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

// Minimal dependency-free PNG encoder: a solid WxH RGB image. Used as the
// "product image" upload so the creative-brief form can be submitted via the UI.
function makeSolidPng(w, h, [r, g, b]) {
  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c;
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── Diagnostics export (redacted) ─────────────────────────────────────────────
function exportRedactedDiagnostics(report, requestLog) {
  try {
    // 1. Redacted config snapshot — NEVER copy the raw local-config.json.
    const cfgPath = path.join(userSupportDir(), 'config', 'local-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      fs.writeFileSync(path.join(DIAG_DIR, 'local-config.redacted.json'), JSON.stringify(redactObject(parsed), null, 2));
    }
  } catch (e) { report.errors.push(`diag config: ${e.message}`); }

  try {
    // 2. Launcher / n8n logs, redacted line-by-line (belt-and-suspenders).
    const logDir = path.join(userSupportDir(), 'logs', 'launcher');
    if (fs.existsSync(logDir)) {
      const outDir = path.join(DIAG_DIR, 'logs');
      fs.mkdirSync(outDir, { recursive: true });
      for (const f of fs.readdirSync(logDir)) {
        if (!/\.log$/i.test(f)) continue;
        const raw = fs.readFileSync(path.join(logDir, f), 'utf8');
        const tail = raw.split('\n').slice(-200).join('\n');
        fs.writeFileSync(path.join(outDir, f), redactString(tail));
      }
    }
  } catch (e) { report.errors.push(`diag logs: ${e.message}`); }

  try {
    // 3. Renderer request audit — origin + pathname only, no query, no headers.
    fs.writeFileSync(path.join(DIAG_DIR, 'renderer-requests.txt'), [...new Set(requestLog)].sort().join('\n'));
  } catch (e) { report.errors.push(`diag requests: ${e.message}`); }

  try {
    // 4. Generated-image summary (paths/urls only).
    fs.writeFileSync(path.join(DIAG_DIR, 'image-summary.json'), JSON.stringify({
      image_ok: report.image_ok,
      image_url: report.image_url,
      output_dir: report.output_dir,
    }, null, 2));
  } catch (e) { report.errors.push(`diag image: ${e.message}`); }
}

async function screenshot(page, name) {
  try { await page.screenshot({ path: path.join(SHOTS_DIR, name), fullPage: true }); } catch {}
}

// Wait until the Electron window has navigated from the data: splash to the
// http workbench and the DOM is ready.
async function waitForWorkbench(app, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let page = null;
  while (Date.now() < deadline) {
    try {
      page = await app.firstWindow({ timeout: 5000 });
      const url = page.url();
      if (/^https?:\/\/127\.0\.0\.1:\d+/.test(url)) {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        return page;
      }
    } catch {}
    await sleep(2000);
  }
  return page;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const report = {
    scope: 'image_only',
    ui_driven: true,
    real_smoke_scope: process.env.REAL_SMOKE_SCOPE,
    disable_video_generation: process.env.DISABLE_VIDEO_GENERATION,
    timestamp: new Date().toISOString(),
    window_loaded: false,
    api_key_saved_via_ui: false,
    configured_reported_by_ui: false,
    output_dir: null,
    output_dir_confirmed: false,
    workflow_presence: { WF01: false, WF02: false, WF02a: false, WF02b: false, WF03: false },
    workflow_presence_all: false,
    // Full image-only UI pipeline milestones (each driven through the window):
    brief_submitted_via_ui: false,        // creative-brief form -> WF01 concept
    concept_ready_via_ui: false,          // WF01 concept directions generated
    concept_selected_via_ui: false,       // /concept-select-with-edit -> scriptGenerateV1
    script_generated_via_ui: false,       // scriptGenerateV1 produced the script
    script_confirmed_via_ui: false,       // /script-confirm -> storyboardGenerateV1 (Nano)
    storyboard_image_generated_via_ui: false, // Nano storyboard images on review page
    image_ok: null,                       // == storyboard_image_generated_via_ui
    image_url: null,                      // a storyboard/Nano panel src (NOT the upload)
    // B8 stop-proof fields — we stop at the storyboard image, before any video.
    video_generation_skipped: true,
    veo_not_called: true,
    final_merge_not_called: true,
    stopped_at: 'storyboard_ready_for_review',
    forbidden_requests_blocked: [],
    stages: [],
    errors: [],
  };

  const apiKey = (process.env.AI_VIDEO_API_KEY || '').trim();
  if (!apiKey) {
    report.errors.push('AI_VIDEO_API_KEY is not set');
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.error('[ui-smoke] FAIL: AI_VIDEO_API_KEY is required (set via GitHub Secret)');
    process.exit(1);
  }
  console.log('[ui-smoke] AI_VIDEO_API_KEY present (value hidden)');

  const exe = path.join(STAGE, 'AI Video.exe');
  if (!fs.existsSync(exe)) {
    report.errors.push(`AI Video.exe not found at ${exe}`);
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.error(`[ui-smoke] FAIL: AI Video.exe not found at ${exe}`);
    process.exit(1);
  }

  const { _electron: electron } = await import('playwright');
  const requestLog = [];
  let app = null;

  // Fail the whole run hard if a forbidden (video-leading) request is observed.
  function tripForbidden(url) {
    const clean = url.replace(/[?#].*$/, '');
    report.forbidden_requests_blocked.push(clean);
    report.veo_not_called = false;
    report.video_generation_skipped = false;
    console.error(`[ui-smoke] BLOCKED forbidden request: ${clean}`);
  }

  try {
    app = await electron.launch({ executablePath: exe, args: [], timeout: 120000 });

    // Renderer-level guard: inspect every request the window makes.
    await app.context().route('**/*', async (route) => {
      const url = route.request().url();
      if (FORBIDDEN_REQUEST.some((rx) => rx.test(url))) {
        tripForbidden(url);
        try { await route.abort(); } catch {}
        return;
      }
      try { await route.continue(); } catch {}
    });
    app.context().on('request', (req) => {
      try { const u = new URL(req.url()); requestLog.push(u.origin + u.pathname); } catch {}
    });

    const page = await waitForWorkbench(app);
    if (!page || !/^https?:\/\/127\.0\.0\.1:\d+/.test(page.url())) {
      throw new Error('workbench window did not load (still on splash/blank after timeout)');
    }
    report.window_loaded = true;
    report.stages.push('window_loaded');
    // Auto-accept the in-app confirm() dialogs (concept select / script confirm).
    page.on('dialog', (d) => { d.accept().catch(() => {}); });
    const uiBase = new URL(page.url()).origin;
    await screenshot(page, '01-workbench.png');

    // ── Step 2: type API Key in the UI and save ───────────────────────────────
    await page.goto(`${uiBase}/config`, { waitUntil: 'domcontentloaded' });
    const keyInput = page.locator('input[data-path="providers.kie.api_key"]');
    await keyInput.waitFor({ state: 'visible', timeout: 30000 });
    await keyInput.fill(apiKey); // typed into a type=password field; never logged
    const saveResp = page.waitForResponse(
      (r) => r.url().includes('/config-save') && r.request().method() === 'POST',
      { timeout: 30000 },
    );
    await page.locator('#save-btn').click();
    const resp = await saveResp;
    report.api_key_saved_via_ui = resp.status() === 200;
    report.stages.push('config_saved_via_ui');

    // ── Step 3: reload config page and read the "已配置" badge from the DOM ─────
    // After reload the key field re-renders empty (value=""), so the screenshot
    // below cannot contain the secret.
    await page.goto(`${uiBase}/config`, { waitUntil: 'domcontentloaded' });
    const cfgText = await page.locator('body').innerText();
    report.configured_reported_by_ui = /已配置/.test(cfgText);
    // ── Step 4: read the output folder shown in the UI ────────────────────────
    report.output_dir = await page.locator('#output-base-display').first().innerText().catch(() => null);
    report.output_dir_confirmed = Boolean(report.output_dir && report.output_dir.trim());
    report.stages.push('configured_verified_via_ui');
    await screenshot(page, '02-config-configured.png');

    // ── Step 5: read WF presence from the in-app /system page ──────────────────
    await page.goto(`${uiBase}/system`, { waitUntil: 'domcontentloaded' });
    const sysText = await page.locator('body').innerText();
    for (const label of ['WF01', 'WF02', 'WF02a', 'WF02b', 'WF03']) {
      const missing = new RegExp(`${label}[^\\n]*未找到`).test(sysText);
      report.workflow_presence[label] = sysText.includes(label) && !missing;
    }
    report.workflow_presence_all =
      Object.values(report.workflow_presence).every(Boolean) && !sysText.includes('部分工作流未找到');
    report.stages.push('workflow_presence_via_ui');
    await screenshot(page, '03-system-workflows.png');

    // ── Step 6a: submit the creative-brief form → WF01 创意方向 (concept) ───────
    await page.goto(`${uiBase}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="field-0"]').fill('Smoke Test Product — white circle on blue');
    const samplePng = path.join(os.tmpdir(), `ui-smoke-product-${Date.now()}.png`);
    fs.writeFileSync(samplePng, makeSolidPng(256, 256, [60, 120, 220]));
    await page.locator('input[name="field-5"]').setInputFiles(samplePng);
    await page.locator('#product-submit-button').click();
    // The server redirects to /submitted?since=<server-timestamp>; that timestamp
    // is the authoritative filter for /active stage routing.
    await page.waitForURL(/\/submitted/, { timeout: 60000 }).catch(() => {});
    let since = '0';
    try { since = new URL(page.url()).searchParams.get('since') || '0'; } catch {}
    report.brief_submitted_via_ui = true;
    report.stages.push('brief_submitted_via_ui');
    await screenshot(page, '04-brief-submitted.png');

    // Navigate to the current stage via /active (UI-truth router). Returns the
    // landed URL after following the 302 to the active stage page.
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
        if (/生成失败|脚本框架生成失败|分镜图生成失败/.test(body)) {
          report.errors.push(`${label}: UI reports generation failed`);
          return false;
        }
        console.log(`[ui-smoke] waiting for ${label} … now at ${new URL(url).pathname}`);
        await sleep(8000);
      }
      report.errors.push(`${label}: timed out`);
      return false;
    }

    // ── Step 6b: wait for WF01 concept, then SELECT a direction (→ scriptGenerateV1) ──
    if (await waitForStage(/\/concepts\/item/, 'concept ready (WF01)', 8 * 60 * 1000)) {
      report.concept_ready_via_ui = true;
      report.stages.push('concept_ready_via_ui');
      await screenshot(page, '05-concept-ready.png');
      const projectId = await page.locator('input[name="project_id"]').first().inputValue().catch(() => '');
      const selResp = page.waitForResponse((r) => r.url().includes('/concept-select-with-edit'), { timeout: 60000 });
      // Clicking this formaction button submits the concept's form (a confirm()
      // dialog is auto-accepted) → scriptGenerateV1 begins.
      await page.locator('button[formaction="/concept-select-with-edit"]').first().click();
      const sr = await selResp.catch(() => null);
      report.concept_selected_via_ui = Boolean(sr && sr.status() < 400);
      report.stages.push('concept_selected_via_ui');

      // ── Step 6c: wait for scriptGenerateV1, then CONFIRM script (→ storyboardGenerateV1) ──
      const onScript = await waitForStage(/\/script-review/, 'script generated (scriptGenerateV1)', 8 * 60 * 1000);
      const hasConfirm = onScript && await page.locator('#confirm-script-btn').count().then((n) => n > 0).catch(() => false);
      if (hasConfirm) {
        report.script_generated_via_ui = true;
        report.stages.push('script_generated_via_ui');
        await screenshot(page, '06-script-ready.png');
        const confResp = page.waitForResponse((r) => r.url().includes('/script-confirm'), { timeout: 60000 });
        await page.locator('#confirm-script-btn').click(); // confirm() auto-accepted
        const cr = await confResp.catch(() => null);
        report.script_confirmed_via_ui = Boolean(cr && cr.status() < 400);
        report.stages.push('script_confirmed_via_ui');

        // ── Step 6d: wait for storyboardGenerateV1 (Nano) → /reviews/item ──────
        // The /storyboard-status page polls and redirects to /reviews/item when the
        // Nano storyboard images are ready. Nano generation can take several minutes.
        await page.waitForURL(/\/storyboard-status/, { timeout: 60000 }).catch(() => {});
        const onReview = await page.waitForURL(/\/reviews\/item/, { timeout: 12 * 60 * 1000 }).then(() => true).catch(() => false);
        const url = page.url();
        if (onReview || /\/reviews\/item/.test(url)) {
          // Verify the storyboard/Nano IMAGE is present — must be a panel product,
          // not the uploaded product image / logo / icon.
          const panel = await page.evaluate(() => {
            const PANEL = /panel_preview_|panel_full_|storyboard|nanobanana|review_context/i;
            const SKIP = /logo|favicon|\bicon\b|product-|ui-smoke-product/i;
            const imgs = Array.from(document.images || []);
            const hit = imgs.find((im) => PANEL.test(im.src) && !SKIP.test(im.src) && im.naturalWidth > 16);
            return hit ? hit.src : null;
          }).catch(() => null);
          const reviewText = await page.locator('body').innerText().catch(() => '');
          const reviewSignals = /分镜审核|分镜图/.test(reviewText);
          if (panel && reviewSignals) {
            report.storyboard_image_generated_via_ui = true;
            report.image_ok = true;
            report.image_url = panel;
            report.stopped_at = 'storyboard_ready_for_review';
            console.log('[ui-smoke] Nano storyboard image present on the review page');
            await screenshot(page, '07-storyboard-review.png');
          } else {
            report.image_ok = false;
            report.errors.push(`storyboard review reached but no panel image (panel=${Boolean(panel)}, signals=${reviewSignals})`);
          }
        } else {
          report.image_ok = false;
          report.errors.push('storyboard images did not reach the review page before timeout');
        }
      } else {
        report.image_ok = false;
        report.errors.push('script-review page / #confirm-script-btn not reached');
      }
    } else {
      report.image_ok = false;
      report.errors.push('WF01 concept did not become selectable before timeout');
    }
    // Image-only run STOPS here. We never click 确认审核 / 生成视频 / 重新生成分镜图.
    report.stages.push('storyboard_image_generation');
  } catch (e) {
    report.errors.push(`ui-smoke error: ${e.message}`);
    console.error(`[ui-smoke] error: ${e.message}`);
  } finally {
    // We never proceeded to video/Veo/final-merge — record and prove it.
    report.stages.push('video_skipped');
    if (report.forbidden_requests_blocked.length > 0) {
      report.final_merge_not_called = false;
    }
    try { if (app) await app.close(); } catch {}
    exportRedactedDiagnostics(report, requestLog);
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`[ui-smoke] Report → ${REPORT_PATH}`);
    console.log('[ui-smoke] Summary:', JSON.stringify({
      ui_driven: report.ui_driven,
      window_loaded: report.window_loaded,
      api_key_saved_via_ui: report.api_key_saved_via_ui,
      configured_reported_by_ui: report.configured_reported_by_ui,
      workflow_presence_all: report.workflow_presence_all,
      concept_selected_via_ui: report.concept_selected_via_ui,
      script_confirmed_via_ui: report.script_confirmed_via_ui,
      storyboard_image_generated_via_ui: report.storyboard_image_generated_via_ui,
      stopped_at: report.stopped_at,
      forbidden_blocked: report.forbidden_requests_blocked.length,
      errors: report.errors.length,
    }));
  }

  // Any forbidden request fails the run outright.
  if (report.forbidden_requests_blocked.length > 0) {
    console.error('[ui-smoke] FAIL: forbidden video/Veo request was attempted.');
    process.exit(1);
  }
  if (!report.window_loaded || !report.api_key_saved_via_ui || !report.configured_reported_by_ui) {
    console.error('[ui-smoke] FAIL: UI configuration flow incomplete.');
    process.exit(1);
  }
  // Success requires the FULL image-only pipeline through the UI, ending with the
  // Nano storyboard image on the review page — not merely the WF01 concept.
  if (!report.concept_selected_via_ui || !report.script_confirmed_via_ui || report.storyboard_image_generated_via_ui !== true || report.image_ok !== true) {
    console.error('[ui-smoke] FAIL: storyboard/Nano image was not generated through the UI pipeline.');
    process.exit(1);
  }
  console.log('[ui-smoke] PASS: UI-driven image-only smoke complete (stopped at storyboard review, no video).');
}

main().catch((e) => {
  console.error('[ui-smoke] Fatal:', e.message);
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify({
      scope: 'image_only',
      ui_driven: true,
      timestamp: new Date().toISOString(),
      stopped_at: 'storyboard_ready_for_review',
      video_generation_skipped: true,
      veo_not_called: true,
      final_merge_not_called: true,
      error: e.message,
    }, null, 2));
  } catch {}
  process.exit(1);
});
