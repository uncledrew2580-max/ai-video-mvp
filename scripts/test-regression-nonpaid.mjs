#!/usr/bin/env node
/**
 * P17-REGRESSION-HARDENING — non-paid regression test suite
 *
 * Starts serve-review-assets.mjs on an isolated temp dir + test port,
 * exercises deriveProjectStage, reconcile endpoint, poll endpoints, and
 * page smoke tests. No model calls, no n8n triggers, no real form submission.
 *
 * Usage: node scripts/test-regression-nonpaid.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_PORT = 18899;
const BASE_URL  = `http://127.0.0.1:${TEST_PORT}`;
let   passed    = 0;
let   failed    = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function get(urlPath) {
  const r = await fetch(`${BASE_URL}${urlPath}`, { signal: AbortSignal.timeout(6000) });
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json().catch(() => null) : await r.text().catch(() => '');
  return { status: r.status, body };
}

async function post(urlPath, data) {
  const r = await fetch(`${BASE_URL}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(6000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

async function waitForServer(maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/api/env-status`, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return;
    } catch {}
    await new Promise(r => setTimeout(r, 350));
  }
  throw new Error('Server did not start within timeout');
}

// ── test setup ────────────────────────────────────────────────────────────────

const tmpRoot    = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-video-test-'));
const cacheRoot  = path.join(tmpRoot, '.n8n-local-cache');
const projRoot   = path.join(cacheRoot, 'project-state');
const rcRoot     = path.join(cacheRoot, 'review-context');
const scRoot     = path.join(cacheRoot, 'script-context');
const progRoot   = path.join(cacheRoot, 'review-progress');
const nbRoot     = path.join(cacheRoot, 'nanobanana');
const panelFull  = path.join(cacheRoot, '分镜图裁剪', 'full');
const finalVid   = path.join(cacheRoot, 'final-video');
const videosDir  = path.join(cacheRoot, 'videos');
const moviesDir  = path.join(tmpRoot, 'movies-output');  // simulates Movies Final export dir

const SERVER_SRC = path.join(import.meta.dirname, '..', '版本测试', 'serve-review-assets.mjs');

// IDs used across tests
const PID_BASE      = 'proj_test_reg_001'; // primary project — artifacts added progressively
const PID_SC        = 'proj_test_reg_002'; // script_context test
const PID_CSC       = 'proj_test_reg_003'; // confirmed_script_context test
const PID_PANEL     = 'proj_test_reg_004'; // storyboard panel images (no review_context)
const PID_PROG      = 'proj_test_reg_005'; // review_progress all shots completed
const PID_FINAL     = 'proj_test_reg_006'; // internal final-video mp4
const PID_EXPORTED  = 'proj_test_reg_007'; // Movies output final mp4
const PID_NOCHANGE  = 'proj_test_reg_008'; // idempotent test
const PID_SMOKE     = 'proj_test_reg_009'; // page smoke tests

// Fake minimal config — output dir points to our temp movies dir
writeJson(path.join(tmpRoot, 'local-config.json'), {
  kie: { api_key: '' },
  output: {
    video_dir: moviesDir,
    final_dir: moviesDir,
  },
});

const TEST_DB_PATH = path.join(tmpRoot, 'test.sqlite');

// Create minimal n8n-compatible SQLite schema (used by findLatestExecutionForProject)
execFileSync('sqlite3', [TEST_DB_PATH,
  `CREATE TABLE execution_entity (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     workflowId TEXT, status TEXT, mode TEXT,
     startedAt TEXT, stoppedAt TEXT, finished INTEGER DEFAULT 1
   );
   CREATE TABLE execution_data (executionId INTEGER, data TEXT);`
], { encoding: 'utf8' });

function insertFakeExecution(dbPath, projectId, workflowId, execStatus) {
  const safeWf  = workflowId.replace(/'/g, "''");
  const safePid = projectId.replace(/'/g, "''");
  execFileSync('sqlite3', [dbPath,
    `INSERT INTO execution_entity (workflowId, status, mode, startedAt, stoppedAt)
     VALUES ('${safeWf}', '${execStatus}', 'webhook',
             '2026-06-01 09:00:00', '2026-06-01 09:12:28');
     INSERT INTO execution_data (executionId, data)
     VALUES (last_insert_rowid(), '{"project_id":"${safePid}"}');`
  ], { encoding: 'utf8' });
}

const serverEnv = {
  ...process.env,
  WORKFLOW_DATA_ROOT:   tmpRoot,
  REVIEW_ASSET_PORT:    String(TEST_PORT),
  AI_VIDEO_CONFIG_PATH: path.join(tmpRoot, 'local-config.json'),
  N8N_DB_PATH:          TEST_DB_PATH,
};

console.log(`\nP17-REGRESSION-HARDENING non-paid test suite`);
console.log(`Temp dir: ${tmpRoot}`);
console.log(`Server:   ${SERVER_SRC}\n`);

const srv = spawn(process.execPath, [SERVER_SRC], {
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', () => {});
srv.on('error', err => { console.error('Server spawn error:', err.message); process.exit(1); });

try {
  await waitForServer();
  console.log('Server ready.\n');

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP A: basic API contract
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('TC01: reconcile-project — missing project_id → 400');
  {
    const r = await post('/api/reconcile-project', {});
    assert(r.status === 400, 'HTTP 400');
    assert(r.body?.ok === false, 'ok=false');
  }

  console.log('\nTC02: reconcile-project — no project state → ok=true, no patch, has next_url');
  {
    const r = await post('/api/reconcile-project', { project_id: PID_BASE });
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.ok === true, 'ok=true');
    assert(Array.isArray(r.body?.patched) && r.body.patched.length === 0, 'patched=[]');
    assert('next_url' in r.body, 'next_url field present');
    assert(typeof r.body.next_url === 'string', 'next_url is string');
  }

  console.log('\nTC03: storyboard-poll — no review_context → ready=false');
  {
    const r = await get(`/api/storyboard-poll?project_id=${PID_BASE}`);
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.ready === false, 'ready=false');
  }

  console.log('\nTC04: concept-poll — no script_context → ready=false');
  {
    const r = await get(`/api/concept-poll?project_id=${PID_BASE}`);
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.ready === false, 'ready=false');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP B: artifact-first status derivation — script levels
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\nTC05: concept-poll — script_context exists → ready=true + scriptUrl');
  {
    writeJson(path.join(scRoot, `script_context_${PID_SC}.json`), { project_id: PID_SC, shots: [] });
    const r = await get(`/api/concept-poll?project_id=${PID_SC}`);
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.ready === true, 'ready=true');
    assert(r.body?.scriptUrl?.includes(PID_SC), 'scriptUrl contains PID');
  }

  console.log('\nTC06: reconcile — stale status=script_generating + script_context exists → script_generated, next_url → /script-review');
  {
    writeJson(path.join(projRoot, `project_${PID_SC}.json`), {
      project_id: PID_SC, status: 'script_generating', stage: 'script_generating',
      updated_at: new Date().toISOString(),
    });
    const r = await post('/api/reconcile-project', { project_id: PID_SC });
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.ok === true, 'ok=true');
    assert(r.body?.after?.status === 'script_generated', `status=script_generated (got ${r.body?.after?.status})`);
    assert(r.body?.after?.stage === 'script_generated', `stage=script_generated (got ${r.body?.after?.stage})`);
    assert(r.body?.next_url?.includes('/script-review'), `next_url → /script-review (got ${r.body?.next_url})`);
    assert(r.body?.next_url === r.body?.activeRoute, 'next_url === activeRoute');
  }

  console.log('\nTC07: reconcile — stale status=script_generated + confirmed_script_context → script_confirmed, not regressed');
  {
    writeJson(path.join(scRoot, `confirmed_script_context_${PID_CSC}.json`), {
      project_id: PID_CSC, _confirmed: true, confirmed_at: new Date().toISOString(),
    });
    writeJson(path.join(projRoot, `project_${PID_CSC}.json`), {
      project_id: PID_CSC, status: 'script_generated', stage: 'script_generated',
      updated_at: new Date().toISOString(),
    });
    const r = await post('/api/reconcile-project', { project_id: PID_CSC });
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.after?.status === 'script_confirmed', `status=script_confirmed (got ${r.body?.after?.status})`);
    assert(r.body?.after?.stage === 'script_confirmed', `stage=script_confirmed (got ${r.body?.after?.stage})`);
    // must not regress from script_confirmed to something lower
    assert(!['script_generating','script_generated','creative_generated'].includes(r.body?.after?.status),
      'status not regressed to lower level');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP C: storyboard levels
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\nTC08: reconcile — storyboard panel images exist but no review_context → storyboard_generated (not script/storyboard_generating)');
  {
    // Create a panel_full image for PID_PANEL
    const ptok = PID_PANEL.toLowerCase();
    writeJson(path.join(panelFull, `panel_full_${ptok}_001.jpg`), {});  // fake jpg (JSON content, just needs to exist)
    writeJson(path.join(projRoot, `project_${PID_PANEL}.json`), {
      project_id: PID_PANEL, status: 'storyboard_generating', stage: 'storyboard_generating',
      updated_at: new Date().toISOString(),
    });
    const r = await post('/api/reconcile-project', { project_id: PID_PANEL });
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.after?.status === 'storyboard_generated', `status=storyboard_generated (got ${r.body?.after?.status})`);
    // stage should NOT be storyboard_generating — either storyboard_generated or storyboard_ready_for_review
    assert(r.body?.after?.stage !== 'storyboard_generating', `stage not storyboard_generating (got ${r.body?.after?.stage})`);
    assert(r.body?.after?.stage !== 'script_generating', `stage not script_generating (got ${r.body?.after?.stage})`);
    // next_url should route to storyboard-status (no review_context) NOT script-review
    assert(r.body?.next_url?.includes('/storyboard-status') || r.body?.next_url?.includes('/reviews/'), `next_url is storyboard or review route (got ${r.body?.next_url})`);
  }

  console.log('\nTC09: storyboard-poll — review_context exists → ready=true + reviewUrl');
  {
    const rcName = `review_context_${PID_BASE}_1_9999999999.json`;
    writeJson(path.join(rcRoot, rcName), { project_id: PID_BASE, panels: [] });
    const r = await get(`/api/storyboard-poll?project_id=${PID_BASE}`);
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.ready === true, 'ready=true');
    assert(r.body?.reviewUrl?.includes(encodeURIComponent(rcName)), 'reviewUrl references review_context file');
  }

  console.log('\nTC10: reconcile — stale stage=storyboard_generating + review_context exists → storyboard_ready_for_review, next_url → /reviews/item');
  {
    writeJson(path.join(projRoot, `project_${PID_BASE}.json`), {
      project_id: PID_BASE, status: 'storyboard_generating', stage: 'storyboard_generating',
      updated_at: new Date().toISOString(),
    });
    const r = await post('/api/reconcile-project', { project_id: PID_BASE });
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.ok === true, 'ok=true');
    assert(r.body?.patched?.includes('stage'), 'stage in patched');
    assert(r.body?.after?.stage === 'storyboard_ready_for_review', `stage=storyboard_ready_for_review (got ${r.body?.after?.stage})`);
    assert(r.body?.after?.status === 'storyboard_generated', `status=storyboard_generated (got ${r.body?.after?.status})`);
    assert(r.body?.next_url?.startsWith('/reviews/item'), `next_url → /reviews/item (got ${r.body?.next_url})`);
    assert(r.body?.next_url === r.body?.activeRoute, 'next_url === activeRoute');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP D: video and final levels
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\nTC11: reconcile — review_progress all shots completed → video_clips_generated');
  {
    writeJson(path.join(progRoot, `review_progress_${PID_PROG}.json`), {
      project_id: PID_PROG,
      shots: [
        { shot_id: 's1', status: 'success' },
        { shot_id: 's2', status: 'completed' },
        { shot_id: 's3', status: 'final_generated' },
      ],
    });
    writeJson(path.join(projRoot, `project_${PID_PROG}.json`), {
      project_id: PID_PROG, status: 'video_generating', stage: 'video_generating',
      updated_at: new Date().toISOString(),
    });
    const r = await post('/api/reconcile-project', { project_id: PID_PROG });
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.after?.status === 'video_clips_generated', `status=video_clips_generated (got ${r.body?.after?.status})`);
    assert(r.body?.after?.stage === 'video_clips_generated', `stage=video_clips_generated (got ${r.body?.after?.stage})`);
  }

  console.log('\nTC12: reconcile — internal final-video mp4 exists → final_generated');
  {
    const ptok = PID_FINAL.toLowerCase();
    // Create a real (empty) mp4 file
    fs.mkdirSync(finalVid, { recursive: true });
    fs.writeFileSync(path.join(finalVid, `final_${ptok}_merged.mp4`), '');
    writeJson(path.join(projRoot, `project_${PID_FINAL}.json`), {
      project_id: PID_FINAL, status: 'video_clips_generated', stage: 'video_clips_generated',
      updated_at: new Date().toISOString(),
    });
    const r = await post('/api/reconcile-project', { project_id: PID_FINAL });
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.after?.status === 'final_generated', `status=final_generated (got ${r.body?.after?.status})`);
    assert(r.body?.after?.stage === 'final_generated', `stage=final_generated (got ${r.body?.after?.stage})`);
  }

  console.log('\nTC13: reconcile — Movies Final has project mp4 → exported');
  {
    const ptok = PID_EXPORTED.toLowerCase();
    fs.mkdirSync(moviesDir, { recursive: true });
    fs.writeFileSync(path.join(moviesDir, `${ptok}_final_output.mp4`), '');
    writeJson(path.join(projRoot, `project_${PID_EXPORTED}.json`), {
      project_id: PID_EXPORTED, status: 'final_generated', stage: 'final_generated',
      updated_at: new Date().toISOString(),
    });
    const r = await post('/api/reconcile-project', { project_id: PID_EXPORTED });
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.after?.status === 'exported', `status=exported (got ${r.body?.after?.status})`);
    assert(r.body?.after?.stage === 'exported', `stage=exported (got ${r.body?.after?.stage})`);
  }

  console.log('\nTC14: reconcile — already correct state → idempotent, patched=[]');
  {
    // Use PID_BASE which we just set to storyboard_generated/storyboard_ready_for_review
    const r = await post('/api/reconcile-project', { project_id: PID_BASE });
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.ok === true, 'ok=true');
    assert(r.body?.patched?.length === 0, `patched=[] (got ${JSON.stringify(r.body?.patched)})`);
  }

  console.log('\nTC15: reconcile — invalid/path-traversal project_id → 400');
  {
    const r = await post('/api/reconcile-project', { project_id: '../../../etc/passwd' });
    assert(r.status === 400, 'HTTP 400 for path-traversal project_id');
    assert(r.body?.ok === false, 'ok=false');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP E: page smoke tests
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\nTC16: storyboard-status page — no images, no review_context → shows 生成中 + 同步状态 button');
  {
    const r = await get(`/storyboard-status?project_id=${PID_SMOKE}`);
    assert(r.status === 200, 'HTTP 200');
    assert(typeof r.body === 'string', 'response is HTML');
    assert(r.body.includes('同步状态'), 'page has 同步状态 button');
    assert(r.body.includes('sbSync'), 'page has sbSync JS function');
    assert(r.body.includes('/api/reconcile-project'), 'page references reconcile endpoint');
    assert(r.body.includes('分镜图生成中'), 'page shows 生成中 title when no images');
  }

  console.log('\nTC17: storyboard-status page — panel images exist but no review_context → shows 已生成 message');
  {
    const ptok = PID_PANEL.toLowerCase();
    // panel_full was already created in TC08
    const r = await get(`/storyboard-status?project_id=${PID_PANEL}`);
    assert(r.status === 200, 'HTTP 200');
    assert(r.body.includes('分镜图已生成，正在生成审核数据'), `page shows "分镜图已生成，正在生成审核数据" (snippet: ${String(r.body).slice(0, 300)})`);
  }

  console.log('\nTC18: concept-status page — script_context already exists → shows redirect/script link (not just waiting)');
  {
    // PID_SC has script_context_*.json from TC05
    // We need a concept_context file to render the concept-status page
    const ctxDir = path.join(cacheRoot, 'concept-context');
    writeJson(path.join(ctxDir, `concept_context_${PID_SC}.json`), {
      project_id: PID_SC, product_name: 'Test Product', creative_concepts: [],
    });
    const selectedDir = path.join(cacheRoot, 'selected-concepts');
    writeJson(path.join(selectedDir, `selected_concept_${PID_SC}.json`), {
      selected_concept_id: 'c1', selected_concept_json: { concept_name: 'Test Concept' },
    });
    const r = await get(`/concept-status?context=${encodeURIComponent(`concept_context_${PID_SC}.json`)}`);
    assert(r.status === 200, 'HTTP 200');
    // When script is ready, page should show the script link button, NOT the waiting message
    assert(r.body.includes('/script-review'), 'page links to /script-review when script_context exists');
    assert(!r.body.includes('正在生成脚本框架'), 'page does NOT show 生成中 message when script already ready');
    // JS polling script should NOT be present (only injected when !scriptReady)
    assert(!r.body.includes('doCpPoll'), 'no polling script injected when script already ready');
  }

  console.log('\nTC19: concept-status page — no script_context → shows JS polling script');
  {
    // PID_SMOKE has no script_context
    const ctxDir = path.join(cacheRoot, 'concept-context');
    writeJson(path.join(ctxDir, `concept_context_${PID_SMOKE}.json`), {
      project_id: PID_SMOKE, product_name: 'Smoke Product', creative_concepts: [],
    });
    const selectedDir = path.join(cacheRoot, 'selected-concepts');
    writeJson(path.join(selectedDir, `selected_concept_${PID_SMOKE}.json`), {
      selected_concept_id: 'c1', selected_concept_json: { concept_name: 'Smoke Concept' },
    });
    const r = await get(`/concept-status?context=${encodeURIComponent(`concept_context_${PID_SMOKE}.json`)}`);
    assert(r.status === 200, 'HTTP 200');
    assert(r.body.includes('doCpPoll'), 'JS polling script injected when script not yet ready');
    assert(r.body.includes('/api/concept-poll'), 'polling targets /api/concept-poll endpoint');
    // No meta-refresh
    assert(!r.body.includes('http-equiv="refresh"'), 'no meta-refresh (replaced by JS poll)');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP F: auxiliary API endpoints still accessible
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\nTC20: /api/output-folder-action endpoint is reachable (returns JSON, not 404)');
  {
    // POST with an action that doesn't need real directories — server should parse and respond
    const r = await post('/api/output-folder-action', { action: 'status' });
    // We accept any 2xx/4xx, just not 404 or network error
    assert(r.status !== 404, `endpoint reachable (status=${r.status})`);
    assert(r.body !== null, 'response is JSON');
  }

  console.log('\nTC21: /api/export-project endpoint is reachable — no-files response, not 404');
  {
    const r = await post('/api/export-project', { project_id: PID_SMOKE });
    // Expect 200 or 4xx (output dirs not configured), just not 404
    assert(r.status !== 404, `endpoint reachable (status=${r.status})`);
    assert(r.body !== null, 'response is JSON');
    // Should include expected fields
    assert('ok' in r.body || 'error' in r.body || 'errors' in r.body, 'response has ok/error field');
  }

  console.log('\nTC22: /api/reconcile-project returns both activeRoute and next_url equal');
  {
    const r = await post('/api/reconcile-project', { project_id: PID_BASE });
    assert(r.status === 200, 'HTTP 200');
    assert('next_url' in r.body, 'next_url present');
    assert('activeRoute' in r.body, 'activeRoute present');
    assert(r.body.next_url === r.body.activeRoute, `next_url === activeRoute (${r.body.next_url})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP G: P17-REGRESSION-HARDENING-FIX
  // ═══════════════════════════════════════════════════════════════════════════

  const PID_SCRIPTFAIL = 'proj_test_reg_010';
  const PID_SINCE_OLD  = 'proj_test_reg_011';
  const PID_SINCE_NEW  = 'proj_test_reg_012';

  console.log('\nTC23: Level 7.5 — concept selected + no script_context + scriptGenerateV1 error → reconcile derives script_failed + user_message');
  {
    // project_state: creative_generated (pre-failure, not yet patched)
    writeJson(path.join(projRoot, `project_${PID_SCRIPTFAIL}.json`), {
      project_id: PID_SCRIPTFAIL, status: 'creative_generated', stage: 'creative_generated',
      updated_at: new Date().toISOString(),
    });
    // concept_context exists
    writeJson(path.join(cacheRoot, 'concept-context', `concept_context_${PID_SCRIPTFAIL}.json`), {
      project_id: PID_SCRIPTFAIL, product_name: 'Test Fail Product', creative_concepts: [],
    });
    // selected_concept sidecar exists (required for Level 7.5 check)
    writeJson(path.join(cacheRoot, 'selected-concepts', `selected_concept_${PID_SCRIPTFAIL}.json`), {
      selected_concept_id: 'c1', selected_concept_json: { concept_name: 'Test Fail Concept' },
    });
    // NO script_context file — intentionally absent
    // fake scriptGenerateV1 error execution in real SQLite DB
    insertFakeExecution(TEST_DB_PATH, PID_SCRIPTFAIL, 'scriptGenerateV1', 'error');
    // Reconcile: Level 7.5 must detect sidecar + error exec → patch to script_failed
    const r = await post('/api/reconcile-project', { project_id: PID_SCRIPTFAIL });
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.ok === true, 'ok=true');
    assert(r.body?.after?.status === 'failed', `after.status=failed (got ${r.body?.after?.status})`);
    assert(r.body?.after?.stage === 'script_failed', `after.stage=script_failed (got ${r.body?.after?.stage})`);
    assert(typeof r.body?.user_message === 'string' && r.body.user_message.includes('脚本框架生成失败'),
      `user_message contains 脚本框架生成失败 (got ${r.body?.user_message})`);
    assert('derived_stage' in r.body, 'derived_stage field present');
    assert('user_message' in (r.body?.after ?? {}), 'after.user_message field present');
  }

  console.log('\nTC24: /script-review — same project after reconcile → shows error panel, not 生成中');
  {
    const r = await get(`/script-review?project_id=${PID_SCRIPTFAIL}`);
    assert(r.status === 200, 'HTTP 200');
    assert(r.body.includes('脚本框架生成失败'), 'page shows 脚本框架生成失败 error');
    assert(!r.body.includes('脚本框架生成中'), 'page does NOT show 生成中');
  }

  console.log('\nTC25: /api/env-status — activeProject.project_id is non-null non-empty string');
  {
    const r = await get('/api/env-status');
    assert(r.status === 200, 'HTTP 200');
    assert(r.body?.activeProject !== null && r.body?.activeProject !== undefined,
      'activeProject object present');
    const pid = r.body?.activeProject?.project_id;
    assert(typeof pid === 'string' && pid.length > 0 && pid !== 'null' && pid !== 'undefined',
      `activeProject.project_id is valid non-empty string (got ${JSON.stringify(pid)})`);
  }

  console.log('\nTC26: /submitted?since — nav uses concept_context newer than since, not stale activeProject');
  {
    const sinceTs = Date.now() - 3000;
    writeJson(path.join(projRoot, `project_${PID_SINCE_OLD}.json`), {
      project_id: PID_SINCE_OLD, status: 'script_generated', stage: 'script_generated',
      updated_at: new Date().toISOString(),
    });
    writeJson(path.join(cacheRoot, 'concept-context', `concept_context_${PID_SINCE_NEW}.json`), {
      project_id: PID_SINCE_NEW, product_name: 'Since Test Product', creative_concepts: [],
    });
    const r = await get(`/submitted?since=${sinceTs}`);
    assert(r.status === 200, 'HTTP 200');
    assert(r.body.includes(PID_SINCE_NEW), `nav includes new project ${PID_SINCE_NEW}`);
    assert(!r.body.includes(PID_SINCE_OLD), `nav does NOT include stale project ${PID_SINCE_OLD}`);
  }

} finally {
  srv.kill('SIGTERM');
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('REGRESSION TESTS FAILED');
  process.exit(1);
} else {
  console.log('All regression tests passed.');
}
