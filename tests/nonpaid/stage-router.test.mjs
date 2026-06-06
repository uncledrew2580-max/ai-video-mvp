import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deriveArtifactFlags,
  deriveProjectStage,
  getNextAction,
  getUserVisibleStage,
  isStale,
  markStalePatch,
  normalizeProjectState,
} from '../../app-server/services/project-state.service.mjs';

import {
  getActiveRoute,
  getNextUrl,
  getStageStatusLabel,
  shouldAutoRedirect,
  shouldShowSyncButton,
} from '../../app-server/services/stage-router.service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures', 'project-state');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8'));
}

function derive(name) {
  const fixture = loadFixture(name);
  const projectState = normalizeProjectState(fixture.projectState);
  const derived = deriveProjectStage(projectState, fixture.projectFiles);
  return { fixture, projectState, derived };
}

{
  const { fixture, derived } = derive('concept-only');
  assert.equal(derived.stage, 'creative_generated');
  assert.equal(getNextAction(derived), 'select_creative_direction');
  assert.equal(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    '/concepts/item?context=concept_context_proj_fixture_001.json',
  );
}

{
  const { fixture, derived } = derive('script-only');
  assert.equal(derived.stage, 'script_generated');
  assert.equal(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    '/script-review?project_id=proj_fixture_002',
  );
}

{
  const laggingState = normalizeProjectState({
    project_id: 'proj_fixture_script_lagging',
    stage: 'creative_generating',
    status: 'creative_generating',
  });
  const derived = deriveProjectStage(laggingState, {
    scriptContext: 'script_context_proj_fixture_script_lagging.json',
  });
  assert.equal(derived.stage, 'script_generated');
  assert.equal(
    getActiveRoute(laggingState.project_id, derived),
    '/script-review?project_id=proj_fixture_script_lagging',
  );
}

{
  const { derived } = derive('confirmed-script');
  assert.equal(derived.stage, 'script_confirmed');
  assert.equal(getUserVisibleStage(derived), '脚本已确认，等待分镜');
}

{
  const { fixture, derived } = derive('review-context');
  assert.equal(derived.stage, 'storyboard_ready_for_review');
  assert.equal(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    '/reviews/item?context=review_context_proj_fixture_004_001.json',
  );
}

{
  const { fixture, derived } = derive('submitted-only');
  const flags = deriveArtifactFlags(fixture.projectFiles);
  assert.equal(flags.submittedReviewContext, true);
  assert.equal(flags.validReviewContext, false);
  assert.notEqual(derived.stage, 'storyboard_ready_for_review');
  assert.equal(derived.stage, 'script_confirmed');
  assert.equal(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    '/storyboard-status?project_id=proj_fixture_005',
  );
  assert.doesNotMatch(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    /^\/reviews\/item|^\/review-status/,
  );
}

{
  const { fixture, derived } = derive('five-videos');
  assert.equal(derived.artifacts.videoClipCount, 5);
  assert.equal(derived.artifacts.videoClipsComplete, false);
  assert.equal(derived.stage, 'video_generating');
  assert.notEqual(derived.stage, 'video_clips_generated');
  assert.equal(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    '/review-status?context=review_context_proj_fixture_006_001.json',
  );
}

{
  const { fixture, derived } = derive('six-videos');
  assert.equal(derived.artifacts.videoClipCount, 6);
  assert.equal(derived.artifacts.videoClipsComplete, true);
  assert.equal(derived.stage, 'video_clips_generated');
  assert.equal(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    '/review-status?context=review_context_proj_fixture_007_001.json',
  );
}

{
  const { fixture, derived } = derive('final-video');
  assert.equal(derived.stage, 'final_generated');
  assert.equal(getStageStatusLabel(derived), '最终成片已生成');
  assert.equal(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    '/final-video?context=review_context_proj_fixture_008_001.json',
  );
  assert.notEqual(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    '/review-status?context=review_context_proj_fixture_008_001.json',
    'final video must not route back to video status',
  );
}

{
  const { fixture, derived } = derive('exported-final');
  assert.equal(derived.stage, 'exported');
  assert.equal(getStageStatusLabel(derived), '最终成片已导出');
  assert.equal(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    '/final-video?context=review_context_proj_fixture_009_001.json',
  );
  assert.equal(
    getNextUrl(fixture.projectState.project_id, derived, fixture.options),
    '/final-video?context=review_context_proj_fixture_009_001.json',
  );
}

{
  const { derived } = derive('exported-final');
  const label = getStageStatusLabel(derived);
  assert.notEqual(label, '当前阶段：1. 提交表单');
  assert.notEqual(label, '表单已提交');
  assert.equal(label, '最终成片已导出');
}

{
  const { fixture, projectState, derived } = derive('stale-storyboard');
  assert.equal(isStale('storyboard', projectState), true);
  assert.equal(isStale('video', projectState), true);
  assert.equal(isStale('final', projectState), true);
  assert.equal(derived.stage, 'stale');
  assert.notEqual(derived.stage, 'video_clips_generated');
  assert.notEqual(derived.stage, 'final_generated');
  assert.equal(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    '/active?project_id=proj_fixture_010&stage=stale',
  );
}

{
  const patch = markStalePatch('storyboard');
  assert.equal(patch.stage, 'stale');
  assert.deepEqual(patch.stale_scopes, ['storyboard', 'video', 'final']);
  assert.equal(patch.stale.storyboard, true);
  assert.equal(patch.stale.video, true);
  assert.equal(patch.stale.final, true);
}

{
  const { fixture, derived } = derive('failed-with-final');
  assert.equal(derived.failed, true);
  assert.equal(derived.stage, 'final_generated');
  assert.equal(
    getActiveRoute(fixture.projectState.project_id, derived, fixture.options),
    '/final-video?context=review_context_proj_fixture_011_001.json',
  );
}

{
  assert.equal(shouldShowSyncButton('/active', 'script_generated'), true);
  assert.equal(shouldShowSyncButton('/script-review', 'script_generated'), true);
  assert.equal(shouldShowSyncButton('/storyboard-status', 'storyboard_generating'), true);
  assert.equal(shouldShowSyncButton('/reviews/item', 'storyboard_ready_for_review'), true);
  assert.equal(shouldShowSyncButton('/review-status', 'video_generating'), true);
  assert.equal(shouldShowSyncButton('/final-video', 'final_generated'), true);
  assert.equal(shouldShowSyncButton('/submitted', 'creative_generating'), false);
}

{
  assert.equal(shouldAutoRedirect('/submitted', 'creative_generated'), true);
  assert.equal(shouldAutoRedirect('/concept-status', 'script_generated'), true);
  assert.equal(shouldAutoRedirect('/storyboard-status', 'storyboard_ready_for_review'), true);
  assert.equal(shouldAutoRedirect('/review-status', 'final_generated'), true);
  assert.equal(shouldAutoRedirect('/review-status', 'video_generating'), false);
}

{
  const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', '版本测试', 'serve-review-assets.mjs'), 'utf8');
  assert.match(serverSource, /deriveProjectStage as deriveStageFacade/);
  assert.match(serverSource, /getActiveRoute as getActiveRouteFacade/);
  assert.match(serverSource, /getStageStatusLabel as getStageStatusLabelFacade/);
  assert.match(serverSource, /const currentStageLabel = getStageStatusLabelFacade\(facadeDerivedStage\);/);
  assert.match(serverSource, /const activeStageLabel = dashboard\.currentStageLabel \|\|/);
  assert.match(
    serverSource,
    /const activeRoute = getActiveRouteFacade\(projectId, dashboard\.facadeDerivedStage, \{\s+conceptContext: conceptFile,\s+reviewContext: reviewFile,\s+\}\) \|\| getActiveRoute\(projectId\);/,
  );
  assert.doesNotMatch(serverSource, /const activeRoute = getActiveRoute\(projectId\);/);
  const legacyActiveRouteStart = serverSource.indexOf('function getActiveRoute(projectId = ');
  const finalPriorityStart = serverSource.indexOf("artifactStageName === 'exported' || artifactStageName === 'final_generated'", legacyActiveRouteStart);
  const reviewRouteStart = serverSource.indexOf('if (reviewFile && !reviewSubmitted)', legacyActiveRouteStart);
  assert.ok(legacyActiveRouteStart > -1, 'legacy getActiveRoute must exist');
  assert.ok(finalPriorityStart > legacyActiveRouteStart, 'legacy getActiveRoute must check final/exported');
  assert.ok(reviewRouteStart > finalPriorityStart, 'final/exported check must run before review routing');
  assert.match(serverSource, /function getFinalRouteForProject\(projectId, reviewFile = ''\)/);
  assert.match(serverSource, /return getFinalRouteForProject\(activeProjectId, reviewFile\);/);
  assert.match(serverSource, /return `\/final-video\?context=\$\{encodeURIComponent\(finalReviewFile\)\}`;/);
  assert.match(serverSource, /return `\/active\?project_id=\$\{encodeURIComponent\(activeProjectId\)\}&stage=final`;/);
}

{
  const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', '版本测试', 'serve-review-assets.mjs'), 'utf8');
  assert.match(serverSource, /function scriptContextPath\(projectId\)/);
  assert.match(serverSource, /function reconcileScriptContextStateForUi\(projectId, state, hasScriptContext\)/);
  assert.match(serverSource, /updateProjectState\(projectId, \{ stage: 'script_generated', status: 'script_generated' \}\);/);
  assert.match(
    serverSource,
    /const scriptStatusUrl = contextPath \? `\/concept-status\?context=\$\{encodeURIComponent\(path\.basename\(contextPath\)\)\}`/,
  );
  assert.match(serverSource, /<meta http-equiv="refresh" content="1; url=\$\{scriptStatusUrl\}" \/>/);
  assert.doesNotMatch(
    serverSource,
    /const activeUrl = projectId \? `\/active\?project_id=\$\{encodeURIComponent\(projectId\)\}` : '\/active';/,
  );
  assert.match(
    serverSource,
    /const scriptReadyRefresh = scriptReady && !reviewLink && scriptLink \? `<meta http-equiv="refresh" content="0; url=\$\{scriptLink\}" \/>` : '';/,
  );
  assert.match(serverSource, /脚本框架生成中，请稍等\.\.\./);
  // P12-H1b-A: concept-poll keeps this default message as the fallback after the
  // safe auto-retry closure (`_cpAuto.user_message ||` …) — pin the default text.
  assert.match(serverSource, /message: _cpAuto\.user_message \|\| '脚本框架生成失败，请稍后重试。如连续失败，请导出诊断包。'/);
}

{
  const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', '版本测试', 'serve-review-assets.mjs'), 'utf8');
  assert.match(serverSource, /function reconcileStoryboardContextStateForUi\(projectId, state, hasReviewContext\)/);
  assert.match(serverSource, /updateProjectState\(projectId, \{ stage: 'storyboard_ready_for_review', status: 'storyboard_ready_for_review' \}\);/);
  assert.match(serverSource, /!name\.endsWith\('\.submitted\.json'\)/);
  assert.match(serverSource, /<meta http-equiv="refresh" content="0; url=\$\{reviewUrl\}" \/>/);
  assert.match(serverSource, /reconcileStoryboardContextStateForUi\(projectId, readProjectState\(projectId\), true\);/);
  assert.match(serverSource, /reconcileStoryboardContextStateForUi\(_spProjId, readProjectState\(_spProjId\), true\);/);
  assert.match(serverSource, /分镜图生成中，请稍等\.\.\./);
  assert.match(serverSource, /execution\?\.status === 'error' \|\| execution\?\.status === 'crashed'/);
  assert.match(serverSource, /_spExec\?\.status === 'error' \|\| _spExec\?\.status === 'crashed'/);
  assert.match(serverSource, /user_message \|\| STORYBOARD_FAILURE_USER_MESSAGE/);
  assert.match(serverSource, /Location: `\/storyboard-status\?project_id=\$\{encodeURIComponent\(projectId\)\}`/);
  assert.doesNotMatch(serverSource, /Location: `\/active\?project_id=\$\{encodeURIComponent\(projectId\)\}`/);
}

{
  const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', '版本测试', 'serve-review-assets.mjs'), 'utf8');
  assert.match(serverSource, /function renderSubmitResultPage\(\{ ok, message, contextPath = '', executionId = '' \}\)/);
  assert.match(serverSource, /视频生成已提交，正在生成 \$\{submittedShotCount\} 个镜头，请勿重复点击。/);
  assert.match(serverSource, /<meta http-equiv="refresh" content="1; url=\/review-status\$\{contextParam\}" \/>/);
  assert.match(serverSource, /const executionFailed = execution\?\.status === 'error' \|\| execution\?\.status === 'crashed';/);
  assert.match(serverSource, /const videoSubmissionMissing = hasSubmissionRecord && !execution\?\.id && !hasRealProgress && videos\.length === 0;/);
  assert.match(serverSource, /视频生成未提交成功，请同步当前项目状态或导出诊断包。/);
  assert.match(serverSource, /running:'视频生成中'/);
  assert.match(serverSource, /crashed:'视频生成失败'/);
  assert.match(serverSource, /视频片段状态：已完成/);
  assert.match(serverSource, /视频生成失败：\$\{htmlEscape\(failureSummary \|\| executionErrorSummary \|\| '请同步当前项目状态或导出诊断包。'\)\}/);
  assert.match(serverSource, /method="POST" action="\/review-rerun-shot"/);
  assert.match(serverSource, /if \(req\.url\.startsWith\('\/final-video'\)\)/);
  assert.match(serverSource, /resolveReviewSubmitWebhookUrl\(\)/);
}

{
  const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', '版本测试', 'serve-review-assets.mjs'), 'utf8');
  assert.match(serverSource, /function getConfiguredFinalOutputDir\(\)/);
  assert.match(serverSource, /const finalDir = String\(outCfg\.final_dir \|\| ''\)\.trim\(\) \|\| path\.join\(baseDir, 'Final'\);/);
  assert.match(serverSource, /const checkDir = getConfiguredFinalOutputDir\(\);/);
  assert.match(serverSource, /const outputFinalDir = getConfiguredFinalOutputDir\(\);/);
  assert.match(serverSource, /const finalDir = getConfiguredFinalOutputDir\(\);\s+if \(!finalDir\) return '';/);
  assert.match(serverSource, /const _recRoute = getActiveRoute\(_recPid\);/);
  assert.match(serverSource, /activeRoute: _recRoute,/);
  assert.match(serverSource, /next_url: _recRoute,/);
  assert.match(serverSource, /const finalStageLabel = finalOutputInfo\.hasUserFinal/);
  assert.match(serverSource, /\? '最终成片已导出'/);
  assert.match(serverSource, /: \(finalOutputInfo\.hasInternalFinal \? '最终成片已生成' : '最终成片尚未生成'\);/);
  assert.match(serverSource, /当前阶段：<strong>\$\{htmlEscape\(finalStageLabel\)\}<\/strong>/);
  const userFinalStart = serverSource.indexOf('const finalVideoBlock = finalOutputInfo.hasUserFinal');
  const needsExportStart = serverSource.indexOf(': (finalOutputInfo.needsExport', userFinalStart);
  assert.ok(userFinalStart > -1, 'final page must check exported user final first');
  assert.ok(needsExportStart > userFinalStart, 'final page must prefer Movies exported final before internal final export state');
}

console.log('stage router nonpaid tests passed');
