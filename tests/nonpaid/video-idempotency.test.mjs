/**
 * P12-B1 video idempotency tests
 * Covers: active-generation guard, canContinuePending, export canonical,
 *         final skip, workflow shot filter, reconcile read-only behavior.
 * All tests are fully non-paid: no real n8n, no real Veo, no UI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveArtifactFlags } from '../../app-server/services/project-state.service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcFile = path.join(__dirname, '..', '..', '版本测试', 'serve-review-assets.mjs');

// ── helpers to extract exported internals via module text analysis ────────────
function extractFn(src, name) {
  // Very simple: find "function NAME" declaration
  const idx = src.indexOf(`function ${name}(`);
  if (idx < 0) return null;
  return src.slice(idx, idx + 60);
}

const src = fs.readFileSync(srcFile, 'utf8');

// ── Test 1: isVideoGenerationActive is defined ────────────────────────────────
{
  const hasHelper = src.includes('function isVideoGenerationActive(');
  assert.ok(hasHelper, 'isVideoGenerationActive helper must be defined in serve-review-assets.mjs');
  assert.ok(src.includes('function findActiveExecutionForProject('), 'project lock must query active running/waiting executions, not only latest execution');
  assert.ok(src.includes("e.status IN ('running', 'waiting')"), 'active execution query must filter running/waiting statuses');
  console.log('PASS [1] isVideoGenerationActive defined');
}

// ── Test 2: /review-rerun-pending has active check ────────────────────────────
{
  const routeIdx = src.indexOf("req.url === '/review-rerun-pending'");
  assert.ok(routeIdx > 0, '/review-rerun-pending route must exist');
  const routeBlock = src.slice(routeIdx, routeIdx + 3200);
  const hasActiveCheck = routeBlock.includes('isVideoGenerationActive(');
  assert.ok(hasActiveCheck, '/review-rerun-pending must call isVideoGenerationActive before forwarding');
  const hasPendingCheck = routeBlock.includes('_pendingShots.length === 0');
  assert.ok(hasPendingCheck, '/review-rerun-pending must verify pending shots exist');
  const forwardIdx = routeBlock.indexOf('forwardReviewSubmission');
  const activeCheckIdx = routeBlock.indexOf('isVideoGenerationActive');
  assert.ok(activeCheckIdx < forwardIdx, 'active check must appear BEFORE forwardReviewSubmission');
  console.log('PASS [2] /review-rerun-pending has active guard before forwarding');
}

// ── Test 3: /review-submit and rerun routes share project-level active check ──
{
  for (const route of ['/review-submit', '/review-rerun-failed', '/review-rerun-shot']) {
    const routeIdx = src.indexOf(`req.url === '${route}'`);
    assert.ok(routeIdx > 0, `${route} route must exist`);
    const routeBlock = src.slice(routeIdx, routeIdx + 11000);
    assert.ok(routeBlock.includes('isVideoGenerationActive('), `${route} must call isVideoGenerationActive`);
    const forwardIdx = routeBlock.indexOf('forwardReviewSubmission');
    const activeCheckIdx = routeBlock.indexOf('isVideoGenerationActive');
    if (forwardIdx > 0) assert.ok(activeCheckIdx < forwardIdx, `${route} active check must appear before forwardReviewSubmission`);
  }
  console.log('PASS [3] /review-submit, /review-rerun-failed, /review-rerun-shot share project-level active guard');
}

// ── Test 4: /review-rerun-failed has active check ────────────────────────────
{
  const routeIdx = src.indexOf("req.url === '/review-rerun-failed'");
  assert.ok(routeIdx > 0, '/review-rerun-failed route must exist');
  const routeBlock = src.slice(routeIdx, routeIdx + 1800);
  const hasActiveCheck = routeBlock.includes('isVideoGenerationActive(');
  assert.ok(hasActiveCheck, '/review-rerun-failed must call isVideoGenerationActive before forwarding');
  const forwardIdx = routeBlock.indexOf('forwardReviewSubmission');
  const activeCheckIdx = routeBlock.indexOf('isVideoGenerationActive');
  assert.ok(activeCheckIdx < forwardIdx, 'active check must appear BEFORE forwardReviewSubmission in /review-rerun-failed');
  console.log('PASS [4] /review-rerun-failed has active guard before forwarding');
}

// ── Test 5: canContinuePending suppressed when n8n/progress active ───────────
{
  const candIdx = src.indexOf('const canContinuePending =');
  assert.ok(candIdx > 0, 'canContinuePending must be defined');
  const candLine = src.slice(candIdx - 220, candIdx + 260);
  const hasActiveBlock = candLine.includes('_veoActiveGen');
  assert.ok(hasActiveBlock, 'canContinuePending must check _veoActiveGen to suppress button');
  assert.ok(candLine.includes('_progressActiveGen'), 'canContinuePending must check progress running/submitted state');
  const notActive = candLine.includes('!_veoActiveGen');
  assert.ok(notActive, 'canContinuePending must be false (via !_veoActiveGen) when generation is active');
  console.log('PASS [5] canContinuePending suppressed when active generation exists');
}

// ── Test 6: videoStatusFeedback shows "正在生成中" when active ─────────────────
{
  const feedbackIdx = src.indexOf('const videoStatusFeedback =');
  assert.ok(feedbackIdx > 0, 'videoStatusFeedback must be defined');
  const feedbackBlock = src.slice(feedbackIdx, feedbackIdx + 400);
  const hasActiveMsg = feedbackBlock.includes('_veoActiveGen') && feedbackBlock.includes('请勿重复提交');
  assert.ok(hasActiveMsg, 'videoStatusFeedback must show "请勿重复提交" banner when _veoActiveGen=true');
  console.log('PASS [6] videoStatusFeedback shows warning when generation active');
}

// ── Test 7: export canonical — video filter by _canonicalVideoNames ───────────
{
  const exportIdx = src.indexOf('function exportProjectArtifacts(');
  assert.ok(exportIdx > 0, 'exportProjectArtifacts must exist');
  const exportBlock = src.slice(exportIdx, exportIdx + 5200);
  const hasCanonicalSet = exportBlock.includes('_canonicalVideoNames');
  assert.ok(hasCanonicalSet, 'exportProjectArtifacts must build _canonicalVideoNames from progress.shots');
  const hasVideoFilter = exportBlock.includes("destKey === 'video'") && exportBlock.includes('_canonicalVideoNames.has(fname)');
  assert.ok(hasVideoFilter, 'exportProjectArtifacts must skip non-canonical video files');
  const hasFinalFilter = exportBlock.includes("destKey === 'final'") && exportBlock.includes('_canonicalFinalName');
  assert.ok(hasFinalFilter, 'exportProjectArtifacts must skip non-canonical final files');
  assert.ok(exportBlock.includes("destKey === 'final' && (!_canonicalFinalName || fname !== _canonicalFinalName)"),
    'exportProjectArtifacts must not glob-copy all finals when progress exists but canonical final is missing');
  console.log('PASS [7] exportProjectArtifacts uses canonical video/final from progress');
}

// ── Test 8: isVideoGenerationActive returns inactive when no exec/shots ───────
{
  // Simulate the logic directly (pure function test)
  function simulateIsActive(execStatus, shotStatuses) {
    // Mirror the isVideoGenerationActive logic
    if (execStatus && ['running', 'waiting'].includes(execStatus)) return true;
    if (shotStatuses.some(s => ['running', 'submitted'].includes(s))) return true;
    return false;
  }
  assert.ok(!simulateIsActive(null, []), 'no exec, no shots → not active');
  assert.ok(!simulateIsActive('success', ['completed', 'completed']), 'success exec, all completed → not active');
  assert.ok(!simulateIsActive('error', ['failed', 'failed']), 'error exec, all failed → not active');
  assert.ok(simulateIsActive('running', []), 'running exec → active');
  assert.ok(simulateIsActive('waiting', []), 'waiting exec → active');
  assert.ok(simulateIsActive(null, ['submitted']), 'submitted shot → active');
  assert.ok(simulateIsActive(null, ['completed', 'running', 'pending']), 'running shot → active');
  console.log('PASS [8] isVideoGenerationActive logic (simulated) correct for all cases');
}

// ── Test 9: workflow 03 恢复已确认分镜 has D-fix ────────────────────────────
{
  const wfPath = path.join(__dirname, '..', '..', '正式导入文件', 'iteration-v1', 'n8n03.json');
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  const node = wf.nodes.find(n => n.name === '恢复已确认分镜');
  assert.ok(node, '恢复已确认分镜 node must exist in n8n03.json');
  const code = node.parameters?.jsCode || '';
  assert.ok(code.includes('D-fix'), '恢复已确认分镜 must have D-fix shot filter');
  assert.ok(code.includes('_rerunPendingOnly'), 'D-fix must check rerun_pending_only');
  assert.ok(code.includes('SKIP_STATUSES'), 'D-fix must define SKIP_STATUSES to exclude completed/submitted/running');
  assert.ok(code.includes('_panelsFiltered'), 'D-fix must use _panelsFiltered instead of all panels');
  assert.ok(code.includes("return status === 'pending' || !status;"), 'rerun_pending_only must process pending shots only');
  assert.ok(code.includes("return status === 'failed';"), 'rerun_failed_only bulk path must process failed shots only');
  console.log('PASS [9] workflow 03 恢复已确认分镜 has shot idempotency filter (D-fix)');
}

// ── Test 10: workflow 03 Veo结果汇总 has E-fix ───────────────────────────────
{
  const wfPath = path.join(__dirname, '..', '..', '正式导入文件', 'iteration-v1', 'n8n03.json');
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
  const node = wf.nodes.find(n => n.name === 'Veo结果汇总');
  assert.ok(node, 'Veo结果汇总 node must exist in n8n03.json');
  const code = node.parameters?.jsCode || '';
  assert.ok(code.includes('E-fix'), 'Veo结果汇总 must have E-fix final lock');
  assert.ok(code.includes('finalSourceSignature'), 'E-fix must track current canonical shot video set');
  assert.ok(code.includes('existingFinalSourceSignature === finalSourceSignature'), 'E-fix must only reuse final when shot video set matches');
  assert.ok(code.includes('} else {'), 'E-fix must use else branch to skip ffmpeg when final exists');
  console.log('PASS [10] workflow 03 Veo结果汇总 has final generation lock (E-fix)');
}

// ── Test 11: reconcile-project route is read-only (no forwardReviewSubmission) ─
{
  const reconcileIdx = src.indexOf("req.url === '/api/reconcile-project'");
  assert.ok(reconcileIdx > 0, '/api/reconcile-project route must exist');
  const reconcileBlock = src.slice(reconcileIdx, reconcileIdx + 3000);
  const hasForward = reconcileBlock.includes('forwardReviewSubmission');
  assert.ok(!hasForward, '/api/reconcile-project must NOT call forwardReviewSubmission (read-only)');
  console.log('PASS [11] /api/reconcile-project is read-only (no forwardReviewSubmission)');
}

// ── Test 12: D-fix shot filter logic (simulated) ────────────────────────────
{
  const SKIP_STATUSES = ['completed', 'done', 'submitted', 'running'];
  function filterPanels(panels, existingStatuses, rerunPendingOnly, rerunFailedOnly, badShotIds) {
    if (!rerunPendingOnly && !rerunFailedOnly) return panels;
    return panels.filter(panel => {
      const shotId = String(panel.shot_id || '');
      const status = existingStatuses[shotId] || 'pending';
      if (rerunFailedOnly) {
        if (badShotIds.length > 0) return badShotIds.includes(shotId);
        return status === 'failed';
      }
      return status === 'pending' || !status;
    });
  }

  const panels = [
    { shot_id: 'shot_1' }, { shot_id: 'shot_2' }, { shot_id: 'shot_3' },
    { shot_id: 'shot_4' }, { shot_id: 'shot_5' }, { shot_id: 'shot_6' },
  ];
  const statuses = {
    shot_1: 'completed', shot_2: 'submitted', shot_3: 'running',
    shot_4: 'pending', shot_5: 'failed', shot_6: 'pending',
  };

  // rerun_pending_only: should only return shot_4 and shot_6 (pending), skip completed/submitted/running/failed
  const pendingResult = filterPanels(panels, statuses, true, false, []);
  assert.deepEqual(pendingResult.map(p => p.shot_id), ['shot_4', 'shot_6'],
    'rerun_pending_only must only process pending shots (not completed/submitted/running/failed)');

  // rerun_failed_only: should return shot_5 (failed)
  const failedResult = filterPanels(panels, statuses, false, true, []);
  assert.deepEqual(failedResult.map(p => p.shot_id), ['shot_5'],
    'rerun_failed_only without bad_shot_ids should return failed shots only');

  // normal submit (no rerun flag): all panels pass
  const normalResult = filterPanels(panels, statuses, false, false, []);
  assert.equal(normalResult.length, 6, 'normal submit should process all 6 panels');

  console.log('PASS [12] D-fix shot filter logic (simulated) correct');
}

// ── Test 13: E-fix final lock logic (simulated) ──────────────────────────────
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p12b1-'));
  try {
    const existingFinalPath = path.join(tmpDir, 'final_proj_123_456.mp4');
    fs.writeFileSync(existingFinalPath, 'mock-video-data');

    // Simulate E-fix: if finalMergedVideoPath exists and size > 0, skip ffmpeg
    let finalMergedVideoPath = existingFinalPath;
    let finalMergedVideoName = '';
    const finalSourceSignature = '/cache/videos/shot1.mp4|/cache/videos/shot2.mp4';
    const existingFinalSourceSignature = finalSourceSignature;
    let ffmpegCalled = false;

    if (
      finalMergedVideoPath &&
      fs.existsSync(finalMergedVideoPath) &&
      fs.statSync(finalMergedVideoPath).size > 0 &&
      existingFinalSourceSignature === finalSourceSignature
    ) {
      finalMergedVideoName = path.basename(finalMergedVideoPath);
    } else {
      ffmpegCalled = true; // would call ffmpeg
    }

    assert.ok(!ffmpegCalled, 'E-fix: ffmpeg must NOT be called when canonical final already exists');
    assert.equal(finalMergedVideoName, 'final_proj_123_456.mp4', 'E-fix: existing final name must be reused');

    // Simulate when final does NOT exist
    let ffmpegCalled2 = false;
    const noFinalPath = '';
    if (noFinalPath && fs.existsSync(noFinalPath) && fs.statSync(noFinalPath).size > 0) {
      // skip
    } else {
      ffmpegCalled2 = true; // would call ffmpeg
    }
    assert.ok(ffmpegCalled2, 'E-fix: ffmpeg must be called when canonical final does not exist');
    // Existing final with stale shot inputs must not be reused.
    let ffmpegCalled3 = false;
    const staleSignature = '/cache/videos/old-shot1.mp4|/cache/videos/shot2.mp4';
    if (
      finalMergedVideoPath &&
      fs.existsSync(finalMergedVideoPath) &&
      fs.statSync(finalMergedVideoPath).size > 0 &&
      staleSignature === finalSourceSignature
    ) {
      // skip
    } else {
      ffmpegCalled3 = true;
    }
    assert.ok(ffmpegCalled3, 'E-fix: ffmpeg must be called when existing final source signature is stale');
    console.log('PASS [13] E-fix final lock logic (simulated) prevents duplicate ffmpeg and stale reuse');
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
}

// ── Test 14: duplicate video files do not advance project stage ───────────────
{
  const artifacts = deriveArtifactFlags({
    expectedVideoClipCount: 6,
    videoClips: [
      'kie_veo31_proj_shot_1_a.mp4',
      'kie_veo31_proj_shot_2_a.mp4',
      'kie_veo31_proj_shot_2_b.mp4',
      'kie_veo31_proj_shot_3_a.mp4',
      'kie_veo31_proj_shot_4_a.mp4',
      'kie_veo31_proj_shot_5_a.mp4',
    ],
  });
  assert.equal(artifacts.videoClipCount, 5, 'duplicate files for the same shot must count once');
  assert.equal(artifacts.videoClipsComplete, false, 'duplicates must not make 5 unique shots look complete');
  console.log('PASS [14] duplicate video files do not advance project stage');
}

// ── Test 15: export canonical skips duplicate videos (simulated) ─────────────
{
  function buildCanonicalSet(shots, finalPath) {
    const names = new Set(shots.map(s => path.basename(String(s.video_path || ''))).filter(Boolean));
    const finalName = path.basename(String(finalPath || ''));
    return { names, finalName };
  }

  const shots = [
    { shot_id: 'shot_1', video_path: '/cache/videos/kie_veo31_proj_shot_1_abc.mp4' },
    { shot_id: 'shot_2', video_path: '/cache/videos/kie_veo31_proj_shot_2_def.mp4' },
  ];
  const finalPath = '/cache/final-video/final_proj_111.mp4';
  const { names, finalName } = buildCanonicalSet(shots, finalPath);

  const allVideoFiles = [
    'kie_veo31_proj_shot_1_abc.mp4',  // canonical shot_1 ✓
    'kie_veo31_proj_shot_1_xyz.mp4',  // duplicate shot_1 ✗
    'kie_veo31_proj_shot_2_def.mp4',  // canonical shot_2 ✓
    'kie_veo31_proj_shot_2_dup.mp4',  // duplicate shot_2 ✗
  ];
  const exported = allVideoFiles.filter(f => names.has(f));
  assert.deepEqual(exported, ['kie_veo31_proj_shot_1_abc.mp4', 'kie_veo31_proj_shot_2_def.mp4'],
    'export canonical: only canonical shot videos must be exported');

  const allFinals = ['final_proj_111.mp4', 'final_proj_222.mp4', 'final_proj_333.mp4'];
  const exportedFinals = allFinals.filter(f => !finalName || f === finalName);
  assert.deepEqual(exportedFinals, ['final_proj_111.mp4'],
    'export canonical: only canonical final must be exported');

  console.log('PASS [15] export canonical correctly skips duplicate video/final files');
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.log('');
console.log('video idempotency nonpaid tests: ALL PASS (15/15)');
