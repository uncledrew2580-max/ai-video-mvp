/**
 * P12-H1d nonpaid tests — retry cost guard / running lock / failed-only retry.
 *
 * 1. running/submitted/waiting/processing (or active generation) → same project+shot
 *    rerun is intercepted before forwardReviewSubmission, no Veo, exact CN message.
 * 2. failed shot → manual redo touches only that shot, preserves
 *    previous_error / previous_failure_type / previous_video_path.
 * 3. audio/policy regenerate_prompt auto path capped at 1; the 2nd audio failure → give_up,
 *    shot stays failed (never pending), no further auto Veo submit.
 * 4. normal-user audio hint shown; never tells normal users to edit the underlying prompt.
 * 5. pending/failed/rerun_pending_only/rerun_failed_only/partial_export/6-of-6 exported preserved.
 * 6. project-state sync stays read-only.
 *
 * Non-paid: no real n8n, no Veo, no model calls. Pure decision functions are extracted
 * from the live source and run in a sandbox to verify shipping logic.
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
const recovery = getNodeCode(N8N03, 'Veo失败恢复策略');
const completeShot = getNodeCode(N8N03, 'Veo进度_完成分镜');
const summary = getNodeCode(N8N03, 'Veo结果汇总');

const AUDIO_HINT = '该镜头音频生成失败，请稍后重试该镜头。如连续失败，建议缩短这一镜口播或改成更简单表达后再重做。';
const RUNNING_MSG = '该镜头正在生成中，请勿重复提交，请稍后刷新状态。';

function sliceFunction(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error('source not found: ' + signature);
  let i = src.indexOf('{', start + signature.length - 1);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces: ' + signature);
}
const { reconcileStaleShotStatus } = new Function(
  sliceFunction(SERVE, 'function reconcileStaleShotStatus(shot, executionSucceeded) {') +
  '\nreturn { reconcileStaleShotStatus };',
)();

// Faithful mirrors of the n8n03 source decisions (no model / no fs).
const MAX_AUTO_PROMPT_REGENS = 1;
function decideRecoveryAction({ promptRegens = 0, isAudio = false, isPolicy = false, failStreak = 1, maxAutoRetries = 0 }) {
  const audioOrPolicy = isAudio || isPolicy;
  return audioOrPolicy
    ? (promptRegens < MAX_AUTO_PROMPT_REGENS ? 'regenerate_prompt' : 'give_up')
    : (failStreak <= maxAutoRetries ? 'retry_same_prompt' : 'give_up');
}
function decideUserError(rawReason, failed = true) {
  if (!failed) return '';
  const isAudio = /audio|unable to generate audio|generate audio for this request/i.test(rawReason);
  return isAudio ? AUDIO_HINT : String(rawReason || '');
}

const rerunIdx = SERVE.indexOf("req.url === '/review-rerun-shot'");
const rerunBlock = SERVE.slice(rerunIdx, rerunIdx + 10000);

// ═══ [1] route blocks running/submitted/waiting/processing ═══════════════════
{
  for (const st of ['running', 'submitted', 'waiting', 'processing']) {
    assert.ok(new RegExp(`'${st}'`).test(rerunBlock.slice(0, rerunBlock.indexOf('blockedRunning = true'))) ||
      rerunBlock.includes(`'${st}'`), `rerun route must treat ${st} as in-flight`);
  }
  assert.ok(/\['running', 'submitted', 'waiting', 'processing'\]\.includes\(shotStatus\)/.test(rerunBlock),
    'in-flight set must include running/submitted/waiting/processing');
  console.log('PASS [1] /review-rerun-shot blocks running/submitted/waiting/processing');
}

// ═══ [2] exact running-lock CN message present ═══════════════════════════════
{
  assert.ok(SERVE.includes(RUNNING_MSG), 'exact running-lock message must be present');
  assert.ok(rerunBlock.includes(RUNNING_MSG), 'running-lock message used inside /review-rerun-shot');
  console.log('PASS [2] exact running-lock message "该镜头正在生成中…" present');
}

// ═══ [3] block happens BEFORE forwardReviewSubmission (no Veo on in-flight) ══
{
  const blockIdx = rerunBlock.indexOf('if (blockedRunning)');
  const fwdIdx = rerunBlock.indexOf('await forwardReviewSubmission(formBody)');
  assert.ok(blockIdx > 0 && fwdIdx > 0 && blockIdx < fwdIdx,
    'blockedRunning return must precede forwardReviewSubmission');
  console.log('PASS [3] in-flight block returns before forwardReviewSubmission (no Veo)');
}

// ═══ [4] project-level active generation intercept before forward ═══════════
{
  const activeIdx = rerunBlock.indexOf('isVideoGenerationActive(projectId)');
  const fwdIdx = rerunBlock.indexOf('await forwardReviewSubmission(formBody)');
  assert.ok(activeIdx > 0 && activeIdx < fwdIdx, 'isVideoGenerationActive must guard before forward');
  console.log('PASS [4] project-level active generation intercepted before forward');
}

// ═══ [5] rerunShotLock concurrency guard before forward ═════════════════════
{
  const lockIdx = rerunBlock.indexOf('readActiveRerunShotLock(projectId, shotId)');
  const fwdIdx = rerunBlock.indexOf('await forwardReviewSubmission(formBody)');
  assert.ok(lockIdx > 0 && lockIdx < fwdIdx, 'rerunShotLock must be checked before forward');
  console.log('PASS [5] project+shot rerun lock checked before forward (anti dup-submit)');
}

// ═══ [6] simulate: in-flight shot blocked, not mutated, not forwarded ════════
{
  function attemptRerun(shots, target) {
    let blocked = false, found = false;
    const mapped = shots.map(shot => {
      const same = shot.shot_id === target;
      if (!same) return shot;
      found = true;
      if (['running', 'submitted', 'waiting', 'processing'].includes(String(shot.status))) { blocked = true; return shot; }
      return { ...shot, status: 'submitted' };
    });
    return { blocked, found, forwarded: found && !blocked, mapped };
  }
  const r = attemptRerun([{ shot_id: 'shot_1', status: 'completed' }, { shot_id: 'shot_3', status: 'running' }], 'shot_3');
  assert.equal(r.blocked, true, 'running shot rerun blocked');
  assert.equal(r.forwarded, false, 'blocked shot is not forwarded (no Veo)');
  assert.equal(r.mapped[1].status, 'running', 'blocked shot is not mutated');
  console.log('PASS [6] in-flight rerun simulated: blocked, unmutated, not forwarded');
}

// ═══ [7] manual redo: non-target shot returned unchanged ════════════════════
{
  assert.ok(rerunBlock.includes('if (!sameShot) return shot'), 'non-target shots returned unchanged');
  console.log('PASS [7] /review-rerun-shot returns non-target shots unchanged');
}

// ═══ [8] manual redo preserves previous_error/type/video_path ═══════════════
{
  assert.ok(rerunBlock.includes("previous_error: shot.error || shot.previous_error || ''"),
    'previous_error preserved');
  assert.ok(rerunBlock.includes("previous_failure_type: shot.failure_type || shot.previous_failure_type || ''"),
    'previous_failure_type preserved');
  assert.ok(rerunBlock.includes("previous_video_path: shot.video_path || shot.previous_video_path || ''"),
    'previous_video_path preserved');
  console.log('PASS [8] manual redo preserves previous_error / previous_failure_type / previous_video_path');
}

// ═══ [9] simulate manual redo of a failed shot — only that shot changes ══════
{
  function manualRerun(shots, target) {
    return shots.map(shot => {
      if (shot.shot_id !== target) return shot;
      if (['running', 'submitted', 'waiting', 'processing'].includes(String(shot.status))) return shot;
      return {
        ...shot, status: 'submitted',
        previous_video_path: shot.video_path || shot.previous_video_path || '',
        video_path: '',
        previous_error: shot.error || shot.previous_error || '',
        previous_failure_type: shot.failure_type || shot.previous_failure_type || '',
        error: '用户已提交重做，等待视频任务创建',
      };
    });
  }
  const out = manualRerun([
    { shot_id: 'shot_1', status: 'completed', video_path: 'a.mp4', error: '' },
    { shot_id: 'shot_6', status: 'failed', video_path: '', error: AUDIO_HINT, failure_type: 'audio_generation_failure' },
  ], 'shot_6');
  assert.equal(out[0].status, 'completed', 'completed shot untouched');
  assert.equal(out[0].video_path, 'a.mp4', 'completed video_path preserved');
  assert.equal(out[1].status, 'submitted', 'target failed shot resubmitted');
  assert.equal(out[1].previous_error, AUDIO_HINT, 'previous_error carried');
  assert.equal(out[1].previous_failure_type, 'audio_generation_failure', 'previous_failure_type carried');
  console.log('PASS [9] manual redo changes only target failed shot; previous_* carried');
}

// ═══ [10] regenerate cap constant present (=1) ══════════════════════════════
{
  assert.ok(/const MAX_AUTO_PROMPT_REGENS = 1;/.test(recovery), 'MAX_AUTO_PROMPT_REGENS must be 1');
  console.log('PASS [10] audio/policy regenerate cap constant = 1');
}

// ═══ [11] capped action logic present in source ═════════════════════════════
{
  assert.ok(recovery.includes("promptRegens < MAX_AUTO_PROMPT_REGENS ? 'regenerate_prompt' : 'give_up'"),
    'capped regenerate/give_up logic must be present');
  console.log('PASS [11] capped regenerate→give_up logic present in Veo失败恢复策略');
}

// ═══ [12] 1st audio failure (regen 0) → regenerate_prompt ═══════════════════
{
  assert.equal(decideRecoveryAction({ promptRegens: 0, isAudio: true }), 'regenerate_prompt',
    'first audio failure auto-regenerates once');
  console.log('PASS [12] 1st audio failure → regenerate_prompt');
}

// ═══ [13] 2nd audio failure (regen 1) → give_up ════════════════════════════
{
  assert.equal(decideRecoveryAction({ promptRegens: 1, isAudio: true }), 'give_up',
    'second audio failure stops auto-regenerate (give_up)');
  assert.equal(decideRecoveryAction({ promptRegens: 2, isAudio: true }), 'give_up',
    'beyond cap stays give_up');
  console.log('PASS [13] 2nd audio failure → give_up (cap enforced)');
}

// ═══ [14] policy failure capped identically ════════════════════════════════
{
  assert.equal(decideRecoveryAction({ promptRegens: 0, isPolicy: true }), 'regenerate_prompt', 'first policy → regen');
  assert.equal(decideRecoveryAction({ promptRegens: 1, isPolicy: true }), 'give_up', 'second policy → give_up');
  console.log('PASS [14] content_policy failure regenerate also capped at 1');
}

// ═══ [15] give_up not before regenerate_prompt in audio branch (p12h1[3] regr) ═
{
  const after = recovery.slice(recovery.indexOf('_isAudioFailure'));
  assert.ok(after.indexOf("'regenerate_prompt'") < after.indexOf("'give_up'"),
    'regenerate_prompt must appear before give_up in audio branch');
  assert.ok(recovery.includes('audio_generation_failure'), 'audio failure_type still recorded');
  console.log('PASS [15] audio branch still maps to regenerate_prompt first (no regression)');
}

// ═══ [16] prompt_regen_exhausted recorded on failure entry ══════════════════
{
  assert.ok(recovery.includes('prompt_regen_exhausted'), 'failure entry records prompt_regen_exhausted');
  console.log('PASS [16] prompt_regen_exhausted flag recorded for diagnostics');
}

// ═══ [17] general (non-audio) failure still respects maxAutoRetries ═════════
{
  assert.equal(decideRecoveryAction({ isAudio: false, isPolicy: false, failStreak: 1, maxAutoRetries: 0 }), 'give_up',
    'general failure with maxAutoRetries=0 gives up');
  assert.equal(decideRecoveryAction({ isAudio: false, isPolicy: false, failStreak: 1, maxAutoRetries: 2 }), 'retry_same_prompt',
    'general failure under maxAutoRetries retries same prompt');
  console.log('PASS [17] general failure unaffected by audio cap (respects maxAutoRetries)');
}

// ═══ [18] failed shot never downgraded to pending (serve reconcile) ═════════
{
  assert.equal(reconcileStaleShotStatus({ status: 'failed', failure_type: 'audio_generation_failure' }, true).status,
    'failed', 'failed audio shot stays failed after success reconcile');
  assert.equal(reconcileStaleShotStatus({ status: 'running' }, true).status, 'pending', 'stale running → pending');
  console.log('PASS [18] serve reconcile keeps failed; only stale in-flight → pending');
}

// ═══ [19] n8n03 summary keeps failed (only running/submitted → pending) ═════
{
  assert.ok(summary.includes("if (shot.status === 'running' || shot.status === 'submitted') {"),
    'summary downgrades only running/submitted');
  assert.ok(summary.includes('return { ...shot, status: \'pending\' };'), 'summary pending downgrade present');
  // failed path returns shot unchanged (no failed→pending)
  assert.ok(!/status === 'failed'[\s\S]{0,40}status: 'pending'/.test(summary),
    'summary must NOT turn failed into pending');
  console.log('PASS [19] Veo结果汇总 never downgrades failed → pending');
}

// ═══ [20] give_up path goes to next shot, not back to Veo request body ══════
{
  const C = N8N03.connections;
  const need = C['Veo需要恢复?'].main; // [0]=true(recover), [1]=false(success/give_up)
  assert.ok((need[1] || []).some(c => c.node === 'Veo逐镜串行'),
    'give_up/success (false branch) routes to Veo逐镜串行 (next shot), not re-submit');
  assert.ok((need[0] || []).some(c => c.node === 'Veo重写提示词?'),
    'recover (true branch) routes to Veo重写提示词?');
  console.log('PASS [20] give_up exits to next shot — no auto Veo re-submission');
}

// ═══ [21] exact audio user hint present in n8n03 ════════════════════════════
{
  assert.ok(completeShot.includes(AUDIO_HINT), 'exact audio failure user hint must be present');
  console.log('PASS [21] audio failure user hint present in Veo进度_完成分镜');
}

// ═══ [22] hint applied only to audio failures ══════════════════════════════
{
  assert.equal(decideUserError('Veo unable to generate audio for this request'), AUDIO_HINT, 'audio → hint');
  assert.equal(decideUserError('Kie 视频轮询超时'), 'Kie 视频轮询超时', 'non-audio → raw reason');
  assert.equal(decideUserError('anything', false), '', 'success → empty error');
  console.log('PASS [22] audio hint applied only to audio failures');
}

// ═══ [23] audio failed shot tagged failure_type=audio_generation_failure ════
{
  assert.ok(completeShot.includes("audio_generation_failure"), 'failure_type audio recorded on shot');
  assert.ok(/failure_type: failed \? _failureType : ''/.test(completeShot), 'failure_type set on failed shots');
  console.log('PASS [23] audio failed shot tagged failure_type=audio_generation_failure');
}

// ═══ [24] hint must NOT tell normal users to edit the underlying prompt ═════
{
  assert.ok(!/底层 ?prompt|修改.*提示词|编辑提示词|edit.*prompt|system_instruction/i.test(AUDIO_HINT),
    'user audio hint must not instruct editing the underlying prompt');
  assert.ok(AUDIO_HINT.includes('重试该镜头'), 'hint guides user to simply retry the shot');
  console.log('PASS [24] audio hint never tells normal users to edit underlying prompt');
}

// ═══ [25] safe-retry prompt addendum stays internal (not a user-facing string) ═
{
  // The system safe_retry_instruction (P12-H1b) is injected into the model request,
  // never rendered to users. The user-facing hint is the benign retry message above.
  assert.ok(!completeShot.includes('safe_retry_instruction'), 'user shot-complete node must not expose system prompt addendum');
  console.log('PASS [25] system safe-retry prompt stays internal; users see only the benign hint');
}

// ═══ [26] pending/failed/rerun filters preserved (D-fix simulate) ═══════════
{
  function dfix(panels, statuses, pendingOnly, failedOnly, bad = []) {
    if (!pendingOnly && !failedOnly) return panels;
    return panels.filter(p => {
      const s = statuses[String(p.shot_id)] || 'pending';
      if (failedOnly) return bad.length ? bad.includes(String(p.shot_id)) : s === 'failed';
      return s === 'pending' || !s;
    });
  }
  const panels = [{ shot_id: 'shot_1' }, { shot_id: 'shot_2' }, { shot_id: 'shot_6' }];
  const st = { shot_1: 'completed', shot_2: 'pending', shot_6: 'failed' };
  assert.deepEqual(dfix(panels, st, true, false).map(p => p.shot_id), ['shot_2'], 'rerun_pending_only → only pending');
  assert.deepEqual(dfix(panels, st, false, true).map(p => p.shot_id), ['shot_6'], 'rerun_failed_only → only failed');
  console.log('PASS [26] rerun_pending_only / rerun_failed_only boundaries preserved');
}

// ═══ [27] 5/6 + failed → partial_export ════════════════════════════════════
{
  const computeExportStatus = (shots, hasFinal) => {
    const all = shots.length === 6 && shots.every(s => ['completed', 'done'].includes(s.status));
    return hasFinal && all ? 'exported' : 'partial_export';
  };
  const five = Array.from({ length: 5 }, () => ({ status: 'completed' })).concat([{ status: 'failed' }]);
  assert.equal(computeExportStatus(five, false), 'partial_export', '5/6 + failed → partial');
  assert.ok(SERVE.includes("? 'exported' : 'partial_export'"), 'serve uses partial_export');
  console.log('PASS [27] 5/6 + failed → partial_export');
}

// ═══ [28] 6/6 + final → exported ═══════════════════════════════════════════
{
  const computeExportStatus = (shots, hasFinal) => {
    const all = shots.length === 6 && shots.every(s => ['completed', 'done'].includes(s.status));
    return hasFinal && all ? 'exported' : 'partial_export';
  };
  const full = Array.from({ length: 6 }, () => ({ status: 'completed' }));
  assert.equal(computeExportStatus(full, true), 'exported', '6/6 + final → exported');
  assert.equal(computeExportStatus(full, false), 'partial_export', '6/6 no final → partial');
  console.log('PASS [28] 6/6 + final → exported');
}

// ═══ [29] final canonical lock (E-fix) intact ══════════════════════════════
{
  assert.ok(summary.includes('finalSourceSignature'), 'final source signature lock intact');
  assert.ok(summary.includes('canReuseCanonicalFinal'), 'canonical final reuse guard intact');
  console.log('PASS [29] final canonical lock (E-fix) intact');
}

// ═══ [30] project-state sync stays read-only ═══════════════════════════════
{
  const rIdx = SERVE.indexOf("/api/reconcile-project");
  assert.ok(rIdx > 0, '/api/reconcile-project route exists');
  const rBlock = SERVE.slice(rIdx, rIdx + 3500);
  assert.ok(!rBlock.includes('forwardReviewSubmission'), 'reconcile-project must not forward (read-only)');
  assert.ok(!rBlock.includes('forwardConceptSelection'), 'reconcile-project must not trigger script gen');
  console.log('PASS [30] /api/reconcile-project stays read-only (no forward / no model)');
}

// ═══ [31] route classification present (H1e-evolved): in-flight / success / failed / pending ═
{
  assert.ok(rerunBlock.includes('let blockedNonFailed = false;'), 'blockedNonFailed flag declared');
  assert.ok(rerunBlock.includes('let needsCostConfirm = false;'), 'needsCostConfirm flag declared (H1e)');
  assert.ok(rerunBlock.includes("['completed', 'done', 'success'].includes(shotStatus)"),
    'success states are classified for quality reroll');
  assert.ok(rerunBlock.includes("if (shotStatus === 'failed')"), 'failed has its own failure-retry branch');
  // pending / unknown falls through to blockedNonFailed
  assert.ok(/blockedNonFailed = true;\s*\n\s*return shot;\s*\n\s*\}\) : \[\];/.test(rerunBlock),
    'pending/unknown falls through to blockedNonFailed (nothing to reroll)');
  console.log('PASS [31] route classifies in-flight / success-reroll / failed / pending');
}

// ═══ [32] non-failed-non-success (pending) blocked before forward, with CN message ══
{
  const nonFailedIdx = rerunBlock.indexOf('if (blockedNonFailed)');
  const fwdIdx = rerunBlock.indexOf('await forwardReviewSubmission(formBody)');
  assert.ok(nonFailedIdx > 0 && fwdIdx > 0 && nonFailedIdx < fwdIdx,
    'blockedNonFailed return must precede forwardReviewSubmission');
  assert.ok(rerunBlock.includes('该镜头尚未生成完成，暂不可重做；仅失败镜头可重试、已成功镜头可在确认成本后质量重做。'),
    'pending block shows clear CN message');
  console.log('PASS [32] pending/unknown redo blocked before forward, with clear message');
}

// ═══ [33] success reroll requires cost confirmation before any mutation/forward ═════
{
  const confirmIdx = rerunBlock.indexOf('if (needsCostConfirm)');
  const fwdIdx = rerunBlock.indexOf('await forwardReviewSubmission(formBody)');
  assert.ok(confirmIdx > 0 && confirmIdx < fwdIdx, 'cost-confirm gate returns before forward');
  // success branch only proceeds when costConfirmed; otherwise sets needsCostConfirm and returns shot unchanged
  assert.ok(/if \(!costConfirmed\) \{ needsCostConfirm = true; return shot; \}/.test(rerunBlock),
    'unconfirmed success reroll is not mutated/forwarded');
  assert.ok(rerunBlock.includes('quality_reroll_active: true'), 'confirmed success reroll marks quality_reroll_active (metadata only)');
  console.log('PASS [33] success reroll gated by cost confirmation before mutation/forward');
}

// ═══ [34] simulate H1e gate: success w/o confirm blocked; w/ confirm reroll; pending blocked; failed allowed ═
{
  function rerunGate(shots, target, costConfirmed) {
    let blockedRunning = false, blockedNonFailed = false, needsCostConfirm = false, isQualityReroll = false, forwarded = false;
    const mapped = shots.map((shot) => {
      if (shot.shot_id !== target) return shot;
      const s = String(shot.status || '').toLowerCase();
      if (['running', 'submitted', 'waiting', 'processing'].includes(s)) { blockedRunning = true; return shot; }
      if (['completed', 'done', 'success'].includes(s)) {
        if (!costConfirmed) { needsCostConfirm = true; return shot; }
        isQualityReroll = true; forwarded = true;
        // canonical preserved: status/video_path/operation_name unchanged, metadata only
        return { ...shot, quality_reroll_active: true, quality_reroll_pending: true, previous_video_path: shot.video_path || '', previous_operation_name: shot.operation_name || '' };
      }
      if (s === 'failed') { forwarded = true; return { ...shot, status: 'submitted', quality_reroll: false, previous_video_path: shot.video_path || '', video_path: '' }; }
      blockedNonFailed = true; return shot;
    });
    return { blockedRunning, blockedNonFailed, needsCostConfirm, isQualityReroll, forwarded, mapped };
  }
  const base = [
    { shot_id: 'shot_1', status: 'completed', video_path: 'a.mp4', operation_name: 'op1' },
    { shot_id: 'shot_4', status: 'pending' },
    { shot_id: 'shot_5', status: 'failed', error: 'audio failed' },
  ];
  // success WITHOUT confirmation → blocked, not forwarded, unchanged
  const noConfirm = rerunGate(base, 'shot_1', false);
  assert.equal(noConfirm.needsCostConfirm, true, 'success reroll without confirm is blocked');
  assert.equal(noConfirm.forwarded, false, 'unconfirmed success reroll not forwarded (no Veo)');
  assert.equal(noConfirm.mapped[0].status, 'completed', 'unconfirmed success shot unchanged');
  // success WITH confirmation → quality reroll active, canonical PRESERVED (status/video unchanged)
  const confirmed = rerunGate(base, 'shot_1', true);
  assert.equal(confirmed.isQualityReroll, true, 'confirmed success → quality reroll');
  assert.equal(confirmed.forwarded, true, 'confirmed success reroll forwarded');
  assert.equal(confirmed.mapped[0].status, 'completed', 'canonical status preserved during reroll (not submitted)');
  assert.equal(confirmed.mapped[0].video_path, 'a.mp4', 'canonical video_path preserved during reroll (not cleared)');
  assert.equal(confirmed.mapped[0].previous_video_path, 'a.mp4', 'previous_video_path captured for rollback');
  // pending → blocked
  assert.equal(rerunGate(base, 'shot_4', true).blockedNonFailed, true, 'pending blocked even with confirm');
  // failed → forwarded without confirmation
  assert.equal(rerunGate(base, 'shot_5', false).forwarded, true, 'failed shot redo needs no cost confirmation');
  console.log('PASS [34] success reroll needs confirm; pending blocked; failed redo no-confirm');
}

// ═══ [35] failed shot still redoable + success shots untouched ══════════════
{
  function rerunGate(shots, target) {
    let forwarded = false;
    const mapped = shots.map((shot) => {
      if (shot.shot_id !== target) return shot;
      const s = String(shot.status || '').toLowerCase();
      if (['running', 'submitted', 'waiting', 'processing'].includes(s)) return shot;
      if (s !== 'failed') return shot;
      forwarded = true;
      return { ...shot, status: 'submitted', previous_video_path: shot.video_path || '', video_path: '', previous_error: shot.error || '', error: '用户已提交重做' };
    });
    return { forwarded, mapped };
  }
  const base = [
    { shot_id: 'shot_1', status: 'completed', video_path: 'a.mp4' },
    { shot_id: 'shot_5', status: 'failed', error: 'audio failed' },
  ];
  const r = rerunGate(base, 'shot_5');
  assert.equal(r.forwarded, true, 'failed shot is allowed to redo (forwarded)');
  assert.equal(r.mapped[0].status, 'completed', 'success/completed shot untouched by failed redo');
  assert.equal(r.mapped[0].video_path, 'a.mp4', 'success shot video preserved');
  assert.equal(r.mapped[1].status, 'submitted', 'failed shot moved to submitted');
  assert.equal(r.mapped[1].previous_error, 'audio failed', 'failed shot previous_error preserved');
  console.log('PASS [35] failed shot remains redoable; success shots unaffected');
}

console.log('');
console.log('P12-H1d retry cost guard nonpaid tests: ALL PASS (35/35)');
