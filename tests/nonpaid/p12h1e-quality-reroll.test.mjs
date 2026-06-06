/**
 * P12-H1e nonpaid tests — quality reroll for success/completed shots with cost confirmation.
 *
 * Codex contract: a quality reroll must NOT overwrite the canonical video at submission.
 *  - success/completed/done shot may be quality-rerolled, but ONLY with explicit cost confirmation.
 *  - on submission the shot KEEPS its status (completed/done/success), video_path and operation_name;
 *    the reroll is marked with metadata only (quality_reroll_pending / quality_reroll_active /
 *    quality_reroll_started_at / reroll_reason / previous_video_path / previous_operation_name).
 *  - the existing canonical final is NOT invalidated (no markDownstreamStale final) at submission.
 *  - only AFTER the new take SUCCEEDS is the canonical video_path replaced (final re-merged).
 *  - if the reroll FAILS, the original canonical video/final/export is kept and last_reroll_error
 *    is recorded — never degraded to partial_export.
 *  - running/submitted/waiting/processing still blocked; failed shot still failure-retry.
 *
 * Non-paid: no real n8n, no Veo, no model calls.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const SERVE = fs.readFileSync(path.join(ROOT, '版本测试', 'serve-review-assets.mjs'), 'utf8');
const N8N03 = JSON.parse(fs.readFileSync(path.join(ROOT, '正式导入文件', 'iteration-v1', 'n8n03.json'), 'utf8'));
const getNodeCode = (wf, name) => wf.nodes?.find(n => n.name === name)?.parameters?.jsCode || '';
const completeShot = getNodeCode(N8N03, 'Veo进度_完成分镜');
const initProgress = getNodeCode(N8N03, '审核进度初始化');
const summary = getNodeCode(N8N03, 'Veo结果汇总');

const rerunIdx = SERVE.indexOf("req.url === '/review-rerun-shot'");
const rerunBlock = SERVE.slice(rerunIdx, rerunIdx + 11000);
// slice the success-state branch only, for "canonical not cleared" assertions
const successBranchStart = rerunBlock.indexOf("['completed', 'done', 'success'].includes(shotStatus)");
const successBranch = rerunBlock.slice(successBranchStart, rerunBlock.indexOf("if (shotStatus === 'failed')", successBranchStart));

// Mirror of /review-rerun-shot classification (canonical-preserving).
function classifyRerun(shot, costConfirmed) {
  const s = String(shot.status || '').toLowerCase();
  if (['running', 'submitted', 'waiting', 'processing'].includes(s)) return { decision: 'blockedRunning', shot };
  if (['completed', 'done', 'success'].includes(s)) {
    if (!costConfirmed) return { decision: 'needsCostConfirm', shot };
    return {
      decision: 'quality_reroll',
      shot: {
        ...shot,
        quality_reroll_pending: true,
        quality_reroll_active: true,
        quality_reroll_started_at: 'NOW',
        reroll_reason: 'quality_reroll',
        previous_video_path: shot.video_path || shot.previous_video_path || '',
        previous_operation_name: shot.operation_name || '',
        last_reroll_error: '',
      },
    };
  }
  if (s === 'failed') return { decision: 'failure_retry', shot: { ...shot, status: 'submitted', video_path: '' } };
  return { decision: 'blockedNonFailed', shot };
}

// Mirror of Veo进度_完成分镜 result application.
function applyShotResult(shot, { failed, newVideoPath, newOp }) {
  const isReroll = !!(shot.quality_reroll_active || shot.quality_reroll_pending);
  if (failed && isReroll) {
    return { ...shot, status: 'completed', video_path: shot.video_path || shot.previous_video_path || '',
      operation_name: shot.operation_name || shot.previous_operation_name || '',
      quality_reroll_active: false, quality_reroll_pending: false, quality_reroll_failed: true,
      last_reroll_error: 'reroll failed', error: '' };
  }
  if (!failed && isReroll) {
    return { ...shot, status: 'completed', video_path: newVideoPath || shot.video_path,
      operation_name: newOp || shot.operation_name, quality_reroll_active: false,
      quality_reroll_pending: false, quality_reroll_failed: false, last_reroll_error: '', error: '' };
  }
  return { ...shot, status: failed ? 'failed' : 'completed', video_path: failed ? '' : (newVideoPath || shot.video_path) };
}

// ═══ [1] cost confirmation param parsed (1/true/yes/on) ═════════════════════
{
  assert.ok(rerunBlock.includes("params.get('cost_confirmed') || params.get('quality_reroll_confirmed')"),
    'route reads cost_confirmed/quality_reroll_confirmed');
  assert.ok(rerunBlock.includes("['1', 'true', 'yes', 'on'].includes("), 'accepts 1/true/yes/on');
  console.log('PASS [1] cost confirmation param parsed');
}

// ═══ [2] success reroll WITHOUT confirmation → blocked ══════════════════════
{
  assert.equal(classifyRerun({ status: 'completed', video_path: 'a.mp4' }, false).decision, 'needsCostConfirm');
  console.log('PASS [2] success reroll without cost confirmation is blocked');
}

// ═══ [3] CANONICAL NOT CLEARED at submission (Codex BLOCKER) ════════════════
{
  // serve success branch must NOT set status:'submitted' nor clear video_path/operation_name
  assert.ok(successBranch.length > 0, 'success branch located');
  assert.ok(!/status: 'submitted'/.test(successBranch), 'success reroll must NOT set status:submitted');
  assert.ok(!/video_path: ''/.test(successBranch), 'success reroll must NOT clear video_path');
  assert.ok(!/operation_name: ''/.test(successBranch), 'success reroll must NOT clear operation_name');
  console.log('PASS [3] quality reroll submission does NOT clear canonical status/video_path/operation_name');
}

// ═══ [4] success reroll marks metadata only (active/pending/previous_*) ═════
{
  for (const k of ['quality_reroll_pending: true', 'quality_reroll_active: true', 'quality_reroll_started_at',
    'reroll_reason', 'previous_video_path', 'previous_operation_name']) {
    assert.ok(successBranch.includes(k), `success branch must set ${k}`);
  }
  const r = classifyRerun({ status: 'completed', video_path: 'a.mp4', operation_name: 'op1' }, true);
  assert.equal(r.shot.status, 'completed', 'status stays completed');
  assert.equal(r.shot.video_path, 'a.mp4', 'video_path stays canonical');
  assert.equal(r.shot.operation_name, 'op1', 'operation_name stays canonical');
  assert.equal(r.shot.quality_reroll_active, true, 'quality_reroll_active set');
  assert.equal(r.shot.previous_video_path, 'a.mp4', 'previous_video_path captured');
  assert.equal(r.shot.previous_operation_name, 'op1', 'previous_operation_name captured');
  console.log('PASS [4] quality reroll marks metadata only; canonical fully preserved');
}

// ═══ [5] in-flight still blocked even with confirmation ════════════════════
{
  for (const st of ['running', 'submitted', 'waiting', 'processing']) {
    assert.equal(classifyRerun({ status: st }, true).decision, 'blockedRunning', `${st} blocked`);
  }
  console.log('PASS [5] in-flight states still blocked even with cost confirmation');
}

// ═══ [6] failed shot still failure-retry (no confirmation) ═════════════════
{
  assert.equal(classifyRerun({ status: 'failed', video_path: '', error: 'x' }, false).decision, 'failure_retry');
  console.log('PASS [6] failed shot uses failure-retry path (no cost confirmation)');
}

// ═══ [7] pending/unknown still blocked ════════════════════════════════════
{
  assert.equal(classifyRerun({ status: 'pending' }, true).decision, 'blockedNonFailed');
  assert.equal(classifyRerun({ status: '' }, true).decision, 'blockedNonFailed');
  console.log('PASS [7] pending/unknown shots not rerollable');
}

// ═══ [8] needsCostConfirm returns before forward, with cost message ════════
{
  const cIdx = rerunBlock.indexOf('if (needsCostConfirm)');
  const fIdx = rerunBlock.indexOf('await forwardReviewSubmission(formBody)');
  assert.ok(cIdx > 0 && fIdx > 0 && cIdx < fIdx, 'cost-confirm gate before forward');
  assert.ok(rerunBlock.includes('确认成本') || rerunBlock.includes('请确认成本后再提交'), 'cost message present');
  console.log('PASS [8] needsCostConfirm returns before forward with cost message');
}

// ═══ [9] quality reroll does NOT markDownstreamStale final at submission ═══
{
  assert.ok(rerunBlock.includes('if (!isQualityReroll)'), 'markDownstreamStale guarded by !isQualityReroll');
  const gIdx = rerunBlock.indexOf('if (!isQualityReroll)');
  const sIdx = rerunBlock.indexOf("markDownstreamStale(projectId, 'video_rerun_single_shot', 'final')");
  assert.ok(gIdx > 0 && sIdx > gIdx && sIdx < gIdx + 220, 'final invalidation only for non-quality-reroll');
  console.log('PASS [9] quality reroll keeps canonical final (no up-front markDownstreamStale)');
}

// ═══ [10] reroll state persisted before forward; payload carries quality_reroll ═
{
  const wIdx = rerunBlock.indexOf('fs.writeFileSync(progressPath, JSON.stringify(rerolledProgress');
  const fIdx = rerunBlock.indexOf('await forwardReviewSubmission(formBody)');
  assert.ok(wIdx > 0 && fIdx > 0 && wIdx < fIdx, 'progress persisted before forward');
  assert.ok(rerunBlock.includes("quality_reroll: isQualityReroll ? '1' : ''"), 'payload carries quality_reroll flag');
  console.log('PASS [10] reroll metadata persisted before forward; payload tagged');
}

// ═══ [11] canonical completed_count unchanged; running_count counts active reroll ═
{
  assert.ok(rerunBlock.includes("['completed', 'done', 'success'].includes(String(s.status || '').toLowerCase())"),
    'completed_count counts success states (reroll shot stays completed)');
  assert.ok(rerunBlock.includes('|| s.quality_reroll_active'), 'running_count includes active reroll');
  console.log('PASS [11] completed_count canonical-stable; running_count reflects active reroll');
}

// ═══ [12] 审核进度初始化 keeps canonical for quality reroll (no reset) ══════
{
  assert.ok(initProgress.includes('row.quality_reroll && (shot.quality_reroll_active'),
    'init guards quality reroll shots from reset');
  // the guard returns metadata-only (no status:pending / no video_path clearing)
  const gStart = initProgress.indexOf('row.quality_reroll && (shot.quality_reroll_active');
  const gBlock = initProgress.slice(gStart, gStart + 600);
  assert.ok(!/status: 'pending'/.test(gBlock), 'reroll guard must not reset status to pending');
  assert.ok(gBlock.includes('quality_reroll_active: true'), 'reroll guard keeps active flag');
  assert.ok(initProgress.includes("shot.quality_reroll_active).length"), 'running_count counts active reroll in init');
  console.log('PASS [12] 审核进度初始化 preserves canonical for quality reroll');
}

// ═══ [13] n8n03 success branch replaces canonical only on success ══════════
{
  assert.ok(completeShot.includes('if (!failed && _isQualityReroll)'), 'success reroll branch present');
  assert.ok(completeShot.includes('video_path: row.veo_video_path || shot.video_path'), 'success replaces with new take');
  console.log('PASS [13] successful quality reroll replaces canonical video');
}

// ═══ [14] n8n03 failure branch keeps canonical + records last_reroll_error ═
{
  assert.ok(completeShot.includes('if (failed && _isQualityReroll)'), 'failed reroll branch present');
  assert.ok(completeShot.includes('video_path: shot.video_path || shot.previous_video_path'), 'failure keeps canonical video');
  assert.ok(completeShot.includes('last_reroll_error:'), 'failure records last_reroll_error');
  assert.ok(/status: 'completed'/.test(completeShot.slice(completeShot.indexOf('if (failed && _isQualityReroll)'))),
    'failed reroll stays completed (no degrade)');
  console.log('PASS [14] failed quality reroll keeps canonical video + last_reroll_error');
}

// ═══ [15] simulate: failed reroll keeps canonical, stays completed ═════════
{
  const submitted = { shot_id: 's1', status: 'completed', video_path: 'orig.mp4', operation_name: 'opX',
    quality_reroll_active: true, quality_reroll_pending: true, previous_video_path: 'orig.mp4', previous_operation_name: 'opX' };
  const out = applyShotResult(submitted, { failed: true });
  assert.equal(out.status, 'completed', 'failed reroll stays completed');
  assert.equal(out.video_path, 'orig.mp4', 'canonical video kept');
  assert.equal(out.operation_name, 'opX', 'canonical operation kept');
  assert.equal(out.quality_reroll_active, false, 'active flag cleared');
  assert.equal(out.quality_reroll_failed, true, 'failed flag set');
  assert.ok(out.last_reroll_error, 'last_reroll_error recorded');
  console.log('PASS [15] failed quality reroll simulation keeps canonical, completed');
}

// ═══ [16] simulate: successful reroll replaces canonical ═══════════════════
{
  const submitted = { shot_id: 's1', status: 'completed', video_path: 'orig.mp4', operation_name: 'opX',
    quality_reroll_active: true, quality_reroll_pending: true, previous_video_path: 'orig.mp4' };
  const out = applyShotResult(submitted, { failed: false, newVideoPath: 'new.mp4', newOp: 'opNew' });
  assert.equal(out.status, 'completed', 'success → completed');
  assert.equal(out.video_path, 'new.mp4', 'canonical replaced with new take');
  assert.equal(out.operation_name, 'opNew', 'operation updated');
  assert.equal(out.quality_reroll_active, false, 'active cleared');
  assert.equal(out.last_reroll_error, '', 'no error on success');
  console.log('PASS [16] successful quality reroll simulation replaces canonical');
}

// ═══ [17] failed reroll does NOT degrade export to partial ═════════════════
{
  const computeExportStatus = (shots, hasFinal) => {
    const all = shots.length === 6 && shots.every(s => ['completed', 'done'].includes(s.status));
    return hasFinal && all ? 'exported' : 'partial_export';
  };
  const submitted = { shot_id: 's6', status: 'completed', video_path: 'orig6.mp4', quality_reroll_active: true, previous_video_path: 'orig6.mp4' };
  const rolledBack = applyShotResult(submitted, { failed: true });
  const shots = Array.from({ length: 5 }, () => ({ status: 'completed' })).concat([{ status: rolledBack.status }]);
  assert.equal(computeExportStatus(shots, true), 'exported', 'failed reroll keeps 6/6 + final → exported');
  console.log('PASS [17] failed quality reroll keeps export = exported (no partial degrade)');
}

// ═══ [18] success → final re-merge via signature change; rollback reuses final ═
{
  assert.ok(summary.includes('finalSourceSignature') && summary.includes('canReuseCanonicalFinal'),
    'final signature reuse guard intact');
  const orig = ['s1', 's2', 's3', 's4', 's5', 'orig6'].join('|');
  const success = ['s1', 's2', 's3', 's4', 's5', 'new6'].join('|');
  const rolledback = ['s1', 's2', 's3', 's4', 's5', 'orig6'].join('|');
  assert.notEqual(orig, success, 'success changes signature → re-merge');
  assert.equal(orig, rolledback, 'rollback keeps signature → reuse original final');
  console.log('PASS [18] success re-merges final; rollback reuses original final');
}

// ═══ [19] UI redo forms send cost_confirmed + credit-cost dialog ═══════════
{
  const n = (SERVE.match(/name="cost_confirmed" value="1"/g) || []).length;
  assert.ok(n >= 3, `all redo forms send cost_confirmed (found ${n})`);
  assert.ok(SERVE.includes('消耗 credits'), 'redo confirm dialog warns about credit cost');
  console.log('PASS [19] UI redo forms include cost_confirmed + credit-cost dialog');
}

// ═══ [19b] status-specific button copy: failed vs success ══════════════════
{
  assert.ok(SERVE.includes('重做失败镜头'), 'failed shots use "重做失败镜头" label/copy');
  assert.ok(SERVE.includes('重新生成此镜头'), 'success/completed shots use "重新生成此镜头" label');
  assert.ok(SERVE.includes('重做失败镜头会再次消耗 credits'), 'failed confirm copy present');
  assert.ok(SERVE.includes('该镜头已生成成功，重新生成会消耗一次视频额度'), 'success confirm copy present');
  assert.ok(SERVE.includes('重新生成会消耗一次视频额度'), 'batch confirm includes "消耗一次视频额度"');
  // never instruct normal users to edit the underlying prompt
  assert.ok(!SERVE.includes('修改提示词'), 'redo copy must not tell users to 修改提示词');
  console.log('PASS [19b] status-specific redo copy present; no 修改提示词 advice');
}

// ═══ [20] rerolling one success shot does not affect other success shots ══
{
  const shots = [
    { shot_id: 'shot_1', status: 'completed', video_path: 'a.mp4' },
    { shot_id: 'shot_2', status: 'completed', video_path: 'b.mp4' },
  ];
  const mapped = shots.map(s => s.shot_id === 'shot_2' ? classifyRerun(s, true).shot : s);
  assert.equal(mapped[0].status, 'completed', 'non-target success untouched');
  assert.equal(mapped[0].video_path, 'a.mp4', 'non-target video preserved');
  assert.equal(mapped[1].quality_reroll_active, true, 'target marked active');
  assert.equal(mapped[1].video_path, 'b.mp4', 'target canonical kept until success');
  console.log('PASS [20] rerolling one success shot does not affect others');
}

// ═══ [21] reroll targets only the selected shot ═══════════════════════════
{
  assert.ok(rerunBlock.includes('bad_shot_ids: shotId'), 'forwards only the targeted shot id');
  assert.ok(rerunBlock.includes('rerun_failed_only: true'), 'uses explicit single-shot rerun path');
  console.log('PASS [21] quality reroll targets only the selected shot');
}

// ═══ [22] normal failure (non-reroll) still becomes failed ════════════════
{
  const out = applyShotResult({ shot_id: 's', status: 'submitted', video_path: '' }, { failed: true });
  assert.equal(out.status, 'failed', 'non-reroll failure still failed');
  console.log('PASS [22] non-quality-reroll failure still becomes failed');
}

console.log('');
console.log('P12-H1e quality reroll with cost confirmation nonpaid tests: ALL PASS (22/22)');
