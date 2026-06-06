export const STAGES = Object.freeze([
  'form_submitted',
  'creative_generating',
  'creative_generated',
  'script_generating',
  'script_generated',
  'script_confirmed',
  'storyboard_generating',
  'storyboard_ready_for_review',
  'video_generating',
  'video_clips_generated',
  'final_generating',
  'final_generated',
  'exported',
  'failed',
  'stale',
]);

export const STAGE_PRIORITY = Object.freeze({
  form_submitted: 10,
  creative_generating: 20,
  creative_generated: 30,
  script_generating: 40,
  script_generated: 50,
  script_confirmed: 60,
  storyboard_generating: 70,
  storyboard_ready_for_review: 80,
  video_generating: 90,
  video_clips_generated: 100,
  final_generating: 110,
  final_generated: 120,
  exported: 130,
  failed: 900,
  stale: 95,
});

const STALE_ORDER = Object.freeze(['script', 'storyboard', 'video', 'final']);

const STAGE_LABELS = Object.freeze({
  form_submitted: '表单已提交',
  creative_generating: '创意方向生成中',
  creative_generated: '创意方向待选择',
  script_generating: '脚本框架生成中',
  script_generated: '脚本框架待确认',
  script_confirmed: '脚本已确认，等待分镜',
  storyboard_generating: '分镜图生成中',
  storyboard_ready_for_review: '分镜图待审核',
  video_generating: '视频生成中',
  video_clips_generated: '视频片段已生成',
  final_generating: '最终成片生成中',
  final_generated: '最终成片已生成',
  exported: '最终成片已导出',
  failed: '生成失败',
  stale: '下游内容已过期',
});

const NEXT_ACTIONS = Object.freeze({
  form_submitted: 'wait_for_creative_generation',
  creative_generating: 'wait_for_creative_generation',
  creative_generated: 'select_creative_direction',
  script_generating: 'wait_for_script_generation',
  script_generated: 'review_script',
  script_confirmed: 'wait_for_storyboard_generation',
  storyboard_generating: 'wait_for_storyboard_generation',
  storyboard_ready_for_review: 'review_storyboard',
  video_generating: 'wait_for_video_generation',
  video_clips_generated: 'review_video_or_generate_final',
  final_generating: 'wait_for_final_video',
  final_generated: 'review_or_export_final',
  exported: 'open_exported_final',
  failed: 'review_error_and_retry',
  stale: 'regenerate_stale_downstream',
});

function normalizeStageName(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.endsWith('_failed')) return 'failed';
  if (STAGES.includes(raw)) return raw;
  return raw;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isTruthyArtifact(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value === true || (typeof value === 'string' && value.trim() !== '') || (value && typeof value === 'object');
}

function getVideoClipKey(entry, index) {
  if (entry && typeof entry === 'object') {
    const shotId = String(entry.shot_id || entry.shotId || '').trim();
    if (shotId) return shotId.toLowerCase().replace(/^shot[-_]?/i, 'shot_');
    const shotOrder = String(entry.shot_order || entry.shotOrder || '').trim();
    if (shotOrder) return `shot_${shotOrder.replace(/^shot[-_]?/i, '')}`;
  }
  const text = typeof entry === 'string'
    ? entry
    : String(entry?.name || entry?.file || entry?.path || entry?.video_path || '');
  const match = text.match(/shot[-_]?(\d+)/i);
  if (match) return `shot_${Number(match[1])}`;
  return text.trim() || `clip_${index}`;
}

function countUniqueVideoClips(videoClips) {
  const keys = new Set();
  videoClips.forEach((entry, index) => {
    const key = getVideoClipKey(entry, index);
    if (key) keys.add(key);
  });
  return keys.size;
}

function normalizeReviewContexts(projectFiles) {
  const values = [
    ...asArray(projectFiles.reviewContexts),
    ...asArray(projectFiles.reviewContext),
  ];
  return values.map((entry) => {
    if (typeof entry === 'string') {
      return {
        name: entry,
        submitted: entry.endsWith('.submitted.json'),
        stale: entry.includes('.stale'),
        valid: entry.endsWith('.json') && !entry.endsWith('.submitted.json') && !entry.includes('.stale'),
      };
    }
    if (!entry || typeof entry !== 'object') return { valid: false };
    const name = String(entry.name || entry.file || entry.path || '');
    const submitted = Boolean(entry.submitted) || name.endsWith('.submitted.json');
    const stale = Boolean(entry.stale) || name.includes('.stale');
    const valid = entry.valid === false
      ? false
      : Boolean(entry.valid) || (name.endsWith('.json') && !submitted && !stale);
    return { ...entry, name, submitted, stale, valid };
  });
}

function getDirectStaleScopes(projectState = {}) {
  const scopes = new Set();
  const stale = projectState.stale && typeof projectState.stale === 'object' ? projectState.stale : {};
  for (const scope of STALE_ORDER) {
    if (stale[scope]) scopes.add(scope);
    if (projectState[`${scope}_invalidated_at`]) scopes.add(scope);
  }
  for (const scope of asArray(projectState.stale_scopes)) {
    if (STALE_ORDER.includes(scope)) scopes.add(scope);
  }
  if (projectState.status === 'stale' || projectState.stage === 'stale') {
    for (const scope of STALE_ORDER) {
      if (stale[scope] || projectState[`${scope}_invalidated_at`]) scopes.add(scope);
    }
  }
  return [...scopes];
}

export function normalizeProjectState(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const stage = normalizeStageName(raw.stage || raw.status || '');
  const status = normalizeStageName(raw.status || raw.stage || stage);
  return {
    ...raw,
    project_id: String(raw.project_id || raw.projectId || '').trim(),
    status,
    stage,
    stale_scopes: getDirectStaleScopes(raw),
    failed: status === 'failed' || stage === 'failed' || Boolean(raw.error_type || raw.user_message),
  };
}

export function deriveArtifactFlags(projectFiles = {}) {
  const reviewContexts = normalizeReviewContexts(projectFiles);
  const videoClips = asArray(projectFiles.videoClips || projectFiles.videos);
  const explicitVideoCount = Number(projectFiles.videoClipCount ?? projectFiles.video_count ?? videoClips.length) || 0;
  const expectedVideoClipCount = Number(projectFiles.expectedVideoClipCount ?? projectFiles.expectedClipCount ?? 6) || 6;
  const uniqueVideoClipCount = countUniqueVideoClips(videoClips);
  const videoClipCount = videoClips.length > 0 ? uniqueVideoClipCount : explicitVideoCount;
  const validReviewContexts = reviewContexts.filter((entry) => entry.valid && !entry.submitted && !entry.stale);
  const submittedReviewContexts = [
    ...reviewContexts.filter((entry) => entry.submitted),
    ...asArray(projectFiles.submittedReviewContexts),
  ];

  return {
    conceptContext: isTruthyArtifact(projectFiles.conceptContext || projectFiles.conceptContexts),
    selectedConcept: isTruthyArtifact(projectFiles.selectedConcept),
    scriptContext: isTruthyArtifact(projectFiles.scriptContext || projectFiles.scriptContexts),
    confirmedScriptContext: isTruthyArtifact(projectFiles.confirmedScriptContext || projectFiles.confirmedScriptContexts),
    validReviewContext: validReviewContexts.length > 0 || projectFiles.validReviewContext === true,
    submittedReviewContext: submittedReviewContexts.length > 0 || projectFiles.submittedReviewContext === true,
    reviewContextCount: validReviewContexts.length,
    videoClipCount,
    expectedVideoClipCount,
    videoClipsComplete: videoClipCount >= expectedVideoClipCount && expectedVideoClipCount > 0,
    finalVideo: isTruthyArtifact(projectFiles.finalVideo || projectFiles.finalVideos),
    exportedFinal: isTruthyArtifact(projectFiles.exportedFinal || projectFiles.exportedFinals || projectFiles.moviesFinal),
  };
}

export function isStale(scope, projectState = {}) {
  const normalized = normalizeProjectState(projectState);
  const targetIndex = STALE_ORDER.indexOf(scope);
  if (targetIndex < 0) return false;
  return normalized.stale_scopes.some((staleScope) => {
    const staleIndex = STALE_ORDER.indexOf(staleScope);
    return staleIndex >= 0 && staleIndex <= targetIndex;
  });
}

export function markStalePatch(scope) {
  const start = scope === 'all' ? 'script' : String(scope || '').trim();
  const startIndex = STALE_ORDER.indexOf(start);
  const staleScopes = startIndex >= 0 ? STALE_ORDER.slice(startIndex) : [];
  const stale = Object.fromEntries(staleScopes.map((item) => [item, true]));
  return {
    status: 'stale',
    stage: 'stale',
    stale,
    stale_scopes: staleScopes,
    downstream_invalidated_scope: start || '',
  };
}

function makeDerived(stage, state, artifacts, extra = {}) {
  return {
    project_id: state.project_id || '',
    stage,
    status: stage,
    priority: STAGE_PRIORITY[stage] ?? 0,
    artifacts,
    staleScopes: state.stale_scopes || [],
    failed: Boolean(state.failed),
    error_type: state.error_type || '',
    user_message: state.user_message || '',
    ...extra,
  };
}

function stageFromState(state) {
  const stage = normalizeStageName(state.stage || state.status);
  return STAGES.includes(stage) ? stage : '';
}

export function deriveProjectStage(projectState = {}, projectFiles = {}) {
  const state = normalizeProjectState(projectState);
  const artifacts = deriveArtifactFlags(projectFiles);
  const finalIsStale = isStale('final', state);
  const videoIsStale = isStale('video', state);
  const storyboardIsStale = isStale('storyboard', state);

  if (artifacts.exportedFinal && !finalIsStale) return makeDerived('exported', state, artifacts);
  if (artifacts.finalVideo && !finalIsStale) return makeDerived('final_generated', state, artifacts);

  const invalidatedDownstream =
    (finalIsStale && (artifacts.finalVideo || artifacts.exportedFinal)) ||
    (videoIsStale && artifacts.videoClipCount > 0) ||
    (storyboardIsStale && artifacts.validReviewContext);

  if (state.failed && !artifacts.finalVideo && !artifacts.exportedFinal && !invalidatedDownstream) {
    return makeDerived('failed', state, artifacts);
  }

  if (invalidatedDownstream || state.stage === 'stale' || state.status === 'stale') {
    return makeDerived('stale', state, artifacts, {
      invalidatedDownstream,
      next_valid_stage: artifacts.confirmedScriptContext
        ? 'script_confirmed'
        : artifacts.scriptContext
          ? 'script_generated'
          : artifacts.conceptContext
            ? 'creative_generated'
            : 'form_submitted',
    });
  }

  if (artifacts.videoClipsComplete && !videoIsStale) return makeDerived('video_clips_generated', state, artifacts);
  if (artifacts.videoClipCount > 0 && !videoIsStale) return makeDerived('video_generating', state, artifacts, { partial: true });
  if (artifacts.validReviewContext && !storyboardIsStale) return makeDerived('storyboard_ready_for_review', state, artifacts);
  if (artifacts.confirmedScriptContext) return makeDerived('script_confirmed', state, artifacts);
  if (artifacts.scriptContext) return makeDerived('script_generated', state, artifacts);
  if (artifacts.conceptContext || artifacts.selectedConcept) return makeDerived('creative_generated', state, artifacts);

  const explicitStage = stageFromState(state);
  if (explicitStage) return makeDerived(explicitStage, state, artifacts);
  return makeDerived('form_submitted', state, artifacts);
}

export function getUserVisibleStage(derivedStage) {
  const stage = typeof derivedStage === 'string' ? normalizeStageName(derivedStage) : normalizeStageName(derivedStage?.stage);
  return STAGE_LABELS[stage] || STAGE_LABELS.form_submitted;
}

export function getNextAction(derivedStage) {
  const stage = typeof derivedStage === 'string' ? normalizeStageName(derivedStage) : normalizeStageName(derivedStage?.stage);
  return NEXT_ACTIONS[stage] || NEXT_ACTIONS.form_submitted;
}
