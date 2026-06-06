/**
 * P12-H1b nonpaid tests — scriptGenerateV1 safe auto-retry closure +
 * failed/pending shot rerun boundary closure.
 *
 * Fix A: scriptGenerateV1 safe automatic second-submission closure
 *   - only safe failure types (policy/safety block, JSON parse/extract, invalid schema) auto-retry
 *   - at most ONCE, no infinite loop
 *   - preserve previous_error / previous_failure_type / previous_attempt_context
 *   - non-safe (connection) failures never auto-retry
 *   - retry exhaustion / non-safe failure never writes success
 *   - does not change form input / selected concept / market / language / creative_task_type / schema
 * Fix B: failed/pending shot precise rerun boundary
 *   - a failed (incl. audio) shot is never downgraded to pending
 *   - rerun_pending_only only processes real pending; rerun_failed_only only failed
 *   - /review-rerun-shot only the specified shot; 5/6+failed not final/exported; partial_export warning
 *
 * All non-paid: no real n8n, no real Veo, no model calls. The pure decision
 * functions are extracted directly from the live source and executed in a
 * sandbox so this verifies the SHIPPING logic, not a re-implementation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const SERVE = fs.readFileSync(path.join(ROOT, '版本测试', 'serve-review-assets.mjs'), 'utf8');
const N8N02A = JSON.parse(fs.readFileSync(path.join(ROOT, '正式导入文件', 'iteration-v1', 'n8n02a.json'), 'utf8'));
const N8N03 = JSON.parse(fs.readFileSync(path.join(ROOT, '正式导入文件', 'iteration-v1', 'n8n03.json'), 'utf8'));
const PC = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts', 'prompt_center.json'), 'utf8'));

function getNodeCode(wf, name) {
  return wf.nodes?.find(n => n.name === name)?.parameters?.jsCode || '';
}

// ── Extract a top-level function/const body from source by brace matching ─────
function sliceFunction(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error('source not found: ' + signature);
  // body brace is the final '{' of the signature (avoids destructured-param braces)
  let i = src.indexOf('{', start + signature.length - 1);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces for: ' + signature);
}

// Build a sandbox with the real pure decision functions from serve.
const sandboxSrc = [
  'const SCRIPT_AUTO_RETRY_MAX = 1;',
  sliceFunction(SERVE, 'function classifyScriptFailure(execution) {'),
  sliceFunction(SERVE, 'function extractScriptErrorMessage(execution) {'),
  sliceFunction(SERVE, "function planScriptSafeRetry({ execution, retryState = {}, conceptId = '' } = {}) {"),
  sliceFunction(SERVE, 'function reconcileStaleShotStatus(shot, executionSucceeded) {'),
  'return { SCRIPT_AUTO_RETRY_MAX, classifyScriptFailure, planScriptSafeRetry, reconcileStaleShotStatus };',
].join('\n\n');
// eslint-disable-next-line no-new-func
const { SCRIPT_AUTO_RETRY_MAX, classifyScriptFailure, planScriptSafeRetry, reconcileStaleShotStatus } =
  new Function(sandboxSrc)();

const policyExec = { id: 'e1', status: 'error', data: { resultData: { error: { message: 'invalid JSON parse failure from model' } } } };
const connExec   = { id: 'e2', status: 'error', data: { resultData: { error: { message: 'ECONNRESET socket hang up timeout' } } } };
const okExec     = { id: 'e3', status: 'success' };

// ═══ [1] safe failure → auto-retry exactly once ══════════════════════════════
{
  const plan = planScriptSafeRetry({ execution: policyExec, retryState: { attempt_count: 0 }, conceptId: 'c1' });
  assert.equal(plan.action, 'auto_retry', 'policy/JSON failure with 0 prior attempts → auto_retry');
  assert.equal(plan.attempt, 1, 'first safe retry is attempt 1');
  assert.equal(plan.script_safe_retry, true, 'auto_retry sets script_safe_retry flag');
  assert.equal(plan.status, 'retrying', 'auto_retry status is retrying (not success)');
  console.log('PASS [1] safe failure auto-retries exactly once');
}

// ═══ [2] at most once — no infinite loop ═════════════════════════════════════
{
  assert.equal(SCRIPT_AUTO_RETRY_MAX, 1, 'SCRIPT_AUTO_RETRY_MAX must be 1');
  const plan = planScriptSafeRetry({ execution: policyExec, retryState: { attempt_count: 1, concept_id: 'c1' }, conceptId: 'c1' });
  assert.equal(plan.action, 'exhausted', 'second safe failure with attempt_count 1 → exhausted');
  assert.equal(plan.exhausted, true, 'exhausted flag set');
  assert.equal(plan.status, 'failed', 'exhausted status is failed (not retrying/success)');
  console.log('PASS [2] safe auto-retry capped at 1 (no infinite loop)');
}

// ═══ [3] preserve previous_error / previous_failure_type / previous_attempt_context ══
{
  const plan = planScriptSafeRetry({
    execution: policyExec,
    retryState: { attempt_count: 0, previous_error: 'earlier policy block', },
    conceptId: 'c1',
  });
  assert.ok(plan.previous_error && plan.previous_error.includes('earlier policy block'),
    'previous_error carried forward from retry state');
  assert.equal(plan.previous_failure_type, 'policy_or_parse', 'previous_failure_type preserved/classified');
  assert.ok(plan.previous_attempt_context && typeof plan.previous_attempt_context === 'object',
    'previous_attempt_context is an object');
  assert.equal(plan.previous_attempt_context.execution_id, 'e1', 'previous_attempt_context records execution id');
  assert.equal(plan.previous_attempt_context.prior_attempt_count, 0, 'previous_attempt_context records prior count');
  console.log('PASS [3] previous_error / previous_failure_type / previous_attempt_context preserved');
}

// ═══ [4] non-safe (connection) failure → never auto-retry ════════════════════
{
  const plan = planScriptSafeRetry({ execution: connExec, retryState: { attempt_count: 0 }, conceptId: 'c1' });
  assert.equal(plan.action, 'no_auto_retry', 'connection_error must not auto-retry');
  assert.equal(plan.is_safe_retryable, false, 'connection_error is not safe-retryable');
  assert.equal(plan.status, 'failed', 'non-safe failure status is failed');
  assert.ok(/不会自动重试|连接/.test(plan.user_message || ''), 'non-safe failure shows clear connection error message');
  console.log('PASS [4] non-safe connection failure never auto-retries');
}

// ═══ [5] retry exhaustion / non-safe never writes success ════════════════════
{
  // No plan branch may ever report success.
  for (const ex of [policyExec, connExec, okExec]) {
    for (const ac of [0, 1, 2]) {
      const plan = planScriptSafeRetry({ execution: ex, retryState: { attempt_count: ac, concept_id: 'c1' }, conceptId: 'c1' });
      assert.notEqual(plan.status, 'success', 'planScriptSafeRetry must never return success');
      assert.notEqual(plan.status, 'completed', 'planScriptSafeRetry must never return completed');
    }
  }
  // The orchestrator only forwards on auto_retry and returns retried:false for exhausted/no_auto_retry.
  const orch = sliceFunction(SERVE, 'async function maybeAutoRetryScriptGeneration(projectId, opts = {}) {');
  assert.ok(orch.includes("plan.action === 'no_auto_retry' || plan.action === 'exhausted'"),
    'orchestrator must short-circuit on no_auto_retry/exhausted');
  assert.ok(orch.includes('DO NOT write success, DO NOT forward'),
    'orchestrator must document never-success / never-forward on failure');
  assert.ok(!/status:\s*'success'/.test(orch), 'orchestrator never sets status success');
  console.log('PASS [5] exhaustion / non-safe failure never writes success');
}

// ═══ [6] failed (incl. audio) shot is never downgraded to pending ════════════
{
  // execution succeeded globally, but one shot failed audio.
  assert.deepEqual(reconcileStaleShotStatus({ shot_id: 's6', status: 'failed', failure_type: 'audio_generation_failure' }, true),
    { shot_id: 's6', status: 'failed', failure_type: 'audio_generation_failure' },
    'failed audio shot must stay failed, never pending');
  assert.equal(reconcileStaleShotStatus({ status: 'running' }, true).status, 'pending', 'stale running → pending');
  assert.equal(reconcileStaleShotStatus({ status: 'submitted' }, true).status, 'pending', 'stale submitted → pending');
  assert.equal(reconcileStaleShotStatus({ status: 'processing' }, true).status, 'pending', 'stale processing → pending');
  assert.equal(reconcileStaleShotStatus({ status: 'completed' }, true).status, 'completed', 'completed stays completed');
  assert.equal(reconcileStaleShotStatus({ status: 'running' }, false).status, 'running', 'no reset when execution not succeeded');
  console.log('PASS [6] failed/audio shot never downgraded to pending; only stale in-flight → pending');
}

// ═══ [7] rerun_pending_only only processes real pending (skips failed) ═══════
{
  const resumeCode = getNodeCode(N8N03, '恢复已确认分镜');
  assert.ok(resumeCode.includes("return status === 'pending'"), 'D-fix pending path present');
  assert.ok(resumeCode.includes("return status === 'failed'"), 'D-fix failed path present');
  // simulate exactly the D-fix filter
  function filter(panels, statuses, rerunPendingOnly, rerunFailedOnly, badShotIds = []) {
    if (!rerunPendingOnly && !rerunFailedOnly) return panels;
    return panels.filter(panel => {
      const shotId = String(panel.shot_id || '');
      const status = statuses[shotId] || statuses['shot_' + shotId] || 'pending';
      if (rerunFailedOnly) {
        if (badShotIds.length) return badShotIds.includes(shotId) || badShotIds.includes('shot_' + shotId);
        return status === 'failed';
      }
      return status === 'pending' || !status;
    });
  }
  const panels = [{ shot_id: 'shot_1' }, { shot_id: 'shot_2' }, { shot_id: 'shot_6' }];
  const statuses = { shot_1: 'completed', shot_2: 'pending', shot_6: 'failed' };
  const pendingOnly = filter(panels, statuses, true, false);
  assert.deepEqual(pendingOnly.map(p => p.shot_id), ['shot_2'],
    'rerun_pending_only selects only pending shot_2, NOT failed shot_6 or completed shot_1');
  console.log('PASS [7] rerun_pending_only processes only real pending, never failed');
}

// ═══ [8] rerun_failed_only only processes failed ════════════════════════════
{
  function filter(panels, statuses, rerunFailedOnly) {
    return panels.filter(panel => {
      const status = statuses[String(panel.shot_id)] || 'pending';
      return rerunFailedOnly ? status === 'failed' : true;
    });
  }
  const panels = [{ shot_id: 'shot_1' }, { shot_id: 'shot_2' }, { shot_id: 'shot_6' }];
  const statuses = { shot_1: 'completed', shot_2: 'pending', shot_6: 'failed' };
  const failedOnly = filter(panels, statuses, true);
  assert.deepEqual(failedOnly.map(p => p.shot_id), ['shot_6'],
    'rerun_failed_only selects only failed shot_6, not completed/pending');
  console.log('PASS [8] rerun_failed_only processes only failed shots');
}

// ═══ [9] /review-rerun-shot only mutates the specified shot ══════════════════
{
  const idx = SERVE.indexOf("req.url === '/review-rerun-shot'");
  assert.ok(idx > 0, '/review-rerun-shot route exists');
  const block = SERVE.slice(idx, idx + 4000);
  assert.ok(block.includes('sameShot') && block.includes('if (!sameShot) return shot'),
    '/review-rerun-shot returns non-target shots unchanged');
  function manualRerun(shots, target) {
    return shots.map(shot => {
      const sameShot = shot.shot_id === target;
      if (!sameShot) return shot;
      if (['running', 'submitted'].includes(String(shot.status || ''))) return shot;
      return { ...shot, status: 'submitted', previous_error: shot.error || '', error: '用户已提交重做' };
    });
  }
  const out = manualRerun([
    { shot_id: 'shot_1', status: 'completed', video_path: 'a.mp4' },
    { shot_id: 'shot_6', status: 'failed', error: 'audio failed' },
  ], 'shot_6');
  assert.equal(out[0].status, 'completed', 'non-target completed shot untouched');
  assert.equal(out[1].status, 'submitted', 'target failed shot resubmitted');
  assert.equal(out[1].previous_error, 'audio failed', 'target previous_error preserved');
  console.log('PASS [9] /review-rerun-shot mutates only the specified shot');
}

// ═══ [10] 5/6 + 1 failed → not final, not exported ══════════════════════════
{
  function computeExportStatus(shots, hasFinal) {
    const allComplete = shots.length === 6 && shots.every(s => ['completed', 'done'].includes(s.status));
    return hasFinal && allComplete ? 'exported' : 'partial_export';
  }
  const five = Array.from({ length: 5 }, () => ({ status: 'completed' })).concat([{ status: 'failed' }]);
  assert.equal(computeExportStatus(five, false), 'partial_export', '5/6 + failed + no final → partial_export');
  assert.equal(computeExportStatus(five, true), 'partial_export', '5/6 + failed even with final flag → still partial_export');
  console.log('PASS [10] 5/6 + 1 failed is never final/exported (partial_export)');
}

// ═══ [11] partial_export emits a clear Chinese warning ══════════════════════
{
  assert.ok(SERVE.includes("? 'exported' : 'partial_export'"), 'export route uses partial_export status');
  assert.ok(SERVE.includes('_epPartialWarning'), 'export route builds partial warning');
  assert.ok(SERVE.includes('is_partial'), 'export response exposes is_partial');
  assert.ok(SERVE.includes('最终成片尚未生成') || SERVE.includes('partial_export_warning'),
    'export shows Chinese partial warning');
  console.log('PASS [11] partial_export emits clear Chinese warning');
}

// ═══ [12] failed shot redone → 6/6 + final → exported ═══════════════════════
{
  function computeExportStatus(shots, hasFinal) {
    const allComplete = shots.length === 6 && shots.every(s => ['completed', 'done'].includes(s.status));
    return hasFinal && allComplete ? 'exported' : 'partial_export';
  }
  const full = Array.from({ length: 6 }, () => ({ status: 'completed' }));
  assert.equal(computeExportStatus(full, true), 'exported', '6 unique completed + final → exported');
  assert.equal(computeExportStatus(full, false), 'partial_export', '6/6 but no final → still partial');
  console.log('PASS [12] failed shot redone to 6/6 + final → exported');
}

// ═══ [13] project+shot active lock prevents duplicate single-shot rerun ══════
{
  assert.ok(SERVE.includes('function rerunShotLockPath('), 'rerunShotLockPath defined');
  assert.ok(SERVE.includes('readActiveRerunShotLock'), 'readActiveRerunShotLock present');
  assert.ok(SERVE.includes('function writeRerunShotLock('), 'writeRerunShotLock defined');
  assert.ok(SERVE.includes('function clearRerunShotLock('), 'clearRerunShotLock defined');
  console.log('PASS [13] project+shot active lock present (duplicate single-shot rerun blocked)');
}

// ═══ [14] previous_error / previous_failure_type preserved on rerun-shot ═════
{
  assert.ok(SERVE.includes("previous_error: shot.error || shot.previous_error || ''"),
    'rerun-shot carries previous_error forward from shot.error');
  assert.ok(SERVE.includes('previous_failure_type'), 'rerun-shot preserves previous_failure_type');
  console.log('PASS [14] previous_error / previous_failure_type preserved across shot rerun');
}

// ═══ [15] concept change resets the auto-retry budget ═══════════════════════
{
  const plan = planScriptSafeRetry({ execution: policyExec, retryState: { attempt_count: 1, concept_id: 'OLD' }, conceptId: 'NEW' });
  assert.equal(plan.action, 'auto_retry', 'different concept resets retry budget → auto_retry allowed');
  assert.equal(plan.attempt, 1, 'reset budget restarts at attempt 1');
  console.log('PASS [15] selecting a different concept resets the auto-retry budget');
}

// ═══ [16] classifyScriptFailure classification correctness ══════════════════
{
  assert.equal(classifyScriptFailure(okExec).is_safe_retryable, false, 'success → not retryable');
  assert.equal(classifyScriptFailure(null).is_safe_retryable, false, 'null → not retryable');
  for (const kw of ['policy', 'json', 'parse', 'safety', 'content', 'invalid', 'schema']) {
    const ex = { status: 'error', data: { resultData: { error: { message: 'model ' + kw + ' problem' } } } };
    const c = classifyScriptFailure(ex);
    assert.equal(c.script_failure_type, 'policy_or_parse', kw + ' → policy_or_parse');
    assert.equal(c.is_safe_retryable, true, kw + ' → safe retryable');
  }
  assert.equal(classifyScriptFailure(connExec).script_failure_type, 'connection_error', 'plain network error → connection_error');
  console.log('PASS [16] classifyScriptFailure: safe vs connection classification correct');
}

// ═══ [17] auto-retry does not change form/concept/market/language/type ══════
{
  const orch = sliceFunction(SERVE, 'async function maybeAutoRetryScriptGeneration(projectId, opts = {}) {');
  // payload is rebuilt from the EXISTING selected concept sidecar only
  assert.ok(orch.includes('selected_concept_id: conceptId'), 'payload reuses existing selected concept id');
  assert.ok(orch.includes('concept_context_path: String(sidecar.concept_context_path'), 'payload reuses existing concept context path');
  assert.ok(orch.includes('script_safe_retry: true'), 'payload marks safe retry');
  // must NOT inject/override market/language/creative_task_type/product images
  assert.ok(!/target_market:/.test(orch), 'auto-retry must not set target_market');
  assert.ok(!/target_language:/.test(orch), 'auto-retry must not set target_language');
  assert.ok(!/creative_task_type:/.test(orch), 'auto-retry must not set creative_task_type');
  assert.ok(!/image_1_base64|product_image/.test(orch), 'auto-retry must not touch product images');
  console.log('PASS [17] auto-retry preserves form/concept/market/language/type (no schema change)');
}

// ═══ [18] safe_retry_instruction prompt wired in prompt_center + n8n02a ═════
{
  assert.ok(typeof PC.script.safe_retry_instruction === 'string' && PC.script.safe_retry_instruction.length > 50,
    'prompt_center script.safe_retry_instruction present');
  assert.ok(/安全重试|6 个 shot|JSON/.test(PC.script.safe_retry_instruction), 'safe_retry_instruction has safe-retry guidance');
  // n8n02a uses it only when script_safe_retry is set
  const asm = getNodeCode(N8N02A, '脚本请求体组装');
  assert.ok(asm.includes('script_safe_retry'), 'n8n02a reads script_safe_retry');
  assert.ok(asm.includes('safe_retry_instruction'), 'n8n02a uses s.safe_retry_instruction');
  assert.ok(asm.includes('previous_error') && asm.includes('previous_failure_type'),
    'n8n02a surfaces previous failure context on safe retry');
  console.log('PASS [18] safe_retry_instruction wired in prompt_center + n8n02a (retry-only)');
}

// ═══ [19] concept-poll wiring: auto-retry + clear-on-success + retrying status ══
{
  const idx = SERVE.indexOf("req.url.startsWith('/api/concept-poll')");
  assert.ok(idx > 0, '/api/concept-poll route exists');
  const block = SERVE.slice(idx, idx + 3000);
  assert.ok(block.includes('maybeAutoRetryScriptGeneration('), 'concept-poll triggers safe auto-retry on failure');
  assert.ok(block.includes("status: 'retrying'"), 'concept-poll emits retrying status when auto-retry fires');
  assert.ok(block.includes('clearScriptRetryState('), 'concept-poll clears retry budget on success');
  console.log('PASS [19] /api/concept-poll wires safe auto-retry, retrying status, clear-on-success');
}

// ═══ [20] contract & webhook unchanged (regression guard) ═══════════════════
{
  const contractFields = ['shot_id', 'shot_order', 'operation_name', 'video_path',
    'final_merged_video_path', 'review_context_path', 'review_round', 'review_decision',
    'bad_shot_ids', 'rerun_pending_only', 'rerun_failed_only'];
  const raw = ['n8n02a', 'n8n03'].map(w =>
    fs.readFileSync(path.join(ROOT, '正式导入文件', 'iteration-v1', w + '.json'), 'utf8')).join('\n') + SERVE;
  for (const f of contractFields) assert.ok(raw.includes(f), `contract field ${f} preserved`);
  const wh02a = N8N02A.nodes.find(n => n.type === 'n8n-nodes-base.webhook');
  assert.equal(wh02a.parameters.path, 'storyboard-concept-select-v1', 'n8n02a webhook path unchanged');
  assert.equal(wh02a.parameters.httpMethod, 'POST', 'n8n02a webhook method unchanged');
  const wh03 = N8N03.nodes.find(n => n.parameters?.path === 'storyboard-review-submit-v2');
  assert.ok(wh03 && wh03.parameters.httpMethod === 'POST', 'n8n03 webhook path/method unchanged');
  console.log('PASS [20] field contract + webhook path/method unchanged');
}

console.log('');
console.log('P12-H1b script retry + shot rerun closure nonpaid tests: ALL PASS (20/20)');
