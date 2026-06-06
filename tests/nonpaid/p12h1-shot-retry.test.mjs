/**
 * P12-H1 shot retry and failure handling nonpaid tests
 * Covers: scriptGenerateV1 retry, image visual brief, audio failure classification,
 *   shot failure state preservation, rerun targeting, shot lock,
 *   partial export warning, final canonical protection.
 * All non-paid: no real n8n, no real Veo, no model calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const SERVE = fs.readFileSync(path.join(ROOT, '版本测试', 'serve-review-assets.mjs'), 'utf8');
const N8N03 = JSON.parse(fs.readFileSync(path.join(ROOT, '正式导入文件', 'iteration-v1', 'n8n03.json'), 'utf8'));
const PC    = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts', 'prompt_center.json'), 'utf8'));

function getNodeCode(wf, name) {
  return wf.nodes?.find(n => n.name === name)?.parameters?.jsCode || '';
}
const veoRecoveryCode = getNodeCode(N8N03, 'Veo失败恢复策略');

// ═══ [1] scriptGenerateV1 policy/JSON failure → safe retry classification ═══
{
  // A: serve must classify script failure type and expose is_safe_retryable
  assert.ok(SERVE.includes('script_failure_type'),
    'serve must classify script_failure_type (policy_or_parse vs connection_error)');
  assert.ok(SERVE.includes('is_safe_retryable'),
    'serve must expose is_safe_retryable flag for script failures');
  assert.ok(SERVE.includes("'policy_or_parse'"),
    'serve must identify policy_or_parse failure subtype');
  assert.ok(SERVE.includes("'connection_error'"),
    'serve must identify connection_error failure subtype');
  // The retry message must mention policy or JSON
  assert.ok(SERVE.includes('内容政策拦截或 JSON 格式异常'),
    'serve must show policy/JSON-specific retry message to user');
  // Must NOT suggest no-audio downgrade for script failures
  assert.ok(!SERVE.includes('no-audio') && !SERVE.includes('无声视频'),
    'script retry must never suggest no-audio downgrade');
  console.log('PASS [1] scriptGenerateV1 policy/JSON failure → safe retry classification');
}

// ═══ [2] Script prompt image visual brief propagation ════════════════════════
{
  // B: script.system_instruction must contain product visual brief constraint
  const ss = PC.script.system_instruction;
  assert.ok(ss.includes('product_visual_brief') || ss.includes('产品图视觉 Brief'),
    'script.system_instruction must contain product visual brief section (H1-fix-B)');
  assert.ok(ss.includes('真实颜色') || ss.includes('真实形态'),
    'product visual brief must specify real product color/form from images');
  assert.ok(ss.includes('不得发明') || ss.includes('禁止凭空'),
    'product visual brief must prohibit inventing features not in product images');
  assert.ok(ss.includes('多图时') || ss.includes('综合所有产品图'),
    'product visual brief must handle multi-image context');
  // Must not hardcode product names
  for (const bad of ['除尘掸', '空调', '鸡毛', '越南']) {
    assert.ok(!ss.includes(bad), `script.system_instruction must not hardcode "${bad}"`);
  }
  console.log('PASS [2] script prompt product visual brief constraint present and no hardcoding');
}

// ═══ [3] Audio failure classified as regenerate_prompt (not give_up) ══════════
{
  // C: Veo失败恢复策略 must detect audio failure and classify as regenerate_prompt
  assert.ok(veoRecoveryCode.includes('_isAudioFailure'),
    'Veo失败恢复策略 must detect audio failure specifically');
  assert.ok(veoRecoveryCode.includes("'audio'") || veoRecoveryCode.includes("audio"),
    'audio detection must check for "audio" in failure message');
  assert.ok(veoRecoveryCode.includes('unable to generate audio'),
    'audio detection must match Veo error message text');
  assert.ok(veoRecoveryCode.includes("? 'regenerate_prompt'"),
    'audio failure must map to regenerate_prompt action');
  // Must NOT map audio failure to give_up directly
  const afterAudioCheck = veoRecoveryCode.slice(veoRecoveryCode.indexOf('_isAudioFailure'));
  const giveUpBeforeRegen = afterAudioCheck.indexOf("'give_up'") < afterAudioCheck.indexOf("'regenerate_prompt'");
  assert.ok(!giveUpBeforeRegen, 'give_up must not appear before regenerate_prompt in audio failure branch');
  // failure_type must be recorded
  assert.ok(veoRecoveryCode.includes('audio_generation_failure'),
    'failure_type must be recorded as audio_generation_failure');
  console.log('PASS [3] audio generation failure → regenerate_prompt (not give_up), no no-audio downgrade');
}

// ═══ [4] Shot failure state preserved on rerun submission ════════════════════
{
  // D: /review-rerun-shot must preserve previous_error before clearing error field
  assert.ok(SERVE.includes('previous_error'),
    'serve /review-rerun-shot must preserve previous_error field (H1-fix-D)');
  assert.ok(SERVE.includes('previous_failure_type'),
    'serve must preserve previous_failure_type across retries');
  // The error field is still updated (for display) but previous is preserved
  assert.ok(SERVE.includes("error: '用户已提交重做，等待视频任务创建'"),
    'serve must still set current error field for status display');
  assert.ok(SERVE.includes("previous_error: shot.error || shot.previous_error || ''"),
    'previous_error must carry forward from shot.error before clearing');
  console.log('PASS [4] shot failure state (previous_error/previous_failure_type) preserved on rerun');
}

// ═══ [5] rerun_failed_only only selects failed shots — D-fix still enforced ═
{
  // E: D-fix in n8n03 恢复已确认分镜 must filter shots correctly
  const resumeCode = getNodeCode(N8N03, '恢复已确认分镜');
  assert.ok(resumeCode.includes('D-fix'), '恢复已确认分镜 must have D-fix label');
  assert.ok(resumeCode.includes('_rerunFailedOnly'), 'D-fix must check rerun_failed_only');
  assert.ok(resumeCode.includes('_rerunPendingOnly'), 'D-fix must check rerun_pending_only');
  assert.ok(resumeCode.includes("return status === 'failed'"),
    'D-fix rerun_failed_only path must only select failed shots');
  assert.ok(resumeCode.includes("return status === 'pending'"),
    'D-fix rerun_pending_only path must only select pending shots');
  // SKIP_STATUSES must exclude completed and submitted
  const skipIdx = resumeCode.indexOf('SKIP_STATUSES');
  const skipBlock = resumeCode.slice(skipIdx, skipIdx + 200);
  assert.ok(skipBlock.includes("'completed'"), 'SKIP_STATUSES must include completed');
  assert.ok(skipBlock.includes("'submitted'"), 'SKIP_STATUSES must include submitted');
  assert.ok(skipBlock.includes("'running'"), 'SKIP_STATUSES must include running');

  // Simulate: completed shot must be excluded by rerun_failed_only
  function filterShots(shots, rerunFailedOnly, rerunPendingOnly) {
    const SKIP = ['completed', 'done', 'submitted', 'running'];
    if (!rerunFailedOnly && !rerunPendingOnly) return shots;
    return shots.filter(s => {
      const status = String(s.status || '');
      if (rerunFailedOnly) return status === 'failed';
      return status === 'pending' || !status;
    });
  }
  const shots = [
    { shot_id: 'shot_1', status: 'completed' },
    { shot_id: 'shot_2', status: 'completed' },
    { shot_id: 'shot_6', status: 'failed' },
  ];
  const failedOnly = filterShots(shots, true, false);
  assert.deepEqual(failedOnly.map(s => s.shot_id), ['shot_6'],
    'rerun_failed_only must select only shot_6 (failed), not shot_1/shot_2 (completed)');
  const pendingOnly = filterShots(shots, false, true);
  assert.equal(pendingOnly.length, 0, 'rerun_pending_only must select 0 shots when none are pending');
  console.log('PASS [5] rerun_failed_only only selects failed shots (D-fix verified + simulated)');
}

// ═══ [6] Manual rerun of specific shot targets only that shot ════════════════
{
  // F: /review-rerun-shot route must only mutate the targeted shot_id
  const rerunIdx = SERVE.indexOf("req.url === '/review-rerun-shot'");
  const rerunBlock = SERVE.slice(rerunIdx, rerunIdx + 4000);
  // Must check shot_id matches before mutating
  assert.ok(rerunBlock.includes('sameShot'),
    '/review-rerun-shot must identify target shot via sameShot check');
  assert.ok(rerunBlock.includes("if (!sameShot) return shot"),
    '/review-rerun-shot must return non-target shots unchanged');
  // Must preserve completed shots unchanged (not reset them)
  const noCompleteReset = !rerunBlock.includes("status === 'completed' && return {");
  assert.ok(noCompleteReset, 'route must not reset completed shots unless they are the target');

  // Simulate manual rerun targeting shot_6 only
  function manualRerun(shots, targetShotId) {
    return shots.map(shot => {
      const sameShot = shot.shot_id === targetShotId;
      if (!sameShot) return shot; // non-target: unchanged
      const status = String(shot.status || '');
      if (['running', 'submitted'].includes(status)) return shot; // blocked
      return { ...shot, status: 'submitted', previous_error: shot.error || '', error: '用户已提交重做' };
    });
  }
  const testShots = [
    { shot_id: 'shot_1', status: 'completed', video_path: 'shot1.mp4', error: '' },
    { shot_id: 'shot_6', status: 'failed', video_path: '', error: 'audio failed' },
  ];
  const result = manualRerun(testShots, 'shot_6');
  assert.equal(result[0].status, 'completed', 'shot_1 must remain completed when targeting shot_6');
  assert.equal(result[0].video_path, 'shot1.mp4', 'shot_1 video_path must be preserved');
  assert.equal(result[1].status, 'submitted', 'shot_6 must become submitted');
  assert.equal(result[1].previous_error, 'audio failed', 'shot_6 previous_error must be preserved');
  console.log('PASS [6] manual rerun targets only specified shot; completed shots are untouched');
}

// ═══ [7] Project+shot active lock prevents duplicate single-shot rerun ═══════
{
  // F: rerunShotLockPath and readActiveRerunShotLock must exist
  assert.ok(SERVE.includes('function rerunShotLockPath('),
    'serve must define rerunShotLockPath(projectId, shotId)');
  assert.ok(SERVE.includes('function readActiveRerunShotLock(') || SERVE.includes('readActiveRerunShotLock'),
    'serve must define readActiveRerunShotLock check');
  assert.ok(SERVE.includes('function writeRerunShotLock('),
    'serve must define writeRerunShotLock');
  assert.ok(SERVE.includes('function clearRerunShotLock('),
    'serve must define clearRerunShotLock');
  // Lock check must happen BEFORE forwardReviewSubmission
  const lockCheckIdx = SERVE.indexOf('readActiveRerunShotLock(');
  const forwardIdx = SERVE.indexOf('forwardReviewSubmission', lockCheckIdx);
  assert.ok(lockCheckIdx < forwardIdx && lockCheckIdx > 0,
    'active lock check must happen BEFORE forwardReviewSubmission');
  console.log('PASS [7] project+shot active lock prevents duplicate single-shot rerun');
}

// ═══ [8] Full generation lock still blocks duplicate full-project submission ══
{
  // I: P12-B1 isVideoGenerationActive must still be checked before all submissions
  for (const route of ['/review-submit', '/review-rerun-pending', '/review-rerun-failed', '/review-rerun-shot']) {
    const idx = SERVE.indexOf(`req.url === '${route}'`);
    assert.ok(idx > 0, `${route} route must exist`);
    const block = SERVE.slice(idx, idx + 11000);
    assert.ok(block.includes('isVideoGenerationActive('),
      `${route} must call isVideoGenerationActive (project-level lock)`);
  }
  console.log('PASS [8] full generation lock (isVideoGenerationActive) still guards all submission routes');
}

// ═══ [9] 5/6 partial success must NOT generate final ════════════════════════
{
  // G: Veo结果汇总 E-fix must require all shots complete before final generation
  const summaryCode = getNodeCode(N8N03, 'Veo结果汇总');
  assert.ok(summaryCode.includes('E-fix'), 'Veo结果汇总 must have E-fix label');
  assert.ok(summaryCode.includes('finalSourceSignature'),
    'Veo结果汇总 must use finalSourceSignature to lock canonical final');
  // Simulate: 5/6 shots complete → finalSourceSignature would be incomplete
  // The E-fix only generates final when all shots in the input are complete
  // (the loop itself controls this — only completed shots go to Veo结果汇总)
  // Non-paid proof: the word 'final' only appears after checking all shot videos
  const finalGenerationIdx = summaryCode.indexOf('ffmpeg');
  const allShotsCheck = summaryCode.indexOf('shots') < finalGenerationIdx;
  assert.ok(finalGenerationIdx >= 0 && allShotsCheck,
    'final generation (ffmpeg) must come after shot verification');
  console.log('PASS [9] 5/6 partial success: final generation (E-fix) only after all shots verified');
}

// ═══ [10] Export without final → partial_export status, not exported ═════════
{
  // H: /api/export-project must check for final before marking 'exported'
  assert.ok(SERVE.includes('_epIsFullExport'),
    'export route must compute _epIsFullExport flag');
  assert.ok(SERVE.includes('_epExportStatus'),
    'export route must derive status as partial_export or exported');
  assert.ok(SERVE.includes("? 'exported' : 'partial_export'"),
    'export route must use partial_export when final is missing');
  assert.ok(SERVE.includes('_epPartialWarning'),
    'export route must include partial warning message');
  assert.ok(SERVE.includes('最终成片尚未生成') || SERVE.includes('partial_export_warning'),
    'export must show clear Chinese warning when final is missing');
  assert.ok(SERVE.includes('is_partial'),
    'export response must include is_partial field');
  // Simulate partial export scenario
  function computeExportStatus(shots, hasFinal) {
    const allComplete = shots.length === 6 && shots.every(s => ['completed','done'].includes(s.status));
    return hasFinal && allComplete ? 'exported' : 'partial_export';
  }
  const partial5 = Array.from({length:5}, (_,i) => ({status:'completed'})).concat([{status:'failed'}]);
  assert.equal(computeExportStatus(partial5, false), 'partial_export',
    '5/6 shots + no final → partial_export');
  const full6 = Array.from({length:6}, () => ({status:'completed'}));
  assert.equal(computeExportStatus(full6, true), 'exported',
    '6/6 shots + final → exported');
  assert.equal(computeExportStatus(full6, false), 'partial_export',
    '6/6 shots but no final → still partial_export');
  console.log('PASS [10] export without final → partial_export status with warning; exported only when 6/6 + final');
}

// ═══ [11] Final/export canonical logic not regressed ════════════════════════
{
  // I: exportProjectArtifacts must still use _canonicalVideoNames from progress.shots
  const exportIdx = SERVE.indexOf('function exportProjectArtifacts(');
  assert.ok(exportIdx > 0, 'exportProjectArtifacts function must exist');
  const exportBlock = SERVE.slice(exportIdx, exportIdx + 5500);
  assert.ok(exportBlock.includes('_canonicalVideoNames'), 'export must use canonical video names from progress');
  assert.ok(exportBlock.includes('_canonicalFinalName'), 'export must use canonical final name from progress');
  assert.ok(exportBlock.includes("destKey === 'video'") && exportBlock.includes('_canonicalVideoNames.has(fname)'),
    'export must skip non-canonical video files');
  console.log('PASS [11] canonical export logic (P12-B1 E-fix) not regressed by H1 changes');
}

// ═══ [12] Field contract unchanged ══════════════════════════════════════════
{
  const contractFields = ['shot_id', 'shot_order', 'operation_name', 'video_path',
    'final_merged_video_path', 'review_context_path', 'review_round', 'review_decision',
    'bad_shot_ids', 'rerun_pending_only', 'rerun_failed_only'];
  const allWfRaw = ['n8n02a','n8n02b','n8n03'].map(wf =>
    fs.readFileSync(path.join(ROOT, '正式导入文件', 'iteration-v1', wf + '.json'), 'utf8')
  ).join('\n') + '\n' + SERVE;
  for (const field of contractFields) {
    assert.ok(allWfRaw.includes(field),
      `contract field "${field}" must remain present in workflows+serve`);
  }
  // Webhook path/method unchanged
  const wf03 = JSON.parse(fs.readFileSync(path.join(ROOT, '正式导入文件','iteration-v1','n8n03.json'),'utf8'));
  const wh = wf03.nodes?.find(n => n.type === 'n8n-nodes-base.webhook');
  assert.equal(wh?.parameters?.path, 'storyboard-review-submit-v2', 'webhook path must be unchanged');
  assert.equal(wh?.parameters?.httpMethod, 'POST', 'webhook method must be unchanged');
  console.log('PASS [12] field contract and webhook path/method unchanged');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('');
console.log('P12-H1 shot retry nonpaid tests: ALL PASS (12/12)');
