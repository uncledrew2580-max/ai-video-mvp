import {
  getNextAction,
  getUserVisibleStage,
  STAGE_PRIORITY,
  STAGES,
} from './project-state.service.mjs';

function stageName(derivedStage) {
  const raw = typeof derivedStage === 'string' ? derivedStage : derivedStage?.stage;
  const normalized = String(raw || '').trim().toLowerCase();
  return STAGES.includes(normalized) ? normalized : 'form_submitted';
}

function encode(value) {
  return encodeURIComponent(String(value || ''));
}

function withReviewContext(path, reviewContext) {
  return reviewContext ? `${path}?context=${encode(reviewContext)}` : path;
}

export function getActiveRoute(projectId, derivedStage, options = {}) {
  const stage = stageName(derivedStage);
  const pid = String(projectId || '').trim();
  const conceptContext = options.conceptContext || options.conceptContextName || '';
  const reviewContext = options.reviewContext || options.reviewContextName || '';

  if (stage === 'exported' || stage === 'final_generated') {
    return reviewContext
      ? `/final-video?context=${encode(reviewContext)}`
      : `/active?project_id=${encode(pid)}&stage=final`;
  }

  if (stage === 'video_clips_generated' || stage === 'video_generating' || stage === 'final_generating') {
    return reviewContext
      ? `/review-status?context=${encode(reviewContext)}`
      : `/active?project_id=${encode(pid)}`;
  }

  if (stage === 'storyboard_ready_for_review') {
    return reviewContext
      ? `/reviews/item?context=${encode(reviewContext)}`
      : `/reviews?project_id=${encode(pid)}`;
  }

  if (stage === 'storyboard_generating' || stage === 'script_confirmed') {
    return `/storyboard-status?project_id=${encode(pid)}`;
  }

  if (stage === 'script_generated' || stage === 'script_generating') {
    return `/script-review?project_id=${encode(pid)}`;
  }

  if (stage === 'creative_generated') {
    return conceptContext
      ? `/concepts/item?context=${encode(conceptContext)}`
      : `/concepts?project_id=${encode(pid)}`;
  }

  if (stage === 'creative_generating' || stage === 'form_submitted') {
    return `/submitted?project_id=${encode(pid)}`;
  }

  if (stage === 'failed') {
    return options.errorUrl || `/active?project_id=${encode(pid)}`;
  }

  if (stage === 'stale') {
    return `/active?project_id=${encode(pid)}&stage=stale`;
  }

  return pid ? `/active?project_id=${encode(pid)}` : '/';
}

export function getNextUrl(projectId, derivedStage, options = {}) {
  return getActiveRoute(projectId, derivedStage, options);
}

export function getStageStatusLabel(derivedStage) {
  return getUserVisibleStage(derivedStage);
}

export function shouldAutoRedirect(fromPage, derivedStage) {
  const page = String(fromPage || '').trim().replace(/^https?:\/\/[^/]+/, '').split('?')[0] || '/';
  const stage = stageName(derivedStage);
  if (page === '/submitted') return ['creative_generated', 'failed'].includes(stage);
  if (page === '/concept-status') return ['script_generated', 'script_confirmed', 'failed'].includes(stage);
  if (page === '/storyboard-status') return ['storyboard_ready_for_review', 'failed', 'stale'].includes(stage);
  if (page === '/review-status') return ['final_generated', 'exported', 'failed', 'stale'].includes(stage);
  if (page === '/active') return STAGE_PRIORITY[stage] >= STAGE_PRIORITY.script_generated;
  return false;
}

export function shouldShowSyncButton(page, derivedStage) {
  const normalizedPage = String(page || '').trim().replace(/^https?:\/\/[^/]+/, '').split('?')[0] || '/';
  const stage = stageName(derivedStage);
  const keyPages = new Set([
    '/active',
    '/script-review',
    '/storyboard-status',
    '/reviews/item',
    '/review-status',
    '/final-video',
  ]);
  if (!keyPages.has(normalizedPage)) return false;
  return !['form_submitted', 'creative_generating'].includes(stage);
}

export { getNextAction };

