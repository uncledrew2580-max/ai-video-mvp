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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'windows-ui-smoke-image-only.yml');
const UI_SCRIPT = path.join(ROOT, 'scripts', 'win', 'ui-smoke-image-only.mjs');
const SMOKE_GUARD = path.join(ROOT, 'scripts', 'win', 'smoke-guard.mjs');
const SERVE = path.join(ROOT, '版本测试', 'serve-review-assets.mjs');

const readWf = () => fs.readFileSync(WORKFLOW, 'utf8');
const readUi = () => fs.readFileSync(UI_SCRIPT, 'utf8');
const readServe = () => fs.readFileSync(SERVE, 'utf8');

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

test('workflow installs Playwright without modifying the lockfile (via the retry helper)', () => {
  const yml = readWf();
  assert.ok(/install-playwright-with-retry\.mjs/.test(yml), 'must install playwright via the retry helper');
  const helper = fs.readFileSync(path.join(ROOT, 'scripts', 'win', 'install-playwright-with-retry.mjs'), 'utf8');
  assert.ok(/--no-save/.test(helper), 'the helper must use --no-save (no lockfile change)');
});

test('B8C: workflow defaults to diagnostic mode (no image generation) and passes UI_SMOKE_MODE', () => {
  const yml = readWf();
  assert.ok(/default:\s*'diagnostic'/.test(yml), "mode input must default to 'diagnostic'");
  assert.ok(/UI_SMOKE_MODE:\s*\$\{\{\s*inputs\.mode\s*\}\}/.test(yml), 'must pass inputs.mode as UI_SMOKE_MODE');
});

test('B8C: the smoke step has a backstop timeout so it never hits the 90-min job timeout', () => {
  const yml = readWf();
  assert.ok(/Run UI-driven image-only smoke[\s\S]{0,160}timeout-minutes:\s*\d+/.test(yml),
    'the smoke step must set its own timeout-minutes');
});

test('B8C: nonpaid test step fails fast (pwsh does not swallow intermediate failures)', () => {
  const yml = readWf();
  assert.ok(/\$PSNativeCommandUseErrorActionPreference\s*=\s*\$true/.test(yml),
    'nonpaid step must enable native-command error propagation');
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
  // Storyboard / Nano image readiness on the review page (route may be a regex).
  assert.ok(/storyboard-status/.test(src), 'must go through /storyboard-status');
  assert.ok(/reviews\\?\/item/.test(src), 'storyboard image success must be read from /reviews/item');
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
  // The full-mode success gate must require the storyboard milestone, not the brief.
  assert.ok(
    /storyboard_image_generated_via_ui === true/.test(src) && src.includes('concept_selected_via_ui') && src.includes('script_confirmed_via_ui'),
    'success gate must require the storyboard image milestone',
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
  assert.ok(src.includes("'storyboard_ready_for_review'"),
    "stopped_at must be storyboard_ready_for_review on a full-mode success");
  assert.ok(!src.includes("'image_generation'") && !src.includes('storyboard_image_generation'),
    'must not stop at the ambiguous image_generation (WF01 concept)');
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
  // No raw request() POSTs standing in for a UI action.
  assert.ok(!/http\.request\(/.test(src) && !/https\.request\(/.test(src), 'must not POST via raw http(s).request');
  // http is allowed ONLY for the read-only healthz probe (http.get via httpProbe).
  assert.ok(src.includes('httpProbe') && /http\.get\(/.test(src), 'http may be used only for a GET healthz probe');
  assert.ok(!/(get|request)\([^)]*config-save/.test(src), 'must not hit /config-save over raw http');
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

test('B8C: a blocked Veo/video/final attempt is RECORDED but the stop-proof flags stay TRUE', () => {
  const src = readUi();
  // The three stop-proof flags must NEVER be assigned false anywhere — a blocked
  // (aborted) request means nothing actually executed, so the report must still
  // say video/Veo/final were not called.
  assert.ok(!/video_generation_skipped\s*=\s*false/.test(src), 'video_generation_skipped must never be set false');
  assert.ok(!/veo_not_called\s*=\s*false/.test(src), 'veo_not_called must never be set false');
  assert.ok(!/final_merge_not_called\s*=\s*false/.test(src), 'final_merge_not_called must never be set false');
  // finalize() must re-assert all three true before writing the report.
  assert.ok(/report\.video_generation_skipped = true/.test(src)
    && /report\.veo_not_called = true/.test(src)
    && /report\.final_merge_not_called = true/.test(src),
    'finalize() must keep the stop-proof flags true');
  // The attempt is recorded (and aborted), not used to flip the flags.
  assert.ok(/forbidden_requests_blocked\.push\(/.test(src), 'forbidden attempts must be recorded in forbidden_requests_blocked');
  assert.ok(/route\.abort\(/.test(src), 'forbidden attempts must be aborted');
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
  assert.ok(src.includes("'storyboard_ready_for_review'"), "stopped_at must be 'storyboard_ready_for_review' on full-mode success");
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

// ── P14-B8C: startup diagnostics, fast-fail timeouts, always-write report ─────
import os from 'node:os';

test('B8C: fast-fail budgets are bounded (launch<=60s, workbench<=90s, total<=10min)', () => {
  const src = readUi();
  const num = (name) => {
    const m = src.match(new RegExp(`const ${name} = ([^;]+);`));
    assert.ok(m, `${name} must be defined`);
    // eslint-disable-next-line no-eval
    return Function(`"use strict";return (${m[1]})`)();
  };
  assert.ok(num('APP_LAUNCH_MS') <= 60_000, 'app launch timeout must be <= 60s');
  assert.ok(num('WORKBENCH_MS') <= 90_000, 'workbench-ready timeout must be <= 90s');
  assert.ok(num('TOTAL_MS') <= 10 * 60_000, 'overall hard cap must be <= 10min');
});

test('B8C: a hard overall watchdog forces a failure + exit', () => {
  const src = readUi();
  assert.ok(/setTimeout\(\(\)\s*=>\s*\{[\s\S]*?fail\(\s*['"]overall_timeout/.test(src),
    'must arm a watchdog that fails with overall_timeout');
  assert.ok(/process\.exit\(/.test(src), 'must force process exit');
});

test('B8C: report is ALWAYS written via a single finalize path', () => {
  const src = readUi();
  assert.ok(/function finalize\(/.test(src), 'must have a finalize() that writes the report');
  assert.ok(/writeFileSync\(REPORT_PATH/.test(src), 'finalize must write smoke-report.json');
  assert.ok(/function fail\(/.test(src) && /fail\([^)]*\)/.test(src), 'failures must route through fail() -> finalize()');
});

test('B8C: failure report carries the required startup-diagnostic fields', () => {
  const src = readUi();
  for (const field of [
    'status', 'failed_stage', 'error_message', 'error_stack',
    'app_started', 'window_detected', 'window_title', 'window_url', 'window_state',
    'runtime_healthz', 'n8n_healthz', 'api_key_leaked',
  ]) {
    assert.ok(src.includes(field), `failure report must include ${field}`);
  }
  // The stop-proof safety flags must remain true in failure reports too.
  assert.ok(/video_generation_skipped: true/.test(src) && /veo_not_called: true/.test(src) && /final_merge_not_called: true/.test(src),
    'stop-proof flags must default true');
});

test('B8C: captures window + log + process/port diagnostics (redacted)', () => {
  const src = readUi();
  assert.ok(src.includes('window-diagnostics.json'), 'must write window-diagnostics.json');
  assert.ok(/isVisible/.test(src) && /isClosed/.test(src), 'window diag must record isVisible/isClosed');
  assert.ok(src.includes('process-list.txt') && src.includes('ports-listening.txt'), 'must capture process + port summaries');
  assert.ok(src.includes('electron-stdout.log'), 'must capture the Electron app stdout/stderr');
  assert.ok(/redactString\(/.test(src) && /redactObject\(/.test(src), 'all diagnostics must be redacted');
  assert.ok(/screenshot\(/.test(src), 'must screenshot blank/splash on failure');
});

test('B8C: blank/splash fast-fail kills the AI Video.exe process tree', () => {
  const src = readUi();
  assert.ok(/function killAppTree\(/.test(src), 'must define killAppTree()');
  assert.ok(/taskkill/.test(src), 'must taskkill the Electron process tree on Windows');
  assert.ok(/workbench_load_timeout/.test(src), 'must fail fast on a blank/splash workbench');
});

test('B8C: diagnostic mode is the default and never submits the brief (no generation)', () => {
  const src = readUi();
  assert.ok(/UI_SMOKE_MODE \|\| 'diagnostic'/.test(src), 'default mode must be diagnostic');
  // The brief submission must be gated behind full mode only.
  const briefIdx = src.indexOf('#product-submit-button');
  const fullGateIdx = src.indexOf('if (!FULL)');
  assert.ok(fullGateIdx > 0 && briefIdx > fullGateIdx,
    'the diagnostic-mode early return must come before any brief submission');
  assert.ok(src.includes("status = 'passed_diagnostic'"), 'diagnostic mode must report passed_diagnostic');
});

test('B8C: api-key leak self-check is performed and recorded', () => {
  const src = readUi();
  assert.ok(/function assertNoKeyLeak\(/.test(src), 'must define assertNoKeyLeak()');
  assert.ok(/api_key_leaked = /.test(src), 'must set api_key_leaked from the self-check');
});

// Behavioral: a missing AI Video.exe must FAST-FAIL and still write a complete
// failure report — without Playwright, a real app, network, or any model call.
test('B8C behavioral: missing app → fast fail + failure report + no key leak', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'b8c-out-'));
  const DUMMY = 'dummy-key-ZZZ-not-a-real-secret-0123456789';
  const t0 = Date.now();
  let exitCode = 0;
  try {
    execFileSync(process.execPath, [UI_SCRIPT, path.join(out, 'no-such-stage')], {
      env: {
        ...process.env,
        REAL_SMOKE_SCOPE: 'image_only',
        DISABLE_VIDEO_GENERATION: 'true',
        UI_SMOKE_MODE: 'diagnostic',
        AI_VIDEO_API_KEY: DUMMY,
        AI_VIDEO_SMOKE_OUT: out,
      },
      stdio: 'pipe',
      timeout: 60_000,
    });
  } catch (e) {
    exitCode = e.status ?? 1;
  }
  const elapsed = Date.now() - t0;
  assert.equal(exitCode, 1, 'missing app must exit non-zero');
  assert.ok(elapsed < 55_000, `must fail fast, took ${elapsed}ms`);

  const reportPath = path.join(out, 'smoke-report.json');
  assert.ok(fs.existsSync(reportPath), 'a smoke-report.json must be written even on failure');
  const raw = fs.readFileSync(reportPath, 'utf8');
  const r = JSON.parse(raw);
  assert.equal(r.status, 'failed');
  assert.ok(r.failed_stage, 'failed_stage must be set');
  assert.equal(r.video_generation_skipped, true);
  assert.equal(r.veo_not_called, true);
  assert.equal(r.final_merge_not_called, true);
  assert.equal(r.api_key_leaked, false);
  assert.equal(raw.includes(DUMMY), false, 'the API key must never appear in the report');

  fs.rmSync(out, { recursive: true, force: true });
});

// ── P14-B8I: API-key save/reload closure + brief-form selector hardening ──────

test('B8I: report distinguishes UI-configured from actual config persistence', () => {
  const src = readUi();
  for (const f of ['configured_reported_by_ui', 'api_key_saved_via_ui', 'api_key_loaded_from_config', 'api_key_effective_for_runtime', 'config_save_mismatch']) {
    assert.ok(src.includes(f), `report must include ${f}`);
  }
});

test('B8I: config save is verified by config-file readback + runtime /health/meta (not route-only)', () => {
  const src = readUi();
  assert.ok(/function configSummary\(/.test(src), 'must read the saved key presence from local-config.json');
  assert.ok(/local-config\.json/.test(src) && /providers\?\.kie\?\.api_key/.test(src), 'must check providers.kie.api_key presence');
  assert.ok(/\/health\/meta/.test(src) && /kie_api_key_configured/.test(src), 'must verify runtime effectiveness via /health/meta');
  assert.ok(/api_key_loaded_from_config = Boolean\(summary\.key_present\)/.test(src), 'api_key_loaded_from_config from the file readback');
});

test('B8I: a configured-vs-actual mismatch fails the run', () => {
  const src = readUi();
  assert.ok(/config_save_mismatch = true/.test(src) || /report\.config_save_mismatch = true/.test(src), 'must set config_save_mismatch');
  assert.ok(/fail\('config_save_mismatch'/.test(src), 'must fail on config_save_mismatch');
  assert.ok(/fail\('config_save_not_effective'/.test(src), 'diagnostic mode must fail if the key is not effective');
});

test('B8I: config-file readback records PRESENCE only — never the key value', () => {
  const src = readUi();
  // configSummary must return presence booleans + a masked hint, not store the key.
  assert.ok(/key_present: key\.length > 0/.test(src), 'configSummary must return key presence as a boolean');
  assert.ok(/key_masked: key \? maskKey\(key\)/.test(src), 'configSummary may only expose a masked key hint');
  assert.ok(/function maskKey\(/.test(src) && /\.slice\(0, 3\)/.test(src), 'maskKey must mask to a short non-reversible hint');
  assert.ok(!/report\.[A-Za-z_]+\s*=\s*key\b/.test(src), 'the raw key must never be assigned to a report field');
});

test('B8I: brief form is reached via /new-project and does NOT hard-wait field-0 on /', () => {
  const src = readUi();
  assert.ok(/\$\{uiBase\}\/new-project/.test(src), 'must navigate to /new-project for the intake form');
  // The old hard-wait `page.locator('input[name="field-0"]').fill(...)` must be gone.
  assert.ok(!/page\.locator\('input\[name="field-0"\]'\)\.fill\(/.test(src), 'must not hard-wait field-0 directly');
  // The brief goto immediately before the form fill must be /new-project, not the hub /.
  assert.ok(!/goto\(`\$\{uiBase\}\/`, \{ waitUntil: 'domcontentloaded' \}\);\s*\n\s*await page\.locator\('input\[name="field-0"\]'\)/.test(src),
    'must not fill field-0 right after navigating to the hub /');
});

test('B8I: brief form uses resilient selectors (name + placeholder/label fallbacks)', () => {
  const src = readUi();
  assert.ok(/function firstLocator\(/.test(src), 'must provide a resilient firstLocator helper');
  assert.ok(/#product-intake-form/.test(src) && /form\[action="\/submit-product"\]/.test(src), 'must wait for the stable intake form');
  assert.ok(/placeholder\*="补光灯"|placeholder\*="宠物梳"/.test(src), 'product-name locator must have a placeholder fallback');
  assert.ok(/#product-submit-button/.test(src), 'submit must use the stable button id');
});

test('B8I: a missing brief form emits a DOM summary + screenshot and fails brief_form_missing', () => {
  const src = readUi();
  assert.ok(/function captureDomSummary\(/.test(src), 'must have a DOM-summary helper');
  assert.ok(/captureDomSummary\(page, 'new-project-dom-summary\.json'\)/.test(src), 'must snapshot the new-project page');
  assert.ok(/brief-form-missing-dom-summary\.json/.test(src), 'must dump a DOM summary when the form is missing');
  assert.ok(/fail\('brief_form_missing'/.test(src), 'must fail with brief_form_missing');
  assert.ok(/04b-brief-form-missing\.png/.test(src), 'must screenshot the missing-form page');
  // DOM summary records url/title/buttons/inputs.
  assert.ok(/buttons:/.test(src) && /inputs:/.test(src) && /headings:/.test(src), 'DOM summary must include buttons/inputs/headings');
});

test('B8I: the brief still completes the full image-only flow (name/desc/market/lang/image/submit)', () => {
  const src = readUi();
  assert.ok(/nameInput\.fill\(/.test(src), 'fills product name');
  assert.ok(/descInput.*\.fill\(|textarea\[name="field-1"\]/.test(src), 'fills description/selling points');
  assert.ok(/field-2/.test(src) && /field-3/.test(src), 'sets market + language');
  assert.ok(/setInputFiles\(/.test(src), 'uploads a test image');
});

// ── P14-B8M: config-save selector must read the KEY status, not route tags ─────

test('B8M: configured_reported_by_ui reads the KEY status, not "当前接口路由" route tags', () => {
  const src = readUi();
  // The old loose `/已配置/.test(cfgText)` (matched route 已配置 tags) must be gone.
  assert.ok(!/configured_reported_by_ui = \/已配置\/\.test\(cfgText\)/.test(src), 'must not match any 已配置 on the page');
  assert.ok(/report\.configured_reported_by_ui = uiStatus\.key_configured/.test(src), 'must derive from the key-specific status');
  assert.ok(/function readConfigStatus\(/.test(src), 'must read the key-specific config status');
  // readConfigStatus targets the Kie API Key badge + the effective-config key.
  assert.ok(/Kie API Key/.test(src) && /未填写/.test(src), 'must distinguish the Kie API Key 已配置/未填写 badge');
  assert.ok(/当前接口路由|route tags/.test(src), 'must document the route-tag false positive it avoids');
});

test('B8M: the brief gate requires THIS-run save signals + UI/config/runtime closure', () => {
  const src = readUi();
  // closureOk must include the current-run save signals (input filled + /config-save
  // 200), so a pre-existing key in config can never pass when THIS save failed.
  const m = src.match(/const closureOk =([\s\S]{0,320}?);/);
  assert.ok(m, 'closureOk must be defined');
  const gate = m[1];
  for (const sig of [
    'report.api_key_input_filled',
    'report.api_key_saved_via_ui',
    'report.configured_reported_by_ui',
    'report.api_key_loaded_from_config',
    'report.api_key_effective_for_runtime',
  ]) {
    assert.ok(gate.includes(sig), `closureOk must include ${sig}`);
  }
  // It must be an AND of all signals (no ||), and fail config_save_mismatch.
  assert.ok(!gate.includes('||'), 'closureOk must AND the signals, not OR them');
  assert.ok(/if \(!closureOk\)[\s\S]{0,200}fail\('config_save_mismatch'/.test(src), 'a not-closed config must fail config_save_mismatch');
});

test('B8M: api_key_saved_via_ui=false (no /config-save 2xx) still fails even if a badge shows 已配置', () => {
  const src = readUi();
  // api_key_saved_via_ui is gated on the actual /config-save POST returning 2xx.
  assert.ok(/api_key_saved_via_ui = saveOk/.test(src), 'api_key_saved_via_ui from the real /config-save response');
  assert.ok(/resp\.status\(\) >= 200 && resp\.status\(\) < 300/.test(src), 'must require a 2xx from /config-save');
  // The gate itself must reject the run when api_key_saved_via_ui is false.
  assert.ok(/const closureOk =[\s\S]{0,320}report\.api_key_saved_via_ui/.test(src), 'closureOk must require api_key_saved_via_ui');
  // And surface it in the diagnostic message.
  assert.ok(/api_key_saved_via_ui=\$\{report\.api_key_saved_via_ui\}/.test(src), 'mismatch error must include api_key_saved_via_ui');
});

test('B8M: the real input is filled + verified and the real 保存配置 button is clicked', () => {
  const src = readUi();
  assert.ok(/input\[data-path="providers\.kie\.api_key"\]/.test(src), 'must fill the real Kie API Key input');
  assert.ok(/\.fill\(apiKey\)/.test(src), 'must really type the key');
  assert.ok(/api_key_input_filled = /.test(src) && /\.inputValue\(\)/.test(src), 'must verify the input value was actually set');
  assert.ok(/#save-btn|save-config-btn|保存配置/.test(src), 'must click the real 保存配置 button');
});

test('B8M: redacted_config_summary exposes presence + masked hint only (no plaintext key)', () => {
  const src = readUi();
  for (const f of ['redacted_config_summary', 'config_path', 'visible_config_status_texts', 'api_key_input_filled']) {
    assert.ok(src.includes(f), `report must include ${f}`);
  }
  for (const f of ['key_present', 'key_masked', 'base_url_present', 'effective_route_present']) {
    assert.ok(src.includes(f), `config summary must include ${f}`);
  }
  // Must NOT copy the raw local-config or the raw key anywhere.
  assert.ok(!/copyFileSync\([^)]*local-config/.test(src), 'must not copy raw local-config.json');
  assert.ok(!/redacted_config_summary\s*=\s*cfg\b/.test(src), 'must not put the raw config object in the report');
});

test('B8M: config_save_mismatch failure captures DOM summary + screenshot diagnostics', () => {
  const src = readUi();
  assert.ok(/captureDomSummary\(page, 'config-save-mismatch-dom\.json'\)/.test(src), 'must dump a DOM summary on mismatch');
  assert.ok(/02b-config-save-mismatch\.png/.test(src), 'must screenshot the mismatch state');
  assert.ok(/visible_config_status_texts = uiStatus\.texts/.test(src), 'must record the visible on-page status texts');
});

test('B8M: image-only boundaries + no-model still hold in the config path', () => {
  const src = readUi();
  // The brief navigation (generation entry) must come AFTER the config closure gate.
  const cfgIdx = src.indexOf("fail('config_save_mismatch'");
  const briefNavIdx = src.indexOf('await page.goto(`${uiBase}/new-project`');
  assert.ok(cfgIdx > 0 && briefNavIdx > cfgIdx, 'the brief (generation) must come AFTER the config closure gate');
  assert.ok(/video_generation_skipped: true/.test(src) && /veo_not_called: true/.test(src), 'stop-proof flags remain true');
});

// ── P14-B8O: config-save ACTION must really trigger /config-save ──────────────

test('B8O: input fill fires framework events + blur (not just a DOM value set)', () => {
  const src = readUi();
  assert.ok(/\.dispatchEvent\('input'\)/.test(src) && /\.dispatchEvent\('change'\)/.test(src), 'must dispatch input + change events');
  assert.ok(/\.press\('Tab'\)/.test(src) || /\.blur\(\)/.test(src), 'must blur the input after fill');
  assert.ok(/api_key_input_filled = .*inputValue\(\)/.test(src), 'must verify the input value committed');
});

test('B8O: the save button is checked for visible/enabled before click; fails with state if not', () => {
  const src = readUi();
  assert.ok(/save_button_visible = await saveBtn\.isVisible\(\)/.test(src), 'must read save button visibility');
  assert.ok(/save_button_enabled = await saveBtn\.isEnabled\(\)/.test(src), 'must read save button enabled state');
  assert.ok(/fail\('config_save_button_not_actionable'/.test(src), 'a disabled/hidden save button must fail with state');
  // The diagnostic captures disabled / aria-disabled / className / rect.
  assert.ok(/aria-disabled/.test(src) && /getBoundingClientRect/.test(src) && /save-button-state\.json/.test(src),
    'must dump disabled/aria-disabled/className/bounding-box state');
});

test('B8O: a missing save button fails and reports the visible buttons', () => {
  const src = readUi();
  assert.ok(/fail\('config_save_button_missing'/.test(src), 'must fail when the save button is not found');
  assert.ok(/report\.visible_buttons = await visibleButtons\(\)/.test(src), 'must record visible buttons');
});

test('B8O: a click that does NOT POST /config-save fails config_save_action_not_triggered', () => {
  const src = readUi();
  assert.ok(/page\.waitForRequest\(\(r\) => r\.url\(\)\.includes\('\/config-save'\) && r\.method\(\) === 'POST'/.test(src),
    'must wait for the /config-save POST request');
  assert.ok(/config_save_post_seen = Boolean\(req\)/.test(src), 'must record whether the POST was seen');
  assert.ok(/if \(!req\)[\s\S]{0,1100}fail\('config_save_action_not_triggered'/.test(src),
    'no /config-save POST => config_save_action_not_triggered');
  // It must NOT continue to config readback when the action did not trigger.
  const notTrigIdx = src.indexOf("fail('config_save_action_not_triggered'");
  const readbackIdx = src.indexOf('const summary = configSummary()');
  assert.ok(notTrigIdx > 0 && readbackIdx > notTrigIdx, 'readback must be after (gated by) the action-not-triggered guard');
});

test('B8O: only a /config-save 2xx proceeds; a non-2xx fails before readback', () => {
  const src = readUi();
  assert.ok(/config_save_post_status = resp \? resp\.status\(\) : null/.test(src), 'must record the POST status');
  assert.ok(/if \(!saveOk\)[\s\S]{0,400}fail\('config_save_mismatch'/.test(src), 'a non-2xx /config-save must fail');
  // The non-2xx guard precedes the readback summary.
  const nonOkIdx = src.indexOf('returned non-2xx');
  const readbackIdx = src.indexOf('const summary = configSummary()');
  assert.ok(nonOkIdx > 0 && readbackIdx > nonOkIdx, 'readback must be after the non-2xx guard');
});

test('B8O: action-trigger diagnostics fields are all in the report', () => {
  const src = readUi();
  for (const f of [
    'api_key_input_selector_matched', 'api_key_input_filled', 'save_button_selector_matched',
    'save_button_visible', 'save_button_enabled', 'save_button_click_attempted',
    'config_save_post_seen', 'config_save_post_status', 'renderer_requests', 'visible_buttons',
    'save_handler_present',
  ]) {
    assert.ok(src.includes(f), `report must include ${f}`);
  }
  // The not-triggered failure must snapshot requests + a DOM summary + screenshot.
  assert.ok(/renderer_requests = \[\.\.\.new Set\(requestLog\)\]/.test(src), 'must snapshot renderer_requests');
  assert.ok(/config-save-action-not-triggered-dom\.json/.test(src) && /02b-config-save-action-not-triggered\.png/.test(src),
    'must dump DOM summary + screenshot on not-triggered');
});

test('B8O: the save link is the real UI click — no direct config write / no synthetic success', () => {
  const src = readUi();
  assert.ok(/await saveBtn\.click\(\)/.test(src), 'must perform a real button click');
  assert.ok(!/writeFileSync\([^)]*local-config\.json/.test(src), 'must never write local-config.json directly');
  assert.ok(!/api_key_saved_via_ui = true\b/.test(src), 'must never hardcode save success');
  assert.ok(!/page\.evaluate\([^)]*saveConfig\(/.test(src), 'must not call saveConfig() programmatically to fake the save');
});

// ── P14-B8Q: config-save handler binding (frontend) reliably triggers the save ─

test('B8Q: the config page exposes window.saveConfig (not only an inline-script global)', () => {
  const src = readServe();
  assert.ok(/window\.saveConfig = saveConfig/.test(src), 'must explicitly expose window.saveConfig');
  // The packaged renderer did not promote inline declarations to window — explicit
  // exposure keeps the handler resolvable + detectable.
  assert.ok(/window\.testConnection = testConnection/.test(src), 'must expose the other config handlers too');
});

test('B8Q: the save button is bound via addEventListener (closure ref, not only inline onclick)', () => {
  const src = readServe();
  assert.ok(/addEventListener\('click', \(e\) => saveConfig\(e\)\)/.test(src), 'must bind the save click via addEventListener');
  assert.ok(/dataset\.boundSave/.test(src) && /DOMContentLoaded/.test(src), 'must bind on DOMContentLoaded with an idempotent marker');
  // The save button must NOT rely solely on an inline onclick="saveConfig(...)".
  assert.ok(!/id="save-btn"[^>]*onclick="saveConfig/.test(src), 'save button must not depend on inline onclick=saveConfig');
});

test('B8Q: the config page has testability ids for the key input + save button', () => {
  const src = readServe();
  assert.ok(/data-testid="kie-api-key-input"/.test(src), 'API Key input must have data-testid');
  assert.ok(/data-testid="save-config-button"/.test(src), 'save button must have data-testid');
  // The API Key input keeps its data-path binding for the save payload.
  assert.ok(/data-testid="kie-api-key-input" data-path="providers\.kie\.api_key"/.test(src), 'key input keeps its data-path');
});

test('B8Q: the smoke targets the new data-testid and treats addEventListener binding as handler-present', () => {
  const src = readUi();
  assert.ok(/button\[data-testid="save-config-button"\]/.test(src), 'smoke must target data-testid="save-config-button"');
  assert.ok(/input\[data-testid="kie-api-key-input"\]/.test(src), 'smoke must target data-testid="kie-api-key-input"');
  // save_handler_present accepts the exposed window.saveConfig OR the bound marker.
  assert.ok(/typeof window\.saveConfig === 'function'/.test(src), 'still checks window.saveConfig');
  assert.ok(/data-bound-save="1"/.test(src), 'also accepts the addEventListener binding marker');
});

test('B8Q: the smoke gate still requires handler-present + POST + 2xx + key closure before brief', () => {
  const src = readUi();
  // No /config-save POST => action_not_triggered (handler-present is also reported).
  assert.ok(/fail\('config_save_action_not_triggered'/.test(src), 'no POST => action_not_triggered');
  assert.ok(/save_handler_present=\$\{report\.save_handler_present\}/.test(src), 'must report save_handler_present in the failure');
  // The five-signal closure (incl. the current-run save) still gates the brief.
  const m = src.match(/const closureOk =([\s\S]{0,320}?);/);
  assert.ok(m && /report\.api_key_saved_via_ui/.test(m[1]) && /report\.api_key_loaded_from_config/.test(m[1]) && /report\.api_key_effective_for_runtime/.test(m[1]),
    'closure must still require save + config key_present + runtime effective');
});

test('B8Q: the fix is frontend-only handler binding — save still posts the real form payload', () => {
  const src = readServe();
  // The save still POSTs /config-save with the collected form payload (no bypass).
  assert.ok(/fetch\('\/config-save'/.test(src), 'save must still POST /config-save');
  assert.ok(/collectConfigBody\(\)/.test(src), 'must send the collected UI form payload');
  // The B8Q binding block itself only wires up handlers — no model/route/webhook tokens.
  const m = src.match(/window\.saveConfig = saveConfig;[\s\S]{0,1200}?\}\)\(\);/);
  assert.ok(m, 'the B8Q binding block must be present');
  assert.ok(!/reviewSubmitVeoV2|kie_veo|webhook\/|tasks\.\w+\.model\s*=/.test(m[0]),
    'the B8Q binding block must not touch model-route/webhook/schema');
});

// ── P14-B8R1: Playwright install retry + cache + "did-not-run" summary ─────────

const PW_RETRY = path.join(ROOT, 'scripts', 'win', 'install-playwright-with-retry.mjs');
const readRetry = () => fs.readFileSync(PW_RETRY, 'utf8');

test('B8R1: retry helper exists and passes node --check', () => {
  assert.ok(fs.existsSync(PW_RETRY), `missing ${PW_RETRY}`);
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', PW_RETRY], { stdio: 'pipe' }));
});

test('B8R1: helper retries >=3 attempts and classifies transient network errors', async () => {
  const m = await import(pathToFileURL(PW_RETRY).href);
  assert.ok(m.MAX_ATTEMPTS >= 3, 'must allow at least 3 attempts');
  for (const t of ['npm error code ECONNRESET', 'ETIMEDOUT', 'getaddrinfo ENOTFOUND registry.npmjs.org', 'socket hang up', 'npm error 503 Service Unavailable', 'request to https://registry.npmjs.org/playwright failed']) {
    assert.equal(m.isTransient(t), true, `must treat as transient: ${t}`);
  }
  for (const nt of ['npm error 404 Not Found', 'npm warn cleanup EPERM operation not permitted', 'No matching version found']) {
    assert.equal(m.isTransient(nt), false, `must NOT treat as transient: ${nt}`);
  }
});

test('B8R1: helper fails clearly as install_playwright_dependency + writes a no-start summary', () => {
  const src = readRetry();
  assert.ok(/FAILED_STAGE = 'install_playwright_dependency'/.test(src), 'must name the failed_stage');
  assert.ok(/process\.exit\(1\)/.test(src), 'must exit non-zero on exhausted retries (no silent skip)');
  assert.ok(/GITHUB_STEP_SUMMARY/.test(src) && /UI smoke did not start/.test(src), 'must write a step summary');
  assert.ok(/AI Video\.exe was NOT launched/.test(src) && /no video clips; no final merge/.test(src),
    'summary must state no app launch / no model / no Veo/video/final');
  // Uses --no-save (local, not global) and prefers an already-installed playwright.
  assert.ok(/'--no-save'/.test(src) && /require\.resolve\('playwright'\)/.test(src),
    'must use --no-save and skip when already installed');
});

test('B8R1: workflow caches Playwright browsers keyed by OS + version + lockfile', () => {
  const yml = readWf();
  assert.ok(/uses: actions\/cache@v4/.test(yml), 'must use actions/cache');
  assert.ok(/ms-playwright/.test(yml), 'must cache the ms-playwright browsers path');
  assert.ok(/key: \$\{\{ runner\.os \}\}-playwright-[\d.]+-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/.test(yml),
    'cache key must include OS + Playwright version + lockfile hash');
  // A miss must still allow install (the install step is unconditional after cache).
  const cacheIdx = yml.indexOf('Cache Playwright browsers');
  const installIdx = yml.indexOf('Install Playwright (no-save, retry)');
  assert.ok(cacheIdx > 0 && installIdx > cacheIdx, 'install runs after the cache restore (miss still downloads)');
});

test('B8R1: a no-report run is summarized as "UI smoke not started" (not misleading)', () => {
  const yml = readWf();
  assert.ok(/Summarize UI smoke result/.test(yml), 'must summarize the result');
  assert.ok(/UI smoke not started/.test(yml) && /AI Video\.exe was NOT launched/.test(yml),
    'no-report case must say UI smoke not started + no app launch');
  assert.ok(/No model call \(Gemini \/ Nano Banana \/ Veo\); no video clips; no final merge/.test(yml),
    'must state no model / no Veo/video/final when not started');
  // Upload step stays non-failing when no report exists.
  assert.ok(/if-no-files-found: warn/.test(yml), 'upload must warn (not fail/empty) when no report');
});

test('B8R1: image-only boundaries + dispatch-only trigger are preserved', () => {
  const yml = readWf();
  assert.ok(/REAL_SMOKE_SCOPE: image_only/.test(yml) && /DISABLE_VIDEO_GENERATION: 'true'/.test(yml), 'image-only env preserved');
  assert.ok(/workflow_dispatch/.test(yml) && !/\n\s*push:/.test(yml) && !/\n\s*schedule:/.test(yml), 'still dispatch-only');
  // The UI smoke runner + the secret-only key path are unchanged.
  assert.ok(/ui-smoke-image-only\.mjs/.test(yml) && /secrets\.AI_VIDEO_API_KEY/.test(yml), 'smoke runner + secret-only key intact');
});

// ── P14-B8T: bind the config-save handler via the reliable desktop-shell path ──

const WIN_MAIN = path.join(ROOT, 'desktop', 'win-main.cjs');
const ASSEMBLE = path.join(ROOT, 'scripts', 'win', 'assemble-windows-portable.mjs');
const readWinMain = () => fs.readFileSync(WIN_MAIN, 'utf8');

test('B8T: win-main injects a config-save handler on did-finish-load (proven execution path)', () => {
  const src = readWinMain();
  assert.ok(/injectConfigSaveHandler\(\)/.test(src), 'must call injectConfigSaveHandler');
  assert.ok(/did-finish-load[\s\S]{0,120}injectConfigSaveHandler\(\)/.test(src), 'must inject on did-finish-load');
  assert.ok(/function injectConfigSaveHandler\(/.test(src) && /executeJavaScript\(/.test(src), 'must use executeJavaScript (the path that runs)');
});

test('B8T: the injected handler posts the REAL /config-save with the collected form payload', () => {
  const src = readWinMain();
  const blk = src.slice(src.indexOf('function injectConfigSaveHandler'));
  assert.ok(/querySelectorAll\('\[data-path\]'\)/.test(blk), 'must collect [data-path] form fields (like collectConfigBody)');
  assert.ok(/fetch\('\/config-save'/.test(blk) && /method: 'POST'/.test(blk), 'must POST /config-save');
  // No bypass: no direct local-config write, no faked success.
  assert.ok(!/local-config/.test(blk), 'must not write local-config directly');
  // Save failure must be visible (alert), success refreshes /config.
  assert.ok(/window\.alert/.test(blk) && /\/config/.test(blk), 'failure visible + success refresh');
});

test('B8T: the injected handler is idempotent + marker-gated (no double-fire with the page binding)', () => {
  const win = readWinMain();
  assert.ok(/if \(window\.AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND\) return/.test(win), 'injection must skip when already bound');
  assert.ok(/window\.AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND = true/.test(win) && /configSaveHandlerBound = 'true'/.test(win), 'must set the markers');
  const serve = readServe();
  assert.ok(/if \(window\.AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND\) return/.test(serve), 'page binding must also gate on the marker');
  assert.ok(/window\.AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND = true/.test(serve), 'page binding must set the marker when it does run (mac)');
});

test('B8T: a real injected click binds + POSTs on a fresh DOM (jsdom-free runtime proof)', () => {
  // Extract the injected IIFE body and run it against a minimal DOM shim to prove
  // the click handler collects [data-path] and calls fetch('/config-save').
  const win = readWinMain();
  const tmpl = win.match(/function injectConfigSaveHandler\(\)[\s\S]*?executeJavaScript\(`([\s\S]*?)`\)\.catch/);
  assert.ok(tmpl, 'must find the injected script template');
  const injected = tmpl[1];
  const fetchCalls = [];
  const listeners = {};
  const el = (overrides = {}) => ({ dataset: {}, value: '', disabled: false, textContent: '', getAttribute: () => null, closest(sel) { return (sel.includes('save-config-button') || sel.includes('save-btn')) ? this : null; }, ...overrides });
  const saveBtn = el({ dataset: { boundSave: undefined } });
  const keyField = el({ value: 'sk-REDACTED', dataset: { path: 'providers.kie.api_key' } });
  const sandbox = {
    window: {},
    document: {
      body: { dataset: {} },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      querySelectorAll: (sel) => (sel === '[data-path]' ? [keyField] : []),
      querySelector: () => saveBtn,
    },
    fetch: (url, opts) => { fetchCalls.push({ url, opts }); return Promise.resolve({ ok: true }); },
    setTimeout: () => {},
  };
  // Re-point bare `window`/`document`/`fetch`/`setTimeout` at the sandbox.
  const fn = new Function('window', 'document', 'fetch', 'setTimeout', injected);
  fn(sandbox.window, sandbox.document, sandbox.fetch, sandbox.setTimeout);
  assert.equal(sandbox.window.AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND, true, 'marker set after injection');
  assert.ok(typeof listeners.click === 'function', 'a delegated click listener was bound');
  // Simulate a click on the save button → must POST /config-save with the field.
  listeners.click({ target: saveBtn, preventDefault() {} });
  assert.equal(fetchCalls.length, 1, 'exactly one /config-save POST');
  assert.ok(fetchCalls[0].url === '/config-save' && fetchCalls[0].opts.method === 'POST', 'POST /config-save');
  const sent = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(sent.providers.kie.api_key, 'sk-REDACTED', 'collected the [data-path] api_key field');
});

test('B8T: assemble packages win-main.cjs + serve so source and artifact cannot drift', () => {
  const asm = fs.readFileSync(ASSEMBLE, 'utf8');
  // The desktop shell entry and the 版本测试 server are part of the packaged tree.
  assert.ok(/版本测试/.test(asm), 'assemble must include the 版本测试 server tree');
  assert.ok(fs.existsSync(WIN_MAIN), 'win-main.cjs (desktop shell) must exist for packaging');
});

test('B8T: the smoke detects the handler via marker/data-bound-save/window + records the method', () => {
  const src = readUi();
  assert.ok(/AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND/.test(src), 'must detect the desktop-shell marker');
  assert.ok(/configSaveHandlerBound/.test(src), 'must detect the body dataset marker');
  assert.ok(/handler_detection_method = /.test(src), 'must record handler_detection_method');
  assert.ok(/waitForFunction\([\s\S]{0,200}AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND/.test(src), 'must wait for the async injection marker');
});

test('B8T: harder diagnostics fields are present in the smoke report', () => {
  const src = readUi();
  for (const f of ['handler_detection_method', 'renderer_console_errors', 'script_assets_loaded', 'config_save_script_present', 'packaged_renderer_asset_check']) {
    assert.ok(src.includes(f), `report must include ${f}`);
  }
  assert.ok(/page\.on\('pageerror'/.test(src) && /page\.on\('console'/.test(src), 'must capture renderer console errors');
  assert.ok(/redactString/.test(src), 'console errors must be redacted (no secret leak)');
});

// ── P14-B8V: fixed product-image fixture + WF01/n8n binary diagnostics ─────────

const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'ui-smoke-product.jpg');

test('B8V: a fixed product-image fixture exists and is a real jpg/png (not temp-only)', () => {
  assert.ok(fs.existsSync(FIXTURE), `missing fixture ${FIXTURE}`);
  const b = fs.readFileSync(FIXTURE);
  const isJpeg = b[0] === 0xFF && b[1] === 0xD8;
  const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
  assert.ok(isJpeg || isPng, 'fixture must be a real JPEG or PNG');
  assert.ok(b.length > 2000 && b.length < 600 * 1024, `fixture should be small but real (got ${b.length} bytes)`);
});

test('B8V: the smoke uploads the FIXED fixture through the real file input (no dynamic-only temp PNG)', () => {
  const src = readUi();
  assert.ok(/tests', 'fixtures', 'ui-smoke-product\.jpg'/.test(src) || /ui-smoke-product\.jpg/.test(src), 'must reference the repo fixture');
  assert.ok(/input\[type="file"\]\[name="field-5"\]/.test(src), 'must target the field-5 file input');
  assert.ok(/setInputFiles\(productImage\)/.test(src), 'must setInputFiles the fixture');
  // The brief upload must NOT depend on the dynamic generated PNG anymore.
  assert.ok(!/setInputFiles\(samplePng\)/.test(src), 'must not upload the dynamic samplePng for the brief');
});

test('B8V: setInputFiles is verified (files.count>0 + name/type/size) and fails early if not attached', () => {
  const src = readUi();
  assert.ok(/el\.files && el\.files\[0\]/.test(src) && /size: f\.size/.test(src), 'must verify the attached file metadata');
  assert.ok(/product_image_attached_to_brief = /.test(src), 'must record product_image_attached_to_brief');
  assert.ok(/fail\('product_image_not_attached'/.test(src), 'must fail early when not attached');
});

test('B8V: /submit-product response is observed and a non-accept fails before WF01', () => {
  const src = readUi();
  assert.ok(/waitForResponse\([\s\S]{0,120}\/submit-product/.test(src), 'must observe the /submit-product response');
  assert.ok(/brief_submit_status = sResp/.test(src), 'must record the submit status');
  assert.ok(/fail\('brief_submit_not_accepted'/.test(src), 'must fail before WF01 if not accepted');
});

test('B8V: report carries the product-image + WF01/n8n binary diagnostic fields', () => {
  const src = readUi();
  for (const f of [
    'product_image_upload_attempted', 'product_image_input_matched', 'product_image_file_path',
    'product_image_attached_to_brief', 'brief_submit_request_seen', 'brief_submit_status',
    'n8n_binary_present', 'wf01_binary_present', 'wf01_binary_keys', 'wf01_product_image_count',
    'wf01_product_image_local_paths_exist', 'n8n_binary_storage_summary', 'binary_restore_error',
  ]) {
    assert.ok(src.includes(f), `report must include ${f}`);
  }
});

test('B8V: WF01 binary diagnostics are READ-ONLY and never emit base64/secrets', () => {
  const src = readUi();
  const fn = src.slice(src.indexOf('function collectWf01BinaryDiagnostics'), src.indexOf('// B8X1: read-only'));
  assert.ok(fn, 'collectWf01BinaryDiagnostics must exist');
  // Read-only: only SELECT against the n8n DB — never INSERT/UPDATE/DELETE.
  assert.ok(/SELECT /.test(fn), 'must SELECT execution data');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP)\b/.test(fn), 'must not write to the n8n DB');
  // Keys = NAMES only; paths -> existence booleans; counts numeric; errors redacted.
  assert.ok(/wf01_binary_keys = \[\.\.\.new Set/.test(fn), 'keys are names only');
  assert.ok(/fs\.existsSync\(m\[1\]\)/.test(fn) && /push\((?:fs\.existsSync|false)/.test(fn), 'paths recorded as existence booleans');
  assert.ok(/redactString/.test(fn), 'binary restore errors must be redacted');
  // Must NOT push raw base64 / data values into the report.
  assert.ok(!/base64/.test(fn), 'must not reference base64 values');
  // wf01_binary_present is a BOOLEAN — never a string sentinel (db-missing => false +
  // the reason goes into binary_restore_error).
  assert.ok(!/wf01_binary_present\s*=\s*['"]/.test(fn), 'wf01_binary_present must never be assigned a string');
  assert.ok(/wf01_binary_present = false;[\s\S]{0,200}binary_restore_error = [\s\S]{0,80}wf01_execution_db_not_found/.test(fn),
    'a missing execution DB must set wf01_binary_present=false + a binary_restore_error reason');
});

test('B8V: still no direct config write / no Veo/video/final / no fake success', () => {
  const src = readUi();
  assert.ok(!/writeFileSync\([^)]*local-config\.json/.test(src), 'no direct local-config write');
  assert.ok(/video_generation_skipped: true/.test(src) && /veo_not_called: true/.test(src), 'stop-proof flags remain true');
  // The fixture upload path does not call /config-save or any webhook directly for success.
  const fn = src.slice(src.indexOf('upload a FIXED'), src.indexOf('collectWf01BinaryDiagnostics(report)'));
  assert.ok(!/\/config-save/.test(fn) && !/webhook/.test(fn), 'brief upload must not call /config-save or a webhook directly');
});

// ── P14-B8X1: richer (redacted, read-only) WF01 execution diagnostics ─────────

const wf01ExecFn = () => {
  const src = readUi();
  return src.slice(src.indexOf('function collectWf01ExecutionDiagnostics'), src.indexOf('// ── Diagnostics ──'));
};

test('B8X1: report exposes a wf01_diagnostics object with all the hard execution fields', () => {
  const src = readUi();
  assert.ok(/wf01_diagnostics: null/.test(src), 'report must init wf01_diagnostics');
  const fn = wf01ExecFn();
  for (const f of [
    'execution_created', 'classification', 'execution_id', 'workflow_id', 'workflow_name',
    'status', 'started_at', 'stopped_at', 'last_node_executed', 'error_node', 'error_message',
    'error_type', 'error_stack_present', 'model_call_seen', 'http_status', 'model_provider',
    'model_name', 'response_redacted_summary', 'json_parse_error', 'input_keys', 'binary_keys',
    'binary_local_paths_exist', 'task_runner_rejected', 'task_runner_reject_reason',
  ]) {
    assert.ok(fn.includes(f), `wf01_diagnostics must include ${f}`);
  }
});

test('B8X1: WF01 exec diagnostics are READ-ONLY (SELECT only) and called after the pipeline', () => {
  const src = readUi();
  const fn = wf01ExecFn();
  assert.ok(/SELECT /.test(fn), 'must SELECT execution rows');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|REPLACE)\b/.test(fn), 'must never write to the n8n DB');
  // Called both at the verdict and the ui_pipeline catch.
  assert.ok(/collectWf01ExecutionDiagnostics\(report\)/.test(src), 'must be invoked');
  const verdictIdx = src.indexOf('FULL-mode verdict');
  assert.ok(src.indexOf('collectWf01ExecutionDiagnostics(report)') > 0, 'invoked');
  assert.ok(verdictIdx > 0, 'verdict section exists');
});

test('B8X1: a missing execution DB does NOT fake an execution id', () => {
  const fn = wf01ExecFn();
  assert.ok(/if \(!fs\.existsSync\(dbPath\)\)[\s\S]{0,120}execution_db_not_found/.test(fn), 'db-missing => classification execution_db_not_found');
  // execution_id stays null (initialized null; execution_created defaults false until a row is found).
  assert.ok(/execution_id: null/.test(fn) && /execution_created: false/.test(fn), 'no fake execution_id/created without a row');
  assert.ok(/if \(!ex\)[\s\S]{0,80}no_execution/.test(fn), 'no row => no_execution');
});

test('B8X1: model_call_seen/http_status are NOT guessed when no HTTP node ran', () => {
  const fn = wf01ExecFn();
  // http_status only set from a real httpCode/response.status; model_call_seen only then or on an Api error.
  assert.ok(/http_status: null/.test(fn) && /model_call_seen: false/.test(fn), 'defaults are null/false');
  assert.ok(/if \(httpCode != null\) \{ D\.http_status = Number\(httpCode\); D\.model_call_seen = true; \}/.test(fn),
    'http_status/model_call_seen set ONLY from a real httpCode');
  // No hardcoded 401/403/429 guessing.
  assert.ok(!/http_status = (401|403|429|500)/.test(fn), 'must not guess an HTTP status');
});

test('B8X1: task-runner rejection is detected (redacted reason) and classified', () => {
  const fn = wf01ExecFn();
  assert.ok(/rejected by Runner with reason "\(\[\^"\]\+\)"|rejected by Runner with reason/.test(fn), 'must scan n8n.log for the runner rejection');
  assert.ok(/task_runner_rejected = true/.test(fn), 'must set task_runner_rejected');
  assert.ok(/started_but_failed_task_runner_rejected/.test(fn), 'must classify a runner-rejected failure distinctly');
  assert.ok(/redactString\(m\[1\]\)/.test(fn), 'the reject reason must be redacted');
});

test('B8X1: diagnostics are REDACTED — no API key / Authorization / full prompt / base64 / raw response', () => {
  const fn = wf01ExecFn();
  // Every free-text field goes through redactString + a short slice.
  assert.ok(/error_message = redactString/.test(fn), 'error_message redacted');
  assert.ok(/response_redacted_summary = redactString\(JSON\.stringify\(resp\)\)\.slice\(0, 200\)/.test(fn), 'response summary redacted + truncated');
  assert.ok(!/base64/.test(fn), 'must not reference base64');
  assert.ok(!/Authorization|api_key|bearer/i.test(fn), 'must not read Authorization/api_key');
  // input/binary keys are NAMES only (regex on key names, never values).
  assert.ok(/input_keys = \[\.\.\.new Set/.test(fn) && /binary_keys = \[\.\.\.new Set/.test(fn), 'keys are names only');
  assert.ok(/error_stack_present = Boolean\(err\.stack\)/.test(fn), 'stack recorded as a boolean, not dumped');
});

test('B8X1: existing B8V binary diagnostics + B8T/Veo defenses are preserved', () => {
  const src = readUi();
  // B8V binary fields/functions intact.
  assert.ok(/function collectWf01BinaryDiagnostics/.test(src) && /wf01_binary_keys/.test(src), 'B8V binary diagnostics kept');
  // Stop-proof flags + no direct config write unchanged.
  assert.ok(/video_generation_skipped: true/.test(src) && /veo_not_called: true/.test(src), 'Veo/video stop-proof flags intact');
  assert.ok(!/writeFileSync\([^)]*local-config\.json/.test(src), 'no direct local-config write');
});

// ── P14-B8Z: WF01 config-key visibility for the n8n Code node (task runner) ────

const WF01_JSON = path.join(ROOT, '正式导入文件', 'iteration-v1', 'n8n01.json');
const wf01Node = () => {
  const wf = JSON.parse(fs.readFileSync(WF01_JSON, 'utf8'));
  return (wf.nodes || []).find((n) => n.name && n.name.includes('读取创意API配置'));
};

test('B8Z: WF01 read-config node prioritizes AI_VIDEO_CONFIG_PATH then the WINDOWS unified path', () => {
  const code = wf01Node().parameters.jsCode;
  // AI_VIDEO_CONFIG_PATH is the FIRST candidate.
  assert.ok(/CONFIG_CANDIDATES = \[\s*\n\s*process\.env\.AI_VIDEO_CONFIG_PATH,/.test(code), 'AI_VIDEO_CONFIG_PATH must be first');
  // Windows %APPDATA% + HOME/USERPROFILE + os.homedir AppData\Roaming candidates exist.
  assert.ok(/process\.env\.APPDATA \? path\.join\(process\.env\.APPDATA, 'AI Video', 'config', 'local-config\.json'\)/.test(code), 'must include the %APPDATA% unified path');
  assert.ok(/process\.env\.HOME \|\| process\.env\.USERPROFILE/.test(code) && /'AppData', 'Roaming', 'AI Video', 'config'/.test(code),
    'must include a HOME/USERPROFILE Windows path (the runner keeps HOME)');
  assert.ok(/os\.homedir\(\), 'AppData', 'Roaming', 'AI Video', 'config'/.test(code), 'must include an os.homedir() Windows path');
});

test('B8Z: Windows packaged must NOT prefer the Mac path or the dev 版本测试/config path', () => {
  const code = wf01Node().parameters.jsCode;
  const appdataIdx = code.indexOf("'AppData', 'Roaming'");
  const macIdx = code.indexOf("'Library', 'Application Support'");
  const devIdx = code.indexOf("'版本测试', 'config'");
  assert.ok(appdataIdx > 0, 'Windows unified path present');
  assert.ok(macIdx > appdataIdx, 'Mac path must come AFTER the Windows unified paths');
  assert.ok(devIdx > appdataIdx && devIdx > macIdx, 'the dev 版本测试/config path must be LAST');
  // It must not fall back to a resources/runtime packaged config as a Windows preferred source.
  assert.ok(!/resources[\\/]+runtime[\\/]+版本测试/.test(code), 'must not prefer resources/runtime/版本测试 config');
});

test('B8Z: UI save path == WF01 read path (both the %APPDATA%/AI Video/config/local-config.json unified file)', () => {
  // The desktop shell injects AI_VIDEO_CONFIG_PATH = <APPDATA>\AI Video\config\local-config.json …
  const winMain = fs.readFileSync(path.join(ROOT, 'desktop', 'win-main.cjs'), 'utf8');
  assert.ok(/AI_VIDEO_CONFIG_PATH: layout\.configPath/.test(winMain), 'desktop shell sets AI_VIDEO_CONFIG_PATH');
  // … the launcher forwards it to the n8n child …
  const launcher = fs.readFileSync(path.join(ROOT, 'client', 'launcher.mjs'), 'utf8');
  assert.ok(/AI_VIDEO_CONFIG_PATH: CONFIG_PATH/.test(launcher), 'launcher injects AI_VIDEO_CONFIG_PATH into the n8n child');
  // … and WF01 reads the same unified config/local-config.json file.
  const code = wf01Node().parameters.jsCode;
  assert.ok(/'AI Video', 'config', 'local-config\.json'/.test(code), 'WF01 reads the unified config/local-config.json file');
});

test('B8Z: smoke wf01_diagnostics adds config-visibility fields (presence/path only)', () => {
  const src = readUi();
  for (const f of ['wf01_config_path_used', 'wf01_config_file_exists', 'wf01_config_key_present', 'n8n_env_has_ai_video_config_path', 'task_runner_env_has_ai_video_config_path']) {
    assert.ok(src.includes(f), `wf01_diagnostics must include ${f}`);
  }
  // Computed from configSummary (presence + masked) — never the raw key.
  assert.ok(/D\.wf01_config_key_present = Boolean\(cs\.key_present\)/.test(src), 'key_present is a boolean from configSummary');
  assert.ok(!/wf01_config_key_present = .*api_key/.test(src), 'must not put the raw key in the report');
});

test('B8Z: json_parse_error is no longer a broad full-text scan (B8X1 false-positive fix)', () => {
  const src = readUi();
  const fn = src.slice(src.indexOf('function collectWf01ExecutionDiagnostics'), src.indexOf('// ── Diagnostics ──'));
  // The over-broad text scan that set json_parse_error from the whole execution data is gone.
  assert.ok(!/D\.json_parse_error = \/Unexpected token[^\n]*\.test\(text\)/.test(fn), 'must not scan the whole execution text');
  // It is set ONLY from a real parse-error error_message.
  assert.ok(/json_parse_error = true/.test(fn) && /test\(D\.error_message/.test(fn), 'json_parse_error only from a real error_message');
  assert.ok(!/\/json\|unexpected token\|not valid JSON\/i\.test\(D\.error_message/.test(fn), 'the loose /json/ match is removed');
});

test('B8Z: no hardcoded API key, no key in workflow/code; Veo/video/final defenses intact', () => {
  const code = wf01Node().parameters.jsCode;
  // No hardcoded key literal in WF01 (sk-…/AIza…/long bearer-ish constant assigned to a key field).
  assert.ok(!/api_key['"]?\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/.test(code), 'no hardcoded API key in WF01');
  assert.ok(code.includes('缺少 Kie API Key'), 'still throws when the key is genuinely missing (no bypass)');
  const src = readUi();
  assert.ok(/video_generation_skipped: true/.test(src) && /veo_not_called: true/.test(src), 'Veo/video stop-proof flags intact');
});

// ── P14-B8AB: task-runner "Offer expired" diagnostics (read-only, no fix yet) ──

const taskRunnerFn = () => {
  const src = readUi();
  return src.slice(src.indexOf('function collectTaskRunnerDiagnostics'), src.indexOf('async function collectConceptOutputDiagnostics'));
};
const conceptOutFn = () => {
  const src = readUi();
  return src.slice(src.indexOf('async function collectConceptOutputDiagnostics'), src.indexOf('// ── Diagnostics ──'));
};

test('B8AB: report adds task_runner_diagnostics + wf01_concept_output', () => {
  const src = readUi();
  assert.ok(/task_runner_diagnostics: null/.test(src) && /wf01_concept_output: null/.test(src), 'report inits both diagnostics');
});

test('B8AB: task-runner diagnostics parse n8n.log offer/reject stats (counts + redacted reasons)', () => {
  const fn = taskRunnerFn();
  for (const f of ['rejected_task_count', 'rejected_task_ids', 'reject_reasons', 'offer_expired_count', 'registered_runner_seen', 'runner_ready_before_first_task', 'code_node_tasks_seen', 'task_runner_mode', 'runner_config_redacted']) {
    assert.ok(fn.includes(f), `task_runner_diagnostics must include ${f}`);
  }
  assert.ok(/rejected by Runner with reason "/.test(fn), 'must scan the n8n.log reject lines');
  assert.ok(/Offer expired/.test(fn) && /offer_expired_count = /.test(fn), 'must count Offer expired specifically');
  assert.ok(/redactString\(m\[2\]\)/.test(fn), 'reject reasons must be redacted');
});

test('B8AB: diagnostics record the HARDCODED, non-configurable 5s offer window finding', () => {
  const fn = taskRunnerFn();
  assert.ok(/offer_valid_time_ms_hardcoded: 5000/.test(fn), 'must record the hardcoded 5s offer window');
  assert.ok(/offer_window_configurable: false/.test(fn), 'must record that the offer window is NOT env-configurable');
});

test('B8AB: concept-output diagnostics capture the UI status + /active state + concept count', () => {
  const fn = conceptOutFn();
  assert.ok(/\/api\/wf01-status/.test(fn), 'must query the UI /api/wf01-status');
  assert.ok(/concept-not-ready-active-dom\.json/.test(fn), 'must dump the /active DOM when concept not ready');
  assert.ok(/concept_count_in_execution/.test(fn), 'must compute a concept count from the execution data');
  // It is invoked when the concept never becomes selectable.
  const src = readUi();
  assert.ok(/if \(!conceptReady\) \{[\s\S]{0,400}await collectConceptOutputDiagnostics\(report, page, uiBase, since\)/.test(src),
    'must run concept-output diagnostics when concept is not ready');
});

test('B8AB: the new diagnostics are READ-ONLY and never leak secrets', () => {
  const tr = taskRunnerFn(); const co = conceptOutFn();
  for (const fn of [tr, co]) {
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP)\b/.test(fn), 'must not write to the n8n DB');
    assert.ok(!/base64/.test(fn), 'must not reference base64');
    assert.ok(!/Authorization|api_key|bearer/i.test(fn), 'must not read Authorization/api_key');
  }
  assert.ok(/redactString\(JSON\.stringify\(raw\)\)\.slice\(0, 800\)/.test(co), 'the wf01-status response is redacted + truncated');
});

test('B8AB: this phase changes ONLY ui-smoke diagnostics — no launcher/WF01/runner-config edits here', () => {
  // The fix scope is diagnostics-only; the launcher n8n runner env block is unchanged
  // (still TASK_TIMEOUT/TASK_REQUEST_TIMEOUT only — the real runner fix is a later phase).
  const launcher = fs.readFileSync(path.join(ROOT, 'client', 'launcher.mjs'), 'utf8');
  assert.ok(/N8N_RUNNERS_TASK_TIMEOUT: '900'/.test(launcher), 'launcher runner env unchanged in this phase');
  // Stop-proof flags intact.
  const src = readUi();
  assert.ok(/video_generation_skipped: true/.test(src) && /veo_not_called: true/.test(src), 'Veo/video stop-proof flags intact');
});
