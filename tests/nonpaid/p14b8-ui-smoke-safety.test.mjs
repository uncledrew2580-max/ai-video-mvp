// P14-B8 nonpaid tests — UI-driven image-only smoke safety boundaries.
// Verifies: workflow_dispatch only, secrets-only key + masking, image_only scope,
// Veo/video/final/review guards, smoke-report stop-proof fields, redacted
// diagnostics, and UI-DRIVEN semantics (launches AI Video.exe + drives the real
// window, not direct config writes or backend HTTP stand-ins).
// Zero model calls, zero network; runs offline on macOS/Linux/Windows.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'windows-ui-smoke-image-only.yml');
const UI_SCRIPT = path.join(ROOT, 'scripts', 'win', 'ui-smoke-image-only.mjs');
const SMOKE_GUARD = path.join(ROOT, 'scripts', 'win', 'smoke-guard.mjs');

const readWf = () => fs.readFileSync(WORKFLOW, 'utf8');
const readUi = () => fs.readFileSync(UI_SCRIPT, 'utf8');

// ── Workflow trigger / scope ──────────────────────────────────────────────────

test('workflow file exists', () => {
  assert.ok(fs.existsSync(WORKFLOW), `missing ${WORKFLOW}`);
});

test('workflow triggers ONLY on workflow_dispatch (no push/pull_request/schedule)', () => {
  const yml = readWf();
  assert.ok(yml.includes('workflow_dispatch'), 'must have workflow_dispatch trigger');
  assert.ok(!/\n\s*push:/.test(yml), 'must NOT have push: trigger');
  assert.ok(!/\n\s*pull_request:/.test(yml), 'must NOT have pull_request: trigger');
  assert.ok(!/\n\s*schedule:/.test(yml), 'must NOT have schedule: trigger');
});

test('workflow env sets image-only scope', () => {
  const yml = readWf();
  assert.ok(/REAL_SMOKE_SCOPE:\s*image_only/.test(yml), 'must set REAL_SMOKE_SCOPE: image_only');
  assert.ok(/DISABLE_VIDEO_GENERATION:\s*['"]?true['"]?/.test(yml), "must set DISABLE_VIDEO_GENERATION: 'true'");
});

test('workflow reads API key ONLY from GitHub Secrets (no hardcoded value)', () => {
  const yml = readWf();
  assert.ok(yml.includes('secrets.AI_VIDEO_API_KEY'), 'must reference secrets.AI_VIDEO_API_KEY');
  assert.ok(
    !/AI_VIDEO_API_KEY:\s*['"]?[A-Za-z0-9_\-]{8,}['"]?/.test(yml),
    'must NOT contain a hardcoded API key value',
  );
});

test('workflow masks secrets via ::add-mask::', () => {
  assert.ok(readWf().includes('add-mask'), 'workflow must invoke ::add-mask:: to mask secrets');
});

test('workflow does NOT reference Veo/video/final-merge/review endpoints', () => {
  const yml = readWf();
  for (const bad of ['/v1/veo', 'veo/generate', 'reviewSubmitVeoV2', 'final-merge', 'review-submit', 'review-rerun-shot', 'image_to_video']) {
    assert.ok(!yml.includes(bad), `workflow must not reference ${bad}`);
  }
});

test('workflow runs the UI smoke runner and preserves required checks', () => {
  const yml = readWf();
  assert.ok(yml.includes('ui-smoke-image-only.mjs'), 'must run ui-smoke-image-only.mjs');
  assert.ok(!yml.includes('--dry-run'), 'must not permanently pass --dry-run');
  // Preserved required checks (must be present, not skipped).
  for (const keep of [
    'check-client-shape.mjs',
    'check-desktop-shell.mjs',
    'verify-native-modules.mjs',
    'check-n8n-runtime-completeness.mjs',
    'n8n-launch-smoke.mjs',
    'check-smoke-security.mjs',
    'p14b7-windows-config-sqlite.test.mjs',
    'p14-windows-config-init.test.mjs',
    'p14-windows-output-dirs.test.mjs',
    'p14b6-real-smoke-safety.test.mjs',
    'p14b8-ui-smoke-safety.test.mjs',
  ]) {
    assert.ok(yml.includes(keep), `workflow must preserve/call ${keep}`);
  }
});

test('workflow installs Playwright without modifying the lockfile', () => {
  const yml = readWf();
  assert.ok(/npm install --no-save playwright/.test(yml), 'must install playwright with --no-save');
});

test('workflow uploads report + diagnostics (and not raw secrets)', () => {
  const yml = readWf();
  assert.ok(yml.includes('smoke-report.json'), 'must upload smoke-report.json');
  assert.ok(yml.includes('smoke-diagnostics/'), 'must upload smoke-diagnostics/');
});

// ── UI script: syntax + startup guards ────────────────────────────────────────

test('ui-smoke-image-only.mjs passes node --check', () => {
  assert.ok(fs.existsSync(UI_SCRIPT), `missing ${UI_SCRIPT}`);
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', UI_SCRIPT], { stdio: 'pipe' }));
});

test('ui-smoke calls assertImageOnlyScope() and selfTest() at startup', () => {
  const src = readUi();
  assert.ok(src.includes('assertImageOnlyScope()'), 'must call assertImageOnlyScope() unconditionally');
  assert.ok(src.includes('selfTest()'), 'must call selfTest() at startup');
});

// ── UI-DRIVEN semantics (real window, not direct write/call) ──────────────────

test('ui-smoke launches the real AI Video.exe Electron window', () => {
  const src = readUi();
  assert.ok(src.includes('electron.launch'), 'must launch via Playwright electron.launch');
  assert.ok(src.includes('AI Video.exe'), 'must launch the AI Video.exe executable');
  assert.ok(src.includes('firstWindow'), 'must attach to the real app window');
});

test('ui-smoke types the API Key into the real DOM field and clicks Save', () => {
  const src = readUi();
  assert.ok(src.includes('input[data-path="providers.kie.api_key"]'), 'must target the real API Key input');
  assert.ok(/\.fill\(apiKey\)/.test(src), 'must type the key into the field');
  assert.ok(src.includes("'#save-btn'"), 'must click the real 保存配置 button (#save-btn)');
});

test('ui-smoke verifies "已配置" from the DOM, not from the config file', () => {
  const src = readUi();
  assert.ok(src.includes('已配置'), 'must read the 已配置 badge from the UI');
  assert.ok(src.includes('configured_reported_by_ui'), 'report must record configured_reported_by_ui');
});

test('ui-smoke submits the creative-brief form via the UI (uploads an image)', () => {
  const src = readUi();
  assert.ok(src.includes("input[name=\"field-5\"]") || src.includes('field-5'), 'must use the product image file input');
  assert.ok(src.includes('setInputFiles'), 'must upload an image through the file input');
  assert.ok(src.includes('#product-submit-button'), 'must click the real submit button');
});

// ── Full image-only PIPELINE through the UI (Codex P14-B8 review) ─────────────

test('ui-smoke drives the full pipeline: select concept → confirm script → storyboard image', () => {
  const src = readUi();
  // Concept selection (WF01 -> scriptGenerateV1).
  assert.ok(src.includes('/concept-select-with-edit'), 'must select a creative direction via /concept-select-with-edit');
  assert.ok(src.includes('button[formaction="/concept-select-with-edit"]'), 'must click the real concept-select button');
  // Script confirm (scriptGenerateV1 -> storyboardGenerateV1).
  assert.ok(src.includes('#confirm-script-btn'), 'must click the real 确认脚本 button (#confirm-script-btn)');
  assert.ok(src.includes('/script-confirm'), 'must confirm the script via /script-confirm');
  // Storyboard / Nano image readiness on the review page.
  assert.ok(src.includes('/storyboard-status'), 'must go through /storyboard-status');
  assert.ok(src.includes('/reviews/item'), 'storyboard image success must be read from /reviews/item');
});

test('ui-smoke registers a dialog handler that accepts confirm() prompts', () => {
  const src = readUi();
  // Concept select and script confirm both pop a native confirm() — the smoke
  // must auto-accept it or those clicks would hang.
  assert.ok(/page\.on\(\s*['"]dialog['"]/.test(src), 'must register page.on("dialog", ...)');
  assert.ok(/dialog[\s\S]{0,80}\.accept\(/.test(src), 'the dialog handler must accept() the confirm prompt');
});

test('ui-smoke does NOT mark image_ok merely from /submit-product (must reach storyboard)', () => {
  const src = readUi();
  // The success gate must require the storyboard milestone, not the brief submit.
  assert.ok(
    /storyboard_image_generated_via_ui !== true/.test(src) && src.includes('concept_selected_via_ui') && src.includes('script_confirmed_via_ui'),
    'success gate must require concept-select + script-confirm + storyboard image',
  );
  // image_ok must never be set true on the submit/brief step.
  assert.ok(!/brief_submitted_via_ui[\s\S]{0,80}image_ok\s*=\s*true/.test(src),
    'image_ok must not be set true at brief submission');
});

test('ui-smoke image_ok comes from a storyboard/Nano panel, not the uploaded product image', () => {
  const src = readUi();
  // Panel product patterns must drive the image decision.
  assert.ok(/panel_preview_|panel_full_|storyboard|nanobanana|review_context/.test(src),
    'image detection must match storyboard/Nano panel artifacts');
  // The uploaded product image / logos / icons must be excluded.
  assert.ok(/ui-smoke-product|product-|logo|icon|favicon/.test(src),
    'must exclude the uploaded product image / logos / icons from the match');
  // Must NOT use an unfiltered document.images scan as the success signal.
  assert.ok(!/document\.images[\s\S]{0,160}(concept|grid|outputs\?)/.test(src),
    'must not accept any concept/grid/output image as success');
});

test('ui-smoke stopped_at is the storyboard stage (not WF01 concept)', () => {
  const src = readUi();
  assert.ok(src.includes("stopped_at: 'storyboard_ready_for_review'") || src.includes("'storyboard_image_generation'"),
    "stopped_at must be storyboard_ready_for_review / storyboard_image_generation");
  assert.ok(!src.includes("stopped_at: 'image_generation'"), 'must not stop at the ambiguous image_generation (WF01 concept)');
});

test('ui-smoke never actively triggers /review-submit or /review-rerun-shot', () => {
  const src = readUi();
  // 'review-submit' / 'review-rerun-shot' may only appear inside the forbidden
  // guard list — never as an active goto/click/waitForResponse target.
  assert.ok(!/goto\([^)]*review-submit/.test(src), 'must not navigate to /review-submit');
  assert.ok(!/click\([^)]*review-submit/i.test(src), 'must not click a review-submit affordance');
  assert.ok(!/waitForResponse\([^)]*review-submit/.test(src), 'must not await a /review-submit response');
  assert.ok(!/goto\([^)]*review-rerun-shot/.test(src) && !/click\([^)]*review-rerun-shot/i.test(src),
    'must not trigger /review-rerun-shot');
  // And must never click the video / re-generate affordances.
  assert.ok(!/click\([^)]*生成视频/.test(src) && !/click\([^)]*重新生成分镜图/.test(src),
    'must not click 生成视频 / 重新生成分镜图');
});

test('ui-smoke does NOT directly write local-config.json or use raw HTTP to stand in for the UI', () => {
  const src = readUi();
  assert.ok(!/writeFileSync\([^)]*local-config\.json/.test(src), 'must not write local-config.json directly');
  assert.ok(!src.includes('http.request') && !src.includes('https.request'), 'must not POST config via raw HTTP');
  assert.ok(!src.includes("import http") && !src.includes("from 'node:http'"), 'must not import an http client');
});

test('ui-smoke screenshots the config page only AFTER reload (no key in screenshot)', () => {
  const src = readUi();
  const fillIdx = src.indexOf('.fill(apiKey)');
  const reloadIdx = src.indexOf('${uiBase}/config`, { waitUntil: \'domcontentloaded\' }', fillIdx);
  const shotIdx = src.indexOf("'02-config-configured.png'");
  assert.ok(fillIdx > 0 && reloadIdx > fillIdx && shotIdx > reloadIdx,
    'config screenshot must come after the post-save reload so the key field is empty');
});

// ── Forbidden-request interception + guards ───────────────────────────────────

test('ui-smoke intercepts and fails on forbidden video/Veo requests', () => {
  const src = readUi();
  assert.ok(src.includes('FORBIDDEN_REQUEST'), 'must define a forbidden-request list');
  assert.ok(src.includes('route.abort'), 'must abort forbidden requests in the renderer');
  for (const pat of ['veo', 'review-submit', 'review-rerun-shot', 'final-merge', 'image']) {
    assert.ok(new RegExp(pat, 'i').test(src), `forbidden patterns must cover ${pat}`);
  }
  assert.ok(src.includes('forbidden_requests_blocked'), 'report must record blocked forbidden requests');
});

test('ui-smoke imports the scope/forbidden guards from smoke-guard', () => {
  const src = readUi();
  assert.ok(src.includes("from './smoke-guard.mjs'"), 'must import guards from smoke-guard.mjs');
  for (const g of ['guardVeo', 'guardFinalMerge', 'guardReviewSubmit', 'guardReviewRerunShot', 'guardReviewSubmitVeoV2', 'guardVideoGeneration']) {
    assert.ok(src.includes(g), `must import/expose ${g}`);
  }
});

// ── smoke-report stop-proof fields ────────────────────────────────────────────

test('ui-smoke writes smoke-report.json with B8 stop-proof fields', () => {
  const src = readUi();
  assert.ok(src.includes('smoke-report.json'), 'must write smoke-report.json');
  for (const field of [
    'ui_driven',
    'video_generation_skipped',
    'veo_not_called',
    'final_merge_not_called',
    'stopped_at',
    'api_key_saved_via_ui',
    'configured_reported_by_ui',
    'output_dir_confirmed',
    'workflow_presence',
    'forbidden_requests_blocked',
    // Pipeline milestones required by Codex review:
    'concept_selected_via_ui',
    'script_generated_via_ui',
    'script_confirmed_via_ui',
    'storyboard_image_generated_via_ui',
  ]) {
    assert.ok(src.includes(field), `report must include ${field}`);
  }
  assert.ok(src.includes("stopped_at: 'storyboard_ready_for_review'"), "stopped_at must be 'storyboard_ready_for_review'");
  assert.ok(src.includes("'video_skipped'"), "stages must include 'video_skipped'");
});

test('ui-smoke report covers all five workflows WF01..WF03', () => {
  const src = readUi();
  for (const wf of ['WF01', 'WF02', 'WF02a', 'WF02b', 'WF03']) {
    assert.ok(src.includes(wf), `report must check ${wf} presence`);
  }
});

// ── Secret hygiene ────────────────────────────────────────────────────────────

test('ui-smoke never logs the Authorization header value', () => {
  const src = readUi();
  assert.ok(
    !/console\.(log|error|warn|info)\s*\([^)]*Authorization/i.test(src),
    'must not log Authorization header value',
  );
});

test('ui-smoke never prints the raw API key or its length', () => {
  const src = readUi();
  assert.ok(
    !src.includes('console.log(apiKey)') &&
    !src.includes('console.error(apiKey)') &&
    !src.includes('console.log(process.env.AI_VIDEO_API_KEY)') &&
    !src.includes('console.error(process.env.AI_VIDEO_API_KEY)'),
    'must not print the raw API key',
  );
  assert.ok(!src.includes('apiKey.length'), 'must not log apiKey.length (derived secret info)');
});

test('ui-smoke does NOT write the raw API key into the report', () => {
  const src = readUi();
  // Report must never serialize the key. Allow only the presence-derived flag.
  assert.ok(!/report\.[A-Za-z_]+\s*=\s*apiKey\b/.test(src), 'report fields must not be assigned the raw key');
});

// ── Redacted diagnostics ──────────────────────────────────────────────────────

test('ui-smoke exports REDACTED diagnostics (no plaintext config / key)', () => {
  const src = readUi();
  assert.ok(src.includes('redactObject') && src.includes('redactString'), 'must redact config + logs');
  assert.ok(src.includes('local-config.redacted.json'), 'config diagnostics must be the redacted snapshot');
  // Must not copy the raw config file into diagnostics.
  assert.ok(!/copyFileSync\([^)]*local-config\.json/.test(src), 'must not copy raw local-config.json into diagnostics');
  assert.ok(src.includes('renderer-requests.txt'), 'must export a renderer request audit');
});

test('ui-smoke request audit strips query strings (no taskId/secret leakage)', () => {
  const src = readUi();
  assert.ok(src.includes('u.origin + u.pathname'), 'request audit must record origin+pathname only (no query)');
});

// ── smoke-guard is reused, not reimplemented ──────────────────────────────────

test('smoke-guard.mjs passes node --check (shared guard module)', () => {
  assert.ok(fs.existsSync(SMOKE_GUARD), `missing ${SMOKE_GUARD}`);
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', SMOKE_GUARD], { stdio: 'pipe' }));
});
