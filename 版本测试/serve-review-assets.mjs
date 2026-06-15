import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { deriveProjectStage as deriveStageFacade } from '../app-server/services/project-state.service.mjs';
import {
  getActiveRoute as getActiveRouteFacade,
  getStageStatusLabel as getStageStatusLabelFacade,
} from '../app-server/services/stage-router.service.mjs';
import { atomicWriteJson } from './lib/atomic-write.mjs';
import { normalizeManualOutputBase, ensureOutputDirsWritable } from './lib/output-dirs.mjs';
import { runSqlite } from '../lib/sqlite-exec.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Runtime project data lives in the project root (one level up when running from 版本测试/)
const PROJECT_ROOT = process.env.PROJECT_ROOT ||
  (path.basename(SCRIPT_DIR) === '版本测试' ? path.dirname(SCRIPT_DIR) : SCRIPT_DIR);
// Keep __dirname alias for any remaining static-file references inside 版本测试/
const __dirname = SCRIPT_DIR;
// Dist detection: macOS .app/dist path, OR the Windows packaged
// resources/runtime/ layout, OR the desktop-shell signal AI_VIDEO_APP_MODE=1.
function detectAppMode(scriptDir) {
  const s = scriptDir.replace(/\\/g, '/');
  if (s.includes('.app/Contents/') || s.includes('/dist/') || s.includes('/resources/runtime/')) return 'dist';
  if (process.env.AI_VIDEO_APP_MODE === '1') return 'dist';
  return 'source';
}
// Per-user data base, platform-aware: Windows -> %APPDATA%\AI Video,
// macOS -> ~/Library/Application Support/AI Video, others -> ~/.ai-video.
function userSupportDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AI Video');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AI Video');
  }
  return path.join(os.homedir(), '.ai-video');
}
const EARLY_APP_MODE = detectAppMode(SCRIPT_DIR);
const EARLY_APP_SUPPORT_DIR = userSupportDir();
// WORKFLOW_DATA_ROOT: where n8n Code nodes write concept-context / project-state.
// Separate from PROJECT_ROOT so the dist app can keep its own script root while
// reading runtime data from a user-writable directory.
//
// Resolution order:
//   1. WORKFLOW_DATA_ROOT env var (explicit, set by launcher or user)
//   2. Packaged app: ~/Library/Application Support/AI Video/workflow-data
//   3. Source dev: PROJECT_ROOT (same dir as the running script)
const WORKFLOW_DATA_ROOT = (() => {
  if (process.env.WORKFLOW_DATA_ROOT) return process.env.WORKFLOW_DATA_ROOT;
  if (EARLY_APP_MODE === 'dist') return path.join(EARLY_APP_SUPPORT_DIR, 'workflow-data');
  return PROJECT_ROOT;
})();
const ROOT = process.env.PANEL_OUTPUT_DIR || path.join(os.homedir(), 'Downloads', 'n8n分镜图裁剪');
const CACHE_ROOT = path.join(WORKFLOW_DATA_ROOT, '.n8n-local-cache');
const CONCEPT_CONTEXT_ROOT = path.join(CACHE_ROOT, 'concept-context');
const REVIEW_CONTEXT_ROOT = path.join(CACHE_ROOT, 'review-context');
const REVIEW_PROGRESS_ROOT = path.join(CACHE_ROOT, 'review-progress');
const REVIEW_RERUN_LOCK_ROOT = path.join(REVIEW_PROGRESS_ROOT, 'locks');
const SELECTED_CONCEPT_ROOT = path.join(CACHE_ROOT, 'selected-concepts');
const CONCEPT_REVISION_ROOT = path.join(CACHE_ROOT, 'concept-revisions');
const PROJECT_STATE_ROOT = path.join(CACHE_ROOT, 'project-state');
const SCRIPT_CONTEXT_ROOT = path.join(CACHE_ROOT, 'script-context');
const PROJECT_HISTORY_PATH = path.join(CACHE_ROOT, 'project-history.json');
const PROJECT_NOTES_ROOT = path.join(CACHE_ROOT, 'project-notes');
const PROJECT_FEEDBACK_ROOT = path.join(CACHE_ROOT, 'project-feedback');
const VIDEO_OUTPUT_ROOT = process.env.VIDEO_OUTPUT_DIR || path.join(CACHE_ROOT, 'videos');
const DB_PATH = process.env.N8N_DB_PATH || path.join(os.homedir(), '.n8n', 'database.sqlite');
const HOST = '127.0.0.1';
const PORT = Number(process.env.REVIEW_ASSET_PORT || 8788);
const N8N_PORT = Number(process.env.N8N_PORT || 5678);
const SERVER_STARTED_AT = new Date().toISOString();
const SERVER_PID = process.pid;
// app_mode: 'dist' when launched from a packaged app, 'source' otherwise
const APP_MODE = detectAppMode(SCRIPT_DIR);
const APP_SUPPORT_DIR = userSupportDir();
const RUNTIME_ROOT = process.env.AI_VIDEO_RUNTIME_ROOT || (APP_MODE === 'dist' ? APP_SUPPORT_DIR : PROJECT_ROOT);
const LOG_ROOT = process.env.AI_VIDEO_LOG_DIR || (APP_MODE === 'dist' ? path.join(APP_SUPPORT_DIR, 'logs') : path.join(PROJECT_ROOT, 'logs'));
const REVIEW_SUBMIT_NODE_NAME = 'review_submit_resume';
const REVIEW_SUBMIT_WORKFLOW_ID = 'reviewSubmitVeoV2';
const CONCEPT_SELECT_WORKFLOW_ID = 'scriptGenerateV1';
const STORYBOARD_GENERATE_WORKFLOW_ID = 'storyboardGenerateV1';
const REVIEW_MAX_AGE_HOURS = 18;
const REVIEW_MAX_ITEMS = 6;
// Packaged apps must not write inside .app/Contents/Resources. Runtime config
// lives under Application Support; bundled config is only a read-only seed.
const BUNDLED_CONFIG_DIR = path.join(SCRIPT_DIR, 'config');
const CONFIG_DIR = process.env.AI_VIDEO_CONFIG_DIR || (APP_MODE === 'dist' ? path.join(APP_SUPPORT_DIR, 'config') : BUNDLED_CONFIG_DIR);
const CONFIG_PATH = process.env.AI_VIDEO_CONFIG_PATH || path.join(CONFIG_DIR, 'local-config.json');
const CONFIG_SEED_PATH = path.join(BUNDLED_CONFIG_DIR, 'local-config.json');
const CONFIG_EXAMPLE_PATH = path.join(BUNDLED_CONFIG_DIR, 'local-config.example.json');
const BUNDLED_PROMPTS_DIR = path.join(SCRIPT_DIR, 'prompts');
const PROMPTS_DIR = process.env.AI_VIDEO_PROMPTS_DIR || (APP_MODE === 'dist' ? path.join(APP_SUPPORT_DIR, 'prompts') : BUNDLED_PROMPTS_DIR);
const PROMPT_CENTER_PATH = path.join(PROMPTS_DIR, 'prompt_center.json');
const PROMPT_CENTER_SEED_PATH = path.join(BUNDLED_PROMPTS_DIR, 'prompt_center.json');
const PROMPT_CENTER_EXAMPLE_PATH = path.join(BUNDLED_PROMPTS_DIR, 'prompt_center.example.json');
const N8N_HOST = process.env.N8N_HOST || `http://127.0.0.1:${N8N_PORT}`;
const WF01_WORKFLOW_ID = 'rKHHjD2QBlL6EhaM';

// ── Default output directories ─────────────────────────────────────────────
// Base is platform-aware (no hard-coded username), resolved at runtime via
// os.homedir(): Windows -> ~/Videos, macOS -> ~/Movies, others -> ~/Videos.
const DEFAULT_OUTPUT_PARENT = process.platform === 'darwin' ? 'Movies' : 'Videos';
const DEFAULT_OUTPUT_BASE = path.join(os.homedir(), DEFAULT_OUTPUT_PARENT, 'AI Video Outputs');
const DEFAULT_OUTPUT_DIRS = {
  base_dir:       DEFAULT_OUTPUT_BASE,
  storyboard_dir: path.join(DEFAULT_OUTPUT_BASE, 'Storyboards'),
  video_dir:      path.join(DEFAULT_OUTPUT_BASE, 'Videos'),
  voiceover_dir:  path.join(DEFAULT_OUTPUT_BASE, 'Voiceovers'),
  final_dir:      path.join(DEFAULT_OUTPUT_BASE, 'Final'),
};
const LICENSE_APP_SUPPORT_DIR = process.env.AI_VIDEO_LICENSE_DIR || APP_SUPPORT_DIR;
const LICENSE_FILE_PATH = path.join(LICENSE_APP_SUPPORT_DIR, 'license.json');
const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAymJ6dRZnLg2+INhSG0GmVnJeYdfrUj3z4N5jMqkmKe8=
-----END PUBLIC KEY-----`;
const require = createRequire(import.meta.url);
let flattedParse = null;
try {
  ({ parse: flattedParse } = require('flatted'));
} catch {
  try {
    ({ parse: flattedParse } = require(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', 'n8n', 'node_modules', 'flatted')));
  } catch {}
}

// P14-B4: ensure the user-data dirs exist before any config/log write so a fresh
// Windows profile never hits ENOENT on first save. Covers %APPDATA%\AI Video\
// {config, logs, logs\launcher, workflow-data} (and their mac/linux equivalents).
for (const _d of [path.dirname(CONFIG_PATH), LOG_ROOT, path.join(LOG_ROOT, 'launcher'), WORKFLOW_DATA_ROOT]) {
  try { fs.mkdirSync(_d, { recursive: true }); } catch {}
}

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(REVIEW_CONTEXT_ROOT, { recursive: true });
fs.mkdirSync(REVIEW_PROGRESS_ROOT, { recursive: true });
fs.mkdirSync(REVIEW_RERUN_LOCK_ROOT, { recursive: true });
fs.mkdirSync(CONCEPT_CONTEXT_ROOT, { recursive: true });
fs.mkdirSync(SELECTED_CONCEPT_ROOT, { recursive: true });
fs.mkdirSync(CONCEPT_REVISION_ROOT, { recursive: true });
fs.mkdirSync(PROJECT_STATE_ROOT, { recursive: true });
fs.mkdirSync(PROJECT_NOTES_ROOT, { recursive: true });
fs.mkdirSync(PROJECT_FEEDBACK_ROOT, { recursive: true });

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

function safeJoin(root, requestPath) {
  const clean = decodeURIComponent(requestPath.split('?')[0] || '/').replace(/^\/+/, '');
  const full = path.normalize(path.join(root, clean));
  if (!full.startsWith(root)) {
    return null;
  }
  return full;
}

// ── Config helpers ────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) {
      const seed = [CONFIG_SEED_PATH, CONFIG_EXAMPLE_PATH].find((p) => p !== CONFIG_PATH && fs.existsSync(p));
      if (seed) fs.copyFileSync(seed, CONFIG_PATH);
    }
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

const KIE_CONSTANTS = {
  base_url: 'https://api.kie.ai/api',
  text_model: 'gemini-3.1-pro',
  image_model: 'nano-banana-pro',
  video_model: 'veo3_lite',
};

// Stable model preset lists — locked by engineering; not user-editable
const MODEL_PRESETS = {
  text: [
    // verified=true: tested and confirmed working on Kie OpenAI-compat route
    // verified=false: documented by Kie but not yet locally tested — do NOT set as default
    { id: 'gemini-3.1-pro',   label: 'Gemini 3.1 Pro（冻结默认·已验证）',           verified: true,  route: 'openai_chat' },
    { id: 'gemini-2.5-pro',   label: 'Google 高质量（未验证）',              verified: false, route: 'openai_chat' },
    { id: 'gpt-4o',           label: 'OpenAI 备选（未验证）',                verified: false, route: 'openai_chat' },
    { id: 'gpt-4.1',          label: 'OpenAI 备选 4.1（未验证）',            verified: false, route: 'openai_chat' },
  ],
  image: [
    { id: 'nano-banana-pro', label: 'Nano Banana Pro 4K（六宫格·默认）', resolution: '4K', aspect_ratio: '4:5', input_format: 'image_input' },
  ],
  video: [
    { id: 'veo3_lite', label: 'Veo3 Lite（默认）', aspect_ratio: '9:16' },
  ],
};

const AI_CONFIG_DEFAULTS = {
  providers: {
    kie: {
      label: 'Kie.ai 中转站',
      api_key: '',
      base_url: KIE_CONSTANTS.base_url,
      text_base_url: '',
      text_model: KIE_CONSTANTS.text_model,
      image_model: KIE_CONSTANTS.image_model,
      video_model: KIE_CONSTANTS.video_model,
    },
    google: {
      label: 'Google Gemini 官方',
      api_key: '',
      base_url: 'https://generativelanguage.googleapis.com',
      text_model: 'gemini-3-flash-preview',
      image_model: 'gemini-3.1-flash-image-preview',
    },
  },
  tasks: {
    creative_direction: { provider: 'kie', route: 'openai_chat', model: KIE_CONSTANTS.text_model },
    script_framework: { provider: 'kie', route: 'openai_chat', model: KIE_CONSTANTS.text_model },
    storyboard_prompt: { provider: 'kie', route: 'openai_chat', model: KIE_CONSTANTS.text_model },
    storyboard_image: { provider: 'kie', route: 'kie_market_image', model: KIE_CONSTANTS.image_model },
    image_to_video: { provider: 'kie', route: 'kie_veo31', model: KIE_CONSTANTS.video_model },
  },
  license: {
    required: false,
    mode: 'signed_offline',
    app_id: 'ai-video-mvp',
    public_key: LICENSE_PUBLIC_KEY,
  },
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeAiConfig(input = {}) {
  const cfg = input && typeof input === 'object' ? cloneJson(input) : {};
  const out = { ...cfg };
  out.providers = { ...cloneJson(AI_CONFIG_DEFAULTS.providers), ...(cfg.providers || {}) };
  out.providers.kie = { ...cloneJson(AI_CONFIG_DEFAULTS.providers.kie), ...(cfg.providers?.kie || {}) };
  out.providers.google = { ...cloneJson(AI_CONFIG_DEFAULTS.providers.google), ...(cfg.providers?.google || {}) };

  const legacyKie = cfg.kie || {};
  const legacyGemini = cfg.gemini || {};
  if (!out.providers.kie.api_key && legacyKie.api_key) out.providers.kie.api_key = legacyKie.api_key;
  if (legacyKie.base_url) out.providers.kie.base_url = legacyKie.base_url;
  if (legacyKie.text_base_url) out.providers.kie.text_base_url = legacyKie.text_base_url;
  if (legacyKie.text_model) out.providers.kie.text_model = legacyKie.text_model;
  if (legacyKie.image_model) out.providers.kie.image_model = legacyKie.image_model;
  if (legacyKie.video_model) out.providers.kie.video_model = legacyKie.video_model;
  if (!out.providers.google.api_key && legacyGemini.api_key) out.providers.google.api_key = legacyGemini.api_key;
  if (legacyGemini.base_url) out.providers.google.base_url = legacyGemini.base_url;
  if (legacyGemini.text_model) out.providers.google.text_model = legacyGemini.text_model;
  if (legacyGemini.image_model) out.providers.google.image_model = legacyGemini.image_model;

  out.tasks = { ...cloneJson(AI_CONFIG_DEFAULTS.tasks), ...(cfg.tasks || {}) };
  for (const [task, defaults] of Object.entries(AI_CONFIG_DEFAULTS.tasks)) {
    out.tasks[task] = { ...defaults, ...(cfg.tasks?.[task] || {}) };
  }
  const apis = cfg.apis || {};
  if (apis.creative_direction?.model && !cfg.tasks?.creative_direction?.model) out.tasks.creative_direction.model = apis.creative_direction.model;
  if (apis.script_framework?.model && !cfg.tasks?.script_framework?.model) out.tasks.script_framework.model = apis.script_framework.model;
  if (apis.storyboard_image?.model && !cfg.tasks?.storyboard_image?.model) out.tasks.storyboard_image.model = apis.storyboard_image.model;
  if (apis.image_to_video?.model && !cfg.tasks?.image_to_video?.model) out.tasks.image_to_video.model = apis.image_to_video.model;

  const textProvider = out.tasks.creative_direction.provider || 'kie';
  const imageProvider = out.tasks.storyboard_image.provider || 'kie';
  const videoProvider = out.tasks.image_to_video.provider || 'kie';

  out.adapters = out.adapters || {};
  out.adapters.text = textProvider === 'google' ? 'gemini_native' : 'kie_openai_chat';
  out.adapters.image = imageProvider === 'google' ? 'gemini_native' : 'kie_market_image';
  out.adapters.video = videoProvider === 'kie' ? 'kie_veo31' : (out.adapters.video || 'kie_veo31');

  out.kie = {
    ...(out.kie || {}),
    api_key: out.providers.kie.api_key || '',
    base_url: out.providers.kie.base_url || KIE_CONSTANTS.base_url,
    text_base_url: out.providers.kie.text_base_url || '',
    text_model: out.tasks.creative_direction.model || out.providers.kie.text_model || KIE_CONSTANTS.text_model,
    image_model: out.tasks.storyboard_image.model || out.providers.kie.image_model || KIE_CONSTANTS.image_model,
    video_model: out.tasks.image_to_video.model || out.providers.kie.video_model || KIE_CONSTANTS.video_model,
  };
  out.gemini = {
    ...(out.gemini || {}),
    api_key: out.providers.google.api_key || '',
    base_url: out.providers.google.base_url || '',
    text_model: out.providers.google.text_model || AI_CONFIG_DEFAULTS.providers.google.text_model,
    image_model: out.providers.google.image_model || AI_CONFIG_DEFAULTS.providers.google.image_model,
  };

  out.apis = out.apis || {};
  out.apis.creative_direction = {
    ...(out.apis.creative_direction || {}),
    api_key: textProvider === 'google' ? out.providers.google.api_key : '',
    base_url: textProvider === 'google' ? out.providers.google.base_url : (out.providers.kie.text_base_url || out.providers.kie.base_url),
    model: out.tasks.creative_direction.model,
  };
  out.apis.script_framework = {
    ...(out.apis.script_framework || {}),
    api_key: textProvider === 'google' ? out.providers.google.api_key : '',
    base_url: textProvider === 'google' ? out.providers.google.base_url : (out.providers.kie.text_base_url || out.providers.kie.base_url),
    model: out.tasks.script_framework.model,
  };
  out.apis.storyboard_image = {
    ...(out.apis.storyboard_image || {}),
    api_key: imageProvider === 'google' ? out.providers.google.api_key : '',
    base_url: imageProvider === 'google' ? out.providers.google.base_url : out.providers.kie.base_url,
    model: out.tasks.storyboard_image.model,
  };
  out.apis.image_to_video = {
    ...(out.apis.image_to_video || {}),
    api_key: out.providers.kie.api_key || '',
    base_url: out.providers.kie.base_url || KIE_CONSTANTS.base_url,
    model: out.tasks.image_to_video.model,
    provider: 'kie_veo31',
  };

  out.output = out.output || {};
  out.services = out.services || {};
  out.license = {
    ...cloneJson(AI_CONFIG_DEFAULTS.license),
    ...(cfg.license || {}),
  };
  if (!out.license.public_key) out.license.public_key = LICENSE_PUBLIC_KEY;

  // v1 model lock: frozen defaults cannot be overridden by stale config or manual POST
  for (const t of ['creative_direction', 'script_framework', 'storyboard_prompt']) {
    if (out.tasks[t]) out.tasks[t].model = KIE_CONSTANTS.text_model;
    if (out.apis[t]) out.apis[t].model = KIE_CONSTANTS.text_model;
  }
  out.tasks.storyboard_image.model = KIE_CONSTANTS.image_model;
  out.tasks.image_to_video.model = KIE_CONSTANTS.video_model;
  out.apis.storyboard_image.model = KIE_CONSTANTS.image_model;
  out.apis.image_to_video.model = KIE_CONSTANTS.video_model;
  out.providers.kie.text_model = KIE_CONSTANTS.text_model;
  out.providers.kie.image_model = KIE_CONSTANTS.image_model;
  out.providers.kie.video_model = KIE_CONSTANTS.video_model;
  out.kie.text_model = KIE_CONSTANTS.text_model;
  out.kie.image_model = KIE_CONSTANTS.image_model;
  out.kie.video_model = KIE_CONSTANTS.video_model;

  return out;
}

function applyKieConstants(cfg) {
  return normalizeAiConfig(cfg);
}

// P14-B4: single atomic config writer. Ensures the parent dir of CONFIG_PATH
// (which can differ from CONFIG_DIR when AI_VIDEO_CONFIG_PATH overrides it, e.g.
// Windows %APPDATA%\AI Video\config) then writes via tmp->rename. On failure it
// surfaces a Chinese error with the config path and log dir for diagnostics.
function writeConfigAtomic(obj) {
  try {
    atomicWriteJson(CONFIG_PATH, obj);
  } catch (e) {
    throw new Error(`保存配置失败（${e.code || e.message}）。配置文件：${CONFIG_PATH}。日志目录：${LOG_ROOT}`);
  }
}

function saveConfig(updates) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const current = normalizeAiConfig(loadConfig());
  const merged = { ...current };
  // Legacy flat keys (kept for backward compat)
  const ALLOWED_FLAT_KEYS = [
    'gemini_api_key_file', 'kie_api_key_file',
    'gemini_text_model', 'gemini_image_model', 'kie_video_model',
    'video_output_dir', 'storyboard_output_dir',
    'n8n_host', 'n8n_form_workflow_id',
  ];
  for (const k of ALLOWED_FLAT_KEYS) {
    if (k in updates && typeof updates[k] === 'string') merged[k] = updates[k].trim();
  }
  // New structured config: apis / output / services
  const API_SECTIONS = ['creative_direction', 'script_framework', 'storyboard_image', 'image_to_video'];
  if (updates.apis && typeof updates.apis === 'object') {
    merged.apis = merged.apis || {};
    for (const section of API_SECTIONS) {
      if (updates.apis[section] && typeof updates.apis[section] === 'object') {
        merged.apis[section] = merged.apis[section] || {};
        const { api_key, base_url, model } = updates.apis[section];
        if (typeof api_key === 'string' && api_key.trim()) merged.apis[section].api_key = api_key.trim();
        if (typeof base_url === 'string') merged.apis[section].base_url = base_url.trim();
        if (typeof model === 'string') merged.apis[section].model = model.trim();
      }
    }
  }
  if (updates.providers && typeof updates.providers === 'object') {
    merged.providers = merged.providers || {};
    for (const provider of ['kie', 'google']) {
      if (updates.providers[provider] && typeof updates.providers[provider] === 'object') {
        merged.providers[provider] = merged.providers[provider] || {};
        for (const field of ['api_key', 'base_url', 'text_base_url', 'text_model', 'image_model', 'video_model']) {
          const value = updates.providers[provider][field];
          if (typeof value !== 'string') continue;
          if (field === 'api_key' && !value.trim()) continue;
          merged.providers[provider][field] = value.trim();
        }
      }
    }
  }
  if (updates.tasks && typeof updates.tasks === 'object') {
    merged.tasks = merged.tasks || {};
    for (const task of Object.keys(AI_CONFIG_DEFAULTS.tasks)) {
      if (updates.tasks[task] && typeof updates.tasks[task] === 'object') {
        merged.tasks[task] = merged.tasks[task] || {};
        for (const field of ['provider', 'route', 'model']) {
          let value = updates.tasks[task][field];
          // v1 lock: storyboard_image model locked to nano-banana-pro (6-grid chain only)
          if (task === 'storyboard_image' && field === 'model' && typeof value === 'string') {
            value = 'nano-banana-pro';
          }
          if (typeof value === 'string') merged.tasks[task][field] = value.trim();
        }
      }
    }
  }
  if (updates.output && typeof updates.output === 'object') {
    merged.output = merged.output || {};
    for (const k of ['base_dir', 'storyboard_dir', 'video_dir', 'voiceover_dir', 'final_dir']) {
      if (typeof updates.output[k] === 'string') {
        const v = updates.output[k].trim();
        if (!v) { merged.output[k] = v; continue; }
        const safe = isOutputPathSafe(v);
        if (!safe.ok) throw new Error(`output.${k}：${safe.reason}`);
        merged.output[k] = safe.normalized;
      }
    }
    // Sync legacy flat fields
    if (merged.output.storyboard_dir) merged.storyboard_output_dir = merged.output.storyboard_dir;
    if (merged.output.video_dir) merged.video_output_dir = merged.output.video_dir;
  }
  if (updates.services && typeof updates.services === 'object') {
    merged.services = merged.services || {};
    if (typeof updates.services.n8n_host === 'string') merged.services.n8n_host = updates.services.n8n_host.trim();
    if (typeof updates.services.workspace_host === 'string') merged.services.workspace_host = updates.services.workspace_host.trim();
    // Mirror n8n_host to flat key for backward compat
    if (merged.services.n8n_host) merged.n8n_host = merged.services.n8n_host;
  }
  if (updates.license && typeof updates.license === 'object') {
    merged.license = merged.license || {};
    for (const field of ['required', 'mode', 'app_id', 'public_key']) {
      const value = updates.license[field];
      if (typeof value === 'boolean') merged.license[field] = value;
      if (typeof value === 'string') merged.license[field] = value.trim();
    }
  }
  // Gemini section: api_key + base_url + text_model + image_model → mirrors to text/image apis
  if (updates.gemini && typeof updates.gemini === 'object') {
    merged.gemini = merged.gemini || {};
    const { api_key, base_url, text_model, image_model } = updates.gemini;
    if (typeof api_key === 'string') merged.gemini.api_key = api_key.trim();
    if (typeof base_url === 'string') merged.gemini.base_url = base_url.trim();
    if (typeof text_model === 'string') merged.gemini.text_model = text_model.trim();
    if (typeof image_model === 'string') merged.gemini.image_model = image_model.trim();
    merged.apis = merged.apis || {};
    const gKey = merged.gemini.api_key || '';
    const gBase = merged.gemini.base_url || '';
    for (const sect of ['creative_direction', 'script_framework', 'storyboard_image']) {
      merged.apis[sect] = merged.apis[sect] || {};
      if (gKey) merged.apis[sect].api_key = gKey;
      merged.apis[sect].base_url = gBase;
    }
    if (merged.gemini.text_model) {
      merged.apis.creative_direction.model = merged.gemini.text_model;
      merged.apis.script_framework.model = merged.gemini.text_model;
    }
    if (merged.gemini.image_model) merged.apis.storyboard_image.model = merged.gemini.image_model;
  }
  // Kie section: api_key + base_url + video_model + text_model + image_model
  // video → mirrors to image_to_video; text/image stored for Kie adapter routing
  if (updates.kie && typeof updates.kie === 'object') {
    merged.kie = merged.kie || {};
    const { api_key } = updates.kie;
    // Only overwrite if user submitted a non-empty value; empty = "keep existing"
    if (typeof api_key === 'string' && api_key.trim()) merged.kie.api_key = api_key.trim();
    // Video: always route through Kie
    merged.apis = merged.apis || {};
    merged.apis.image_to_video = merged.apis.image_to_video || {};
    if (merged.kie.api_key) merged.apis.image_to_video.api_key = merged.kie.api_key;
    if (merged.kie.base_url) merged.apis.image_to_video.base_url = merged.kie.base_url;
    if (merged.kie.video_model) merged.apis.image_to_video.model = merged.kie.video_model;
    merged.apis.image_to_video.provider = merged.apis.image_to_video.provider || 'kie_veo31';
    // Guard: never let Kie key bleed into Gemini-format text/image apis
  }
  // Adapters section: records which provider handles each capability
  if (updates.adapters && typeof updates.adapters === 'object') {
    merged.adapters = merged.adapters || {};
    if (typeof updates.adapters.text === 'string') merged.adapters.text = updates.adapters.text.trim();
    if (typeof updates.adapters.image === 'string') merged.adapters.image = updates.adapters.image.trim();
    if (typeof updates.adapters.video === 'string') merged.adapters.video = updates.adapters.video.trim();
  }
  merged.adapters = merged.adapters || {};
  if (!merged.adapters.text) merged.adapters.text = 'kie_openai_chat';
  if (!merged.adapters.image) merged.adapters.image = 'kie_market_image';
  if (!merged.adapters.video) merged.adapters.video = 'kie_veo31';
  const normalized = normalizeAiConfig(merged);
  writeConfigAtomic(normalized);
}

function chooseDirectoryWithSystemDialog() {
  if (process.platform !== 'darwin') {
    throw new Error('当前界面无法在 Windows/Linux 上弹出原生选择框，请直接在输入框粘贴保存路径，或点击“恢复默认位置”。');
  }
  const script = [
    'set chosenFolder to choose folder with prompt "请选择保存文件夹"',
    'POSIX path of chosenFolder',
  ].join('\n');
  return execFileSync('osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: 120000,
  }).trim();
}

// ── Output path helpers ────────────────────────────────────────────────────

function expandPath(p) {
  if (!p) return '';
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// Returns {ok, reason, normalized} — never throws
function isOutputPathSafe(p) {
  if (!p || !p.trim()) return { ok: false, reason: '路径未配置' };
  let normalized;
  try { normalized = path.resolve(expandPath(p.trim())); } catch { return { ok: false, reason: '路径无效' }; }
  if (process.env.AI_VIDEO_ALLOW_TEST_OUTPUT_DIR === '1') {
    try {
      const testRoot = path.resolve(WORKFLOW_DATA_ROOT);
      if (normalized === testRoot || normalized.startsWith(testRoot + path.sep)) {
        return { ok: true, normalized };
      }
    } catch {}
  }
  const DANGER = [
    /\.app\//i,
    /\.app$/i,
    /\/Volumes\//,
    /release-candidates/i,
    /AI-Video-Mac-MVP-\d/i,
    /^\/Applications\b/,
    /^\/System\b/,
    /^\/usr\b/,
    /^\/etc\b/,
    /^\/bin\b/,
    /^\/sbin\b/,
    /^\/private\b/,
    /^\/tmp\b/,
    /^\/var\b/,
    /^\/Library\b/,
  ];
  for (const re of DANGER) {
    if (re.test(normalized)) return { ok: false, reason: '该目录不适合作为输出目录，请选择普通本地文件夹，或点击恢复默认位置。' };
  }
  return { ok: true, normalized };
}

function getConfiguredFinalOutputDir() {
  const cfg = loadConfig();
  const outCfg = cfg.output || {};
  const baseDir = String(outCfg.base_dir || '').trim() || DEFAULT_OUTPUT_BASE;
  const finalDir = String(outCfg.final_dir || '').trim() || path.join(baseDir, 'Final');
  const safeFinalDir = isOutputPathSafe(finalDir);
  return safeFinalDir.ok ? safeFinalDir.normalized : '';
}

// Returns detailed status object for /api/env-status
function checkOutputPathStatus(p) {
  const safe = isOutputPathSafe(p);
  if (!safe.ok) return { value: p || '', configured: !!p, safe: false, reason: safe.reason };
  const normalized = safe.normalized;
  let exists = false, isDirectory = false, writable = false;
  try { const st = fs.statSync(normalized); exists = true; isDirectory = st.isDirectory(); } catch {}
  if (exists && isDirectory) {
    try { const t = path.join(normalized, '.write_test_' + Date.now()); fs.writeFileSync(t, ''); fs.unlinkSync(t); writable = true; } catch {}
  }
  return { value: normalized, configured: true, safe: true, exists, isDirectory, writable };
}

// Creates all default output dirs and patches config if any dir is empty
function ensureDefaultOutputDirs() {
  try {
    const raw = loadConfig();
    const out = raw.output || {};
    const dirty = {};
    for (const [key, defaultVal] of Object.entries(DEFAULT_OUTPUT_DIRS)) {
      const cur = String(out[key] || '').trim();
      if (!cur) dirty[key] = defaultVal;
    }
    // Also fix legacy flat fields
    const legacyDirty = {};
    if (!String(raw.storyboard_output_dir || '').trim()) legacyDirty.storyboard_output_dir = DEFAULT_OUTPUT_DIRS.storyboard_dir;
    if (!String(raw.video_output_dir || '').trim()) legacyDirty.video_output_dir = DEFAULT_OUTPUT_DIRS.video_dir;

    if (Object.keys(dirty).length === 0 && Object.keys(legacyDirty).length === 0) return; // already configured

    // Always ensure all default subdirs exist
    for (const val of Object.values(DEFAULT_OUTPUT_DIRS)) {
      try { fs.mkdirSync(val, { recursive: true }); } catch {}
    }

    // Write config whenever dirty OR legacyDirty has entries
    const merged = { ...raw, output: { ...out, ...dirty }, ...legacyDirty };
    writeConfigAtomic(merged);
  } catch {}
}

function apiKeyConfigured(filePath) {
  if (!filePath) return false;
  try {
    const expanded = filePath.replace(/^~/, os.homedir());
    return fs.existsSync(expanded) && fs.readFileSync(expanded, 'utf8').trim().length > 10;
  } catch { return false; }
}

function formatElapsed(ms) {
  if (ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function translateShotError(err) {
  if (!err) return '';
  const e = String(err);
  if (e.includes('用户手动标记')) return '用户手动标记需要重做';
  if (e.includes('balance') || e.includes('insufficient') || e.includes('quota')) return '账户余额不足，请登录 Kie 后台充值后重试';
  if (e.includes('timeout') || e.includes('TIMEOUT')) return '请求超时，视频生成未在预期时间内完成';
  if (e.includes('rate') || e.includes('429')) return '请求过于频繁，请稍后重试';
  if (e.includes('401') || e.includes('403') || e.includes('Unauthorized') || e.includes('invalid_api_key')) return 'API Key 无效或无权限，请检查 Kie API Key 配置';
  if (e.includes('500') || e.includes('502') || e.includes('503')) return 'Kie 服务暂时不可用，请稍后重试';
  return e.length > 120 ? e.slice(0, 120) + '…' : e;
}

function getN8nFormUrl() {
  const cfg = loadConfig();
  const host = getConfiguredN8nHost();
  const workflowId = cfg.n8n_form_workflow_id || WF01_WORKFLOW_ID;
  try {
    const webhookPath = runSqlite([
      DB_PATH,
      `SELECT webhookPath FROM webhook_entity WHERE workflowId='${workflowId}' AND method='GET' LIMIT 1;`,
    ], { encoding: 'utf8' }).trim();
    if (webhookPath) return `${host}/form/${webhookPath}`;
  } catch {}
  return `${host}/form/`;
}

function getConfiguredN8nHost() {
  const cfg = loadConfig();
  return String(
    process.env.N8N_HOST ||
    cfg.services?.n8n_host ||
    cfg.n8n_host ||
    N8N_HOST
  ).replace(/\/+$/, '');
}

function getConfiguredWorkspaceHost() {
  const cfg = loadConfig();
  return String(
    process.env.WORKSPACE_HOST ||
    cfg.services?.workspace_host ||
    `http://127.0.0.1:${PORT}`
  ).replace(/\/+$/, '');
}

function renderProductFormPage(errorMessage = '') {
  const taskOptions = ['种草', '口播', '开箱', '产品展示', '痛点前置', '真实故事剧情', '爆点故事剧情', '自由创作'];
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>填写产品信息｜AI Video</title>
  ${commonCSS()}
  <style>
    body{
      background:
        radial-gradient(circle at 16% 10%, rgba(37,99,235,.16), transparent 28%),
        radial-gradient(circle at 84% 8%, rgba(6,182,212,.13), transparent 28%),
        linear-gradient(135deg,#f8fbff 0%,#edf4fb 48%,#f7fbff 100%);
    }
    .intake-shell{max-width:1180px;padding-top:34px;}
    .intake-hero{
      display:grid;
      grid-template-columns:1.1fr .9fr;
      gap:18px;
      align-items:stretch;
      margin-bottom:16px;
    }
    .intake-panel{
      position:relative;
      overflow:hidden;
      border:1px solid rgba(148,163,184,.28);
      border-radius:16px;
      background:rgba(255,255,255,.82);
      box-shadow:0 24px 70px rgba(15,23,42,.10);
      backdrop-filter:blur(18px);
    }
    .intake-panel::before{
      content:"";
      position:absolute;
      inset:0 0 auto 0;
      height:3px;
      background:linear-gradient(90deg,#2563eb,#06b6d4,#8b5cf6);
    }
    .intake-head{padding:28px 30px 22px;}
    .eyebrow{
      display:inline-flex;
      align-items:center;
      gap:8px;
      margin-bottom:12px;
      padding:5px 10px;
      border-radius:999px;
      background:rgba(37,99,235,.08);
      color:#1d4ed8;
      font-size:12px;
      font-weight:800;
      letter-spacing:.03em;
    }
    .intake-title{font-size:32px;line-height:1.15;margin:0 0 12px;letter-spacing:0;color:#0f172a;}
    .intake-sub{font-size:15px;line-height:1.85;color:#475569;margin:0;max-width:680px;}
    .intake-status{
      padding:28px;
      display:flex;
      flex-direction:column;
      justify-content:space-between;
      min-height:208px;
      background:
        linear-gradient(135deg,rgba(15,23,42,.95),rgba(30,41,59,.92)),
        radial-gradient(circle at 80% 0%,rgba(6,182,212,.25),transparent 35%);
      color:#e5edf8;
    }
    .status-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px;}
    .status-chip{
      border:1px solid rgba(148,163,184,.22);
      border-radius:10px;
      padding:10px 12px;
      background:rgba(255,255,255,.06);
    }
    .status-chip b{display:block;font-size:16px;color:#fff;margin-bottom:2px;}
    .status-chip span{font-size:11px;color:#9fb0ca;}
    .intake-form-card{padding:28px 30px;}
    .form-section-title{font-size:13px;font-weight:900;color:#0f172a;margin:0 0 14px;letter-spacing:.04em;text-transform:uppercase;}
    .premium-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    .premium-field{display:block;}
    .premium-label{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;font-size:13px;font-weight:800;color:#0f172a;}
    .premium-hint{font-size:11px;color:#64748b;font-weight:600;}
    .premium-input,
    .premium-select,
    .premium-textarea{
      width:100%;
      border:1px solid #cbd5e1;
      border-radius:11px;
      background:rgba(255,255,255,.92);
      color:#0f172a;
      font:inherit;
      font-size:14px;
      padding:12px 14px;
      transition:border-color .16s,box-shadow .16s,background .16s;
    }
    .premium-textarea{min-height:138px;resize:vertical;line-height:1.7;}
    .premium-input:focus,
    .premium-select:focus,
    .premium-textarea:focus{
      outline:none;
      border-color:#2563eb;
      background:#fff;
      box-shadow:0 0 0 4px rgba(37,99,235,.13);
    }
    .upload-zone{
      border:1px dashed #93c5fd;
      border-radius:14px;
      background:linear-gradient(135deg,rgba(239,246,255,.88),rgba(240,253,250,.70));
      padding:18px;
    }
    .upload-zone input{margin-top:10px;}
    .form-actions{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:14px;
      margin-top:22px;
      padding-top:18px;
      border-top:1px solid #e2e8f0;
    }
    .submit-big{
      min-height:46px;
      padding:0 22px;
      border-radius:12px;
      font-size:14px;
      box-shadow:0 16px 36px rgba(37,99,235,.20);
    }
    @media (max-width:860px){
      .intake-hero,.premium-grid{grid-template-columns:1fr;}
      .intake-title{font-size:26px;}
      .intake-head,.intake-form-card{padding:22px;}
    }
  </style>
</head>
<body>
  ${renderStageNav('form')}
  <main class="intake-shell">
    <section class="intake-hero">
      <div class="intake-panel">
        <div class="intake-head">
          <div class="eyebrow">AI VIDEO INTAKE</div>
          <h1 class="intake-title">输入产品信息，启动短视频生成链路</h1>
          <p class="intake-sub">填写产品、市场、语言和创作类型。AI Video 会在后台调用本地 n8n 引擎生成创意方向，整个过程停留在客户端内。</p>
        </div>
      </div>
      <div class="intake-panel intake-status">
        <div>
          <div class="eyebrow" style="background:rgba(14,165,233,.13);color:#67e8f9;">LOCAL ENGINE</div>
          <h2 style="color:#fff;font-size:24px;margin:0 0 8px;">本地工作流已接管</h2>
          <p style="margin:0;color:#9fb0ca;line-height:1.75;">前台是 AI Video，后台是自动化引擎。用户不需要进入 n8n 页面。</p>
        </div>
        <div class="status-grid">
          <div class="status-chip"><b>1–5</b><span>产品图片</span></div>
          <div class="status-chip"><b>2–3</b><span>创意方向</span></div>
          <div class="status-chip"><b>5–10m</b><span>前半段生成</span></div>
          <div class="status-chip"><b>Local</b><span>上下文落盘</span></div>
        </div>
      </div>
    </section>
    <section class="intake-panel">
      <div class="intake-form-card">
      ${errorMessage ? `<div class="alert-err" style="margin-bottom:14px;">${htmlEscape(errorMessage)}</div>` : ''}
      <form id="product-intake-form" method="POST" action="/submit-product" enctype="multipart/form-data">
        <p class="form-section-title">基础信息</p>
        <div class="premium-grid">
          <label class="premium-field">
            <span class="premium-label">产品名称 <em class="premium-hint">必填</em></span>
            <input class="premium-input" name="field-0" required placeholder="例如：LED 补光灯 / 宠物梳 / 旅行收纳包" />
          </label>
          <label class="premium-field">
            <span class="premium-label">目标市场 <em class="premium-hint">必填</em></span>
            <input class="premium-input" name="field-2" required value="United States" placeholder="例如：United States" />
          </label>
          <label class="premium-field">
            <span class="premium-label">目标语言 <em class="premium-hint">必填</em></span>
            <input class="premium-input" name="field-3" required value="English" placeholder="例如：English" />
          </label>
          <label class="premium-field">
            <span class="premium-label">创作任务类型 <em class="premium-hint">选择一个方向</em></span>
            <select class="premium-select" name="field-4">
              ${taskOptions.map((item) => `<option value="${htmlEscape(item)}">${htmlEscape(item)}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="premium-field" style="margin-top:18px;">
          <span class="premium-label">产品卖点补充 <em class="premium-hint">选填</em></span>
          <textarea class="premium-textarea" name="field-1" rows="5" placeholder="可写材质、功能、人群、痛点、参考卖点、你希望避免的方向。"></textarea>
        </label>
        <label class="premium-field upload-zone" style="display:block;margin-top:18px;">
          <span class="premium-label">上传产品图片 <em class="premium-hint">1–5 张 · 必填</em></span>
          <span class="muted" style="display:block;font-size:13px;">请至少上传 1 张清晰产品图（jpg/png）。AI 创意方向需要真实产品图片作为输入，不支持纯文字生成。</span>
          <input type="file" name="field-5" accept=".jpg,.jpeg,.png,image/jpeg,image/png" multiple required />
        </label>
        <div class="form-actions">
          <span id="product-submit-status" class="muted" style="font-size:12px;">提交后会进入“创意方向”阶段，可在工作台查看进度。</span>
          <div class="btn-row" style="margin:0;">
          <button id="product-submit-button" class="btn btn-primary submit-big" type="submit">提交并生成创意方向</button>
          <a class="btn btn-secondary" href="/">取消</a>
          </div>
        </div>
      </form>
      </div>
    </section>
  </main>
  <script>
  (() => {
    const form = document.getElementById('product-intake-form');
    const button = document.getElementById('product-submit-button');
    const status = document.getElementById('product-submit-status');
    if (!form || !button || !status) return;
    let submitting = false;
    form.addEventListener('submit', (event) => {
      if (submitting) {
        event.preventDefault();
        return;
      }
      if (typeof form.checkValidity === 'function' && !form.checkValidity()) return;
      submitting = true;
      button.disabled = true;
      button.textContent = '正在提交，请勿重复点击...';
      status.textContent = '正在上传产品图片并提交，请勿关闭窗口。';
      window.setTimeout(() => {
        if (!submitting) return;
        button.disabled = false;
        button.textContent = '重新提交';
        status.textContent = '提交可能卡住，请检查网络或重新进入工作台查看项目状态。若工作台没有新项目，可再提交一次。';
      }, 60000);
    });
  })();
  </script>
</body>
</html>`;
}

// ── Prompt center helpers ─────────────────────────────────────────────────────

// Returns true if the stored prompt predates required bundled prompt fixes.
function _isStalePromptCenter(center) {
  const directorUt = center?.director?.user_template || '';
  const scriptSi = center?.script?.system_instruction || '';
  return (
    directorUt.includes('6 到 9 个镜头') ||
    directorUt.includes('6 宫格还是 9 宫格') ||
    !scriptSi.includes('TikTok 短平快约束') ||
    !scriptSi.includes('口播者一致性约束') ||
    !center?.voice_localization ||
    !center?.veo_quality_constraints
  );
}

function _logPromptMigration(backupPath) {
  try {
    const logDir = path.join(LOG_ROOT, 'launcher');
    fs.mkdirSync(logDir, { recursive: true });
    const entry = `[${new Date().toISOString()}] prompt_center.json auto-migrated to bundle version (stale 9-grid / missing TikTok short-fast / missing voice consistency / missing P18 voice localization / missing P18 Veo quality constraints detected); backup: ${backupPath}\n`;
    fs.appendFileSync(path.join(logDir, 'prompt-migration.log'), entry, 'utf8');
  } catch {}
}

function loadPromptCenter() {
  try {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true });
    if (!fs.existsSync(PROMPT_CENTER_PATH)) {
      // First run: seed from bundle.
      const seed = [PROMPT_CENTER_SEED_PATH, PROMPT_CENTER_EXAMPLE_PATH].find((p) => p !== PROMPT_CENTER_PATH && fs.existsSync(p));
      if (seed) fs.copyFileSync(seed, PROMPT_CENTER_PATH);
    } else if (PROMPT_CENTER_PATH !== PROMPT_CENTER_SEED_PATH && fs.existsSync(PROMPT_CENTER_SEED_PATH)) {
      // Upgrade migration: if existing App Support prompt is stale, back it up and replace with bundle.
      try {
        const existing = JSON.parse(fs.readFileSync(PROMPT_CENTER_PATH, 'utf8'));
        if (_isStalePromptCenter(existing)) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
          const backupPath = PROMPT_CENTER_PATH.replace(/\.json$/, `.bak-${ts}.json`);
          fs.copyFileSync(PROMPT_CENTER_PATH, backupPath);
          fs.copyFileSync(PROMPT_CENTER_SEED_PATH, PROMPT_CENTER_PATH);
          _logPromptMigration(backupPath);
        }
      } catch {}
    }
    if (fs.existsSync(PROMPT_CENTER_PATH)) {
      return JSON.parse(fs.readFileSync(PROMPT_CENTER_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function savePromptModule(moduleName, field, value) {
  const EDITABLE_MODULES = ['director', 'script', 'storyboard', 'nanobanana_image', 'veo_repair', 'gemini_models'];
  if (!EDITABLE_MODULES.includes(moduleName)) throw new Error(`不允许编辑模块: ${moduleName}`);
  const center = loadPromptCenter();
  if (!center[moduleName]) center[moduleName] = {};
  center[moduleName][field] = value;
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  const tmp = PROMPT_CENTER_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(center, null, 2), 'utf8');
  fs.renameSync(tmp, PROMPT_CENTER_PATH);
}

function resetPromptModule(moduleName) {
  if (!fs.existsSync(PROMPT_CENTER_EXAMPLE_PATH)) throw new Error('默认提示词文件不存在，无法恢复。');
  const example = JSON.parse(fs.readFileSync(PROMPT_CENTER_EXAMPLE_PATH, 'utf8'));
  if (!example[moduleName]) throw new Error(`默认文件中无此模块: ${moduleName}`);
  const center = loadPromptCenter();
  center[moduleName] = example[moduleName];
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  const tmp = PROMPT_CENTER_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(center, null, 2), 'utf8');
  fs.renameSync(tmp, PROMPT_CENTER_PATH);
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeAssetUrl(url) {
  return String(url || '')
    .replace(/^http:\/\/127\.0\.0\.1:8787/i, `http://127.0.0.1:${PORT}`)
    .replace(/^http:\/\/localhost:8787/i, `http://127.0.0.1:${PORT}`);
}

function localFileAssetUrl(filePath) {
  return `/local-file?path=${encodeURIComponent(String(filePath || ''))}`;
}

function isAllowedLocalAssetPath(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  const allowedRoots = [
    ROOT,
    path.join(CACHE_ROOT, 'videos'),
    path.join(CACHE_ROOT, 'final-video'),
    path.join(CACHE_ROOT, '分镜图裁剪'),
  ].map((root) => path.resolve(root) + path.sep);
  return allowedRoots.some((root) => resolved.startsWith(root));
}

const TASK_TYPE_LABELS = {
  mixed: '混合型：产品展示 + 轻口播/字幕',
  local_voiceover: '本地口播型',
  pure_display: '纯展示型',
  pure_display_or_light_voiceover: '纯展示/轻口播',
  story_drama: '剧情带货型',
};
function taskTypeLabel(raw) {
  return TASK_TYPE_LABELS[raw] || raw || '';
}

function normalizeShotIdToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^shot[_-]?\d+$/i.test(raw)) {
    const num = raw.match(/(\d+)/)?.[1] || '';
    return num ? `shot_${num}` : raw;
  }
  if (/^\d+$/.test(raw)) {
    return `shot_${raw}`;
  }
  return raw;
}

function normalizeShotIdList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\n,，\s]+/);
  return list.map(normalizeShotIdToken).filter(Boolean);
}

function readContextFile(contextPath) {
  try {
    return JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  } catch (error) {
    return {
      context_read_error: error.message || String(error),
    };
  }
}

function submittedSidecarPath(contextPath) {
  const normalized = normalizeReviewContextPath(contextPath);
  return `${normalized}.submitted.json`;
}

function normalizeReviewContextPath(contextPath) {
  let normalized = String(contextPath || '').trim();
  if (!normalized) return '';
  while (normalized.endsWith('.submitted.json')) {
    normalized = normalized.slice(0, -'.submitted.json'.length);
  }
  return normalized;
}

function progressSidecarPath(projectId) {
  const safeProjectId = String(projectId || 'proj').replace(/[^a-zA-Z0-9_-]+/g, '_');
  return path.join(REVIEW_PROGRESS_ROOT, `review_progress_${safeProjectId}.json`);
}

function rerunShotLockPath(projectId, shotId) {
  const safeProjectId = String(projectId || 'proj').replace(/[^a-zA-Z0-9_-]+/g, '_');
  const safeShotId = normalizeShotIdToken(shotId).replace(/[^a-zA-Z0-9_-]+/g, '_') || 'shot';
  return path.join(REVIEW_RERUN_LOCK_ROOT, `rerun_video_${safeProjectId}_${safeShotId}.lock.json`);
}

function readActiveRerunShotLock(projectId, shotId, ttlMs = 10 * 60 * 1000) {
  const lockPath = rerunShotLockPath(projectId, shotId);
  if (!fs.existsSync(lockPath)) return null;
  const lock = readContextFile(lockPath);
  const createdAtMs = new Date(lock.created_at || 0).getTime();
  if (!createdAtMs || Date.now() - createdAtMs > ttlMs) {
    try { fs.unlinkSync(lockPath); } catch {}
    return null;
  }
  return { ...lock, lock_path: lockPath };
}

function writeRerunShotLock(projectId, shotId, contextPath) {
  const lock = {
    project_id: projectId,
    shot_id: normalizeShotIdToken(shotId),
    review_context_path: contextPath,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(rerunShotLockPath(projectId, shotId), JSON.stringify(lock, null, 2));
  return lock;
}

function clearRerunShotLock(projectId, shotId) {
  try { fs.unlinkSync(rerunShotLockPath(projectId, shotId)); } catch {}
}

function hoursAgo(ms) {
  return Date.now() - ms <= REVIEW_MAX_AGE_HOURS * 60 * 60 * 1000;
}

function listProjectVideoFiles(projectId) {
  if (!projectId || !fs.existsSync(VIDEO_OUTPUT_ROOT)) {
    return [];
  }
  return fs
    .readdirSync(VIDEO_OUTPUT_ROOT)
    .filter(
      (name) =>
        name.endsWith('.mp4') &&
        (name.startsWith(`veo_${projectId}_`) || name.startsWith(`wavespeed_${projectId}_`) || name.startsWith(`modelhub_${projectId}_`) || name.startsWith(`kie_${projectId}_`) || name.startsWith(`kie_veo31_${projectId}_`) || name.startsWith(`tk888_media_${projectId}_`)),
    )
    .sort()
    .map((name) => path.join(VIDEO_OUTPUT_ROOT, name));
}

function findProjectVideoForShot(projectId, videoFiles, shot) {
  const orderRaw = String(shot.shot_order || shot.shot_id || '').replace(/^shot[_-]?/i, '').trim();
  const order = String(Number(orderRaw || 0) || orderRaw || '').trim();
  const paddedOrder = /^\d+$/.test(order) ? order.padStart(2, '0') : order;
  const shotId = String(shot.shot_id || (order ? `shot_${order}` : '')).toLowerCase();
  const projectToken = String(projectId || '').toLowerCase();
  return (videoFiles || []).find((videoPath) => {
    const name = path.basename(videoPath).toLowerCase();
    if (order && name.startsWith(`kie_veo31_${projectToken}_${order}_`)) return true;
    if (order && name.startsWith(`tk888_media_${projectToken}_${order}_`)) return true;
    if (order && name.includes(`_${order}_`)) return true;
    if (paddedOrder && name.includes(`_${paddedOrder}_`)) return true;
    return shotId && /^shot[_-]?\d+$/i.test(shotId) && name.includes(shotId);
  }) || '';
}

function readProgressFile(projectId) {
  const filePath = progressSidecarPath(projectId);
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const data = readContextFile(filePath);
  return {
    ...data,
    progress_path: filePath,
  };
}

// Returns {active, reason, execId} — true when an n8n execution is running/waiting OR progress
// shows submitted/running shots. Callers must block forwardReviewSubmission when active=true.
function isVideoGenerationActive(projectId) {
  if (!projectId) return { active: false, reason: '', execId: null };
  const exec = findActiveExecutionForProject(projectId, REVIEW_SUBMIT_WORKFLOW_ID);
  if (exec && ['running', 'waiting'].includes(String(exec.status || ''))) {
    return {
      active: true,
      reason: `视频生成任务正在进行中（执行 #${exec.id}，状态：${exec.status}），请勿重复提交。`,
      execId: exec.id,
    };
  }
  const prog = readProgressFile(projectId);
  const shots = Array.isArray(prog.shots) ? prog.shots : [];
  const activeShot = shots.find(s => ['running', 'submitted'].includes(String(s.status || '').toLowerCase()));
  if (activeShot) {
    return {
      active: true,
      reason: `镜头 ${activeShot.shot_id} 正在生成中（${activeShot.status}），请勿重复提交。`,
      execId: null,
    };
  }
  return { active: false, reason: '', execId: null };
}

function findActiveExecutionForProject(projectId, workflowId = REVIEW_SUBMIT_WORKFLOW_ID) {
  if (!projectId) return null;
  const sql = `
    SELECT e.id, e.status, e.mode, e.startedAt, e.stoppedAt
    FROM execution_entity e
    JOIN execution_data d ON d.executionId = e.id
    WHERE e.workflowId = '${String(workflowId).replace(/'/g, "''")}'
      AND e.status IN ('running', 'waiting')
      AND d.data LIKE '%${projectId.replace(/'/g, "''")}%'
    ORDER BY e.id DESC
    LIMIT 1;
  `;
  try {
    const raw = runSqlite(['-json', DB_PATH, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const rows = raw ? JSON.parse(raw) : [];
    return rows[0] || null;
  } catch {
    return null;
  }
}

function findLatestExecutionForProject(projectId, workflowId = REVIEW_SUBMIT_WORKFLOW_ID) {
  if (!projectId) return null;
  const sql = `
    SELECT e.id, e.status, e.mode, e.startedAt, e.stoppedAt
    FROM execution_entity e
    JOIN execution_data d ON d.executionId = e.id
    WHERE e.workflowId = '${String(workflowId).replace(/'/g, "''")}'
      AND d.data LIKE '%${projectId.replace(/'/g, "''")}%'
    ORDER BY e.id DESC
    LIMIT 1;
  `;
  try {
    const raw = runSqlite(['-json', DB_PATH, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const rows = raw ? JSON.parse(raw) : [];
    return rows[0] || null;
  } catch {
    return null;
  }
}

// n8n SQLite stores startedAt/stoppedAt as "YYYY-MM-DD HH:mm:ss.SSS" (no Z, but UTC).
// new Date("2026-05-28 09:30:25") → local-time parse in Asia/Shanghai = +8h off.
// Append Z to force UTC interpretation whenever the value lacks a timezone marker.
function parseN8nDateMs(value) {
  if (!value) return 0;
  const s = String(value).trim();
  if (!s) return 0;
  // Already has T separator or explicit offset/Z — trust as-is
  if (s.includes('T') || s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) {
    const ms = Date.parse(s);
    return isNaN(ms) ? 0 : ms;
  }
  // SQLite space-separated UTC timestamp: "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DD HH:mm:ss.SSS"
  const ms = Date.parse(s.replace(' ', 'T') + 'Z');
  return isNaN(ms) ? 0 : ms;
}

function queryRecentExecutions(limit = 30) {
  try {
    const n = Math.min(Number(limit) || 30, 100);
    const sql = `
      SELECT e.id, e.workflowId, e.status, e.finished, e.startedAt, e.stoppedAt,
             w.name AS workflowName
      FROM execution_entity e
      LEFT JOIN workflow_entity w ON w.id = e.workflowId
      ORDER BY e.id DESC
      LIMIT ${n};
    `;
    const raw = runSqlite(['-json', DB_PATH, sql], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function findLatestWF01Execution(sinceMs = 0) {
  try {
    const sql = `
      SELECT e.id, e.workflowId, e.status, e.startedAt, e.stoppedAt
      FROM execution_entity e
      WHERE e.workflowId = '${WF01_WORKFLOW_ID}'
      ORDER BY e.id DESC
      LIMIT 5;
    `;
    const raw = runSqlite(['-json', DB_PATH, sql], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
    const rows = raw ? JSON.parse(raw) : [];
    if (!sinceMs || !rows.length) return rows[0] || null;
    const ts = Number(sinceMs);
    return rows.find((r) => r.startedAt && parseN8nDateMs(r.startedAt) >= ts) || null;
  } catch { return null; }
}

function classifyWF01Error(errorSummary) {
  const s = String(errorSummary || '').toLowerCase();
  if (/503|service unavailable|维护|maintenance/.test(s))
    return { type: 'maintenance', label: '中转站维护中，请稍后重试', canRetry: true };
  if (/non_json_model_response|unexpected token|not valid json|is not valid json|json parse error|非合法 json|非标准结构/.test(s))
    return { type: 'non_json_response', label: '模型返回了非 JSON 结构（可能拒绝回答或返回说明文字）', canRetry: true };
  if (/50[0-9]|internal server error/.test(s))
    return { type: 'kie_server_error', label: '中转站服务器 5xx 错误（非用户侧问题）', canRetry: true };
  if (/econnreset|socket hang up|connection reset|network socket disconnected/.test(s))
    return { type: 'connection_closed', label: '连接被断开（中转站或网络中断）', canRetry: true };
  if (/econnrefused/.test(s))
    return { type: 'connection_refused', label: '连接被拒绝（检查网络/代理）', canRetry: true };
  if (/timeout|etimedout|timed out|超时/.test(s))
    return { type: 'timeout', label: '请求超时（中转站响应过慢）', canRetry: true };
  if (/401|unauthorized|api key.*invalid|invalid.*api key/.test(s))
    return { type: 'auth_error', label: 'API Key 无效或未配置', canRetry: false };
  if (/403|forbidden|quota|credits|billing/.test(s))
    return { type: 'quota_error', label: '账户余额不足或权限不足', canRetry: false };
  return { type: 'unknown', label: '执行报错（详见诊断包）', canRetry: true };
}

function toExternalErrorType(t) {
  if (t === 'non_json_response') return 'NON_JSON_MODEL_RESPONSE';
  return t || 'unknown';
}

function buildExecutionDetailSummary(exec, redactFn = (s) => s) {
  if (!exec) return null;
  const base = {
    id: exec.id,
    workflowId: exec.workflowId || '?',
    workflowName: exec.workflowName || '?',
    status: exec.status,
    startedAt: exec.startedAt,
    stoppedAt: exec.stoppedAt,
    duration: (exec.startedAt && exec.stoppedAt)
      ? Math.round((parseN8nDateMs(exec.stoppedAt) - parseN8nDateMs(exec.startedAt)) / 1000) + 's'
      : null,
  };
  if (exec.status !== 'error' && exec.status !== 'crashed') return base;
  try {
    const sql = `SELECT data FROM execution_data WHERE executionId = ${Number(exec.id) || 0} LIMIT 1;`;
    const raw = runSqlite([DB_PATH, sql], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
    if (!raw) return base;
    const nodeErrors = [];
    let lastNodeExecuted = null;
    let topErrorMessage = null;
    let projectId = null;
    if (flattedParse) {
      try {
        const parsed = flattedParse(raw);
        lastNodeExecuted = parsed?.resultData?.lastNodeExecuted || null;
        const rootError = parsed?.resultData?.error || {};
        const runData = parsed?.resultData?.runData || {};
        for (const [nodeName, runs] of Object.entries(runData)) {
          const last = Array.isArray(runs) ? runs.at(-1) : null;
          if (last?.error) {
            const msg = redactFn(String(last.error.message || '').slice(0, 300));
            const httpCode = last.error.httpCode || last.error.cause?.response?.status || null;
            nodeErrors.push({ node: nodeName, message: msg, httpCode });
          }
          if (!projectId && last?.data) {
            try {
              const ds = JSON.stringify(last.data).slice(0, 3000);
              const m = ds.match(/"project_id"\s*:\s*"([^"]{4,64})"/);
              if (m) projectId = m[1];
            } catch {}
          }
        }
        const rootMsg = redactFn([rootError.message, rootError.description].filter(Boolean).join('：').slice(0, 300));
        topErrorMessage = nodeErrors[0]?.message || rootMsg || null;
      } catch {}
    }
    if (!topErrorMessage) {
      const m = raw.match(/"message":"([^"]{5,200})"/) || raw.match(/"description":"([^"]{5,200})"/);
      topErrorMessage = m ? redactFn(m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').slice(0, 300)) : null;
    }
    return { ...base, lastNodeExecuted, topErrorMessage, nodeErrors: nodeErrors.slice(0, 5), project_id: projectId };
  } catch { return base; }
}

function readExecutionErrorSummary(executionId) {
  if (!executionId) return '';
  const sql = `
    SELECT data
    FROM execution_data
    WHERE executionId = ${Number(executionId) || 0}
    LIMIT 1;
  `;
  try {
    const raw = runSqlite([DB_PATH, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
    if (!raw) return '';
    if (flattedParse) {
      try {
        const parsed = flattedParse(raw);
        const rootError = parsed?.resultData?.error || {};
        const runData = parsed?.resultData?.runData || {};
        const nodeErrors = [];
        for (const [nodeName, runs] of Object.entries(runData)) {
          const last = Array.isArray(runs) ? runs.at(-1) : null;
          if (last?.error) {
            const msg = String(last.error.message || '').trim();
            const desc = String(last.error.description || '').trim();
            nodeErrors.push([nodeName, msg, desc].filter(Boolean).join('：'));
          }
        }
        const rootMsg = [rootError.message, rootError.description].filter(Boolean).join('：');
        const summary = nodeErrors[0] || rootMsg;
        if (summary && !/^\d+$/.test(String(summary).trim())) {
          return String(summary).replace(/\n/g, ' ').trim();
        }
      } catch {}
    }
    const match =
      raw.match(/"message":"([^"]+)"/) ||
      raw.match(/"description":"([^"]+)"/) ||
      raw.match(/"stack":"([^"]+)"/);
    if (!match?.[1]) return '';
    return match[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

function readExecutionDataSummary(executionId) {
  const out = {
    lastNodeExecuted: null, errorSummary: '', errorType: 'unknown', canRetry: true,
    projectId: null, rawResponseSummary: '',
    rawContentLength: 0, rawContentLooksJson: false, rawContentStartsWithICannot: false,
    rawContentHasCodeFence: false, jsonRepairAttempted: false, jsonRepairSucceeded: false,
    dataTooLarge: false, dataSize: 0, extractionError: null,
  };
  if (!executionId) return out;
  const _sql = `SELECT data FROM execution_data WHERE executionId = ${Number(executionId) || 0} LIMIT 1;`;
  let _raw;
  try {
    _raw = runSqlite([DB_PATH, _sql], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch (e) {
    out.extractionError = String(e.message || e).slice(0, 200);
    return out;
  }
  out.dataSize = _raw.length;
  if (!_raw) return out;
  if (!flattedParse) { out.extractionError = 'flatted unavailable'; return out; }
  let _parsed;
  try { _parsed = flattedParse(_raw); } catch (e) {
    out.extractionError = `flatted: ${String(e.message).slice(0, 100)}`; return out;
  }
  const _rd = _parsed?.resultData || {};
  out.lastNodeExecuted = _rd.lastNodeExecuted || null;
  const _rootErr = _rd.error || {};
  const _runData = _rd.runData || {};
  const _nodeParts = [];
  for (const [_nName, _runs] of Object.entries(_runData)) {
    const _last = Array.isArray(_runs) ? _runs.at(-1) : null;
    if (_last?.error) {
      const _m = String(_last.error.description || _last.error.message || '').trim();
      if (_m) _nodeParts.push(`${_nName}：${_m}`);
    }
    if (!out.projectId && _last?.data) {
      try {
        const _ds = JSON.stringify(_last.data).slice(0, 3000);
        const _pm = _ds.match(/"project_id"\s*:\s*"([^"]{4,64})"/) || _ds.match(/(proj_[A-Za-z0-9_-]{6,})/);
        if (_pm) out.projectId = _pm[1];
      } catch {}
    }
  }
  // Fallback: scan full raw execution_data for proj_ pattern (projectId only, raw not stored)
  if (!out.projectId) {
    try {
      const _fm = _raw.match(/(proj_[A-Za-z0-9_-]{6,})/);
      if (_fm) out.projectId = _fm[1];
    } catch {}
  }
  const _rootMsg = String(_rootErr.description || _rootErr.message || '').trim();
  const _rawSum = (_nodeParts[0] || _rootMsg || '').replace(/\n/g, ' ').slice(0, 300);
  out.rawResponseSummary = _rawSum
    .replace(/Authorization:[^\n\r]+/gi, 'Authorization: [REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/AIzaSy[A-Za-z0-9_-]{30,}/g, '[REDACTED-AIZA]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED-SK]')
    .replace(/Kie[A-Za-z0-9_-]{10,}/g, '[REDACTED-KIE]')
    .replace(/\b[a-f0-9]{32}\b/gi, '[REDACTED-HEX32]');
  out.errorSummary = out.rawResponseSummary;
  const _cls = classifyWF01Error(_rawSum);
  out.errorType = toExternalErrorType(_cls.type);
  out.canRetry = _cls.canRetry;
  for (const [_nName, _runs] of Object.entries(_runData)) {
    if (!(_nName.includes('HTTP Request') || _nName.includes('响应适配'))) continue;
    const _last = Array.isArray(_runs) ? _runs.at(-1) : null;
    const _nodeOut = _last?.data?.main?.[0]?.[0]?.json;
    if (!_nodeOut) continue;
    const _choices = _nodeOut?.choices || _nodeOut?.data?.choices || _nodeOut?._raw_kie_response?.choices;
    if (!_choices?.[0]?.message) continue;
    const _content = _choices[0].message.content;
    const _cs = typeof _content === 'object' ? JSON.stringify(_content) : String(_content ?? '');
    out.rawContentLength = _cs.length;
    out.rawContentLooksJson = (() => { try { JSON.parse(_cs); return true; } catch { return false; } })();
    out.rawContentStartsWithICannot = /^i cannot/i.test(_cs.trimStart());
    out.rawContentHasCodeFence = _cs.includes('```');
    if (!out.rawContentLooksJson) {
      out.jsonRepairAttempted = true;
      const _t = '`', _f = _t + _t + _t;
      const _fm = _cs.match(new RegExp(_f + 'json\\s*([\\s\\S]*?)\\s*' + _f, 'i'));
      if (_fm?.[1]) { try { JSON.parse(_fm[1]); out.jsonRepairSucceeded = true; } catch {} }
      if (!out.jsonRepairSucceeded) {
        const _si = _cs.indexOf('{'), _ei = _cs.lastIndexOf('}');
        if (_si >= 0 && _ei > _si) { try { JSON.parse(_cs.slice(_si, _ei + 1)); out.jsonRepairSucceeded = true; } catch {} }
      }
    }
    break;
  }
  return out;
}

function hydrateProgressFromExecutionError(contextPath, progress, execution) {
  if (!execution || execution.status !== 'error') return progress;
  const currentStatus = String(progress.status || '').trim();
  if (!['submitted', 'running', 'waiting', ''].includes(currentStatus)) {
    return progress;
  }

  const errorText =
    readExecutionErrorSummary(execution.id) || '续跑执行报错，未能进入视频生成完成状态';
  const shots = Array.isArray(progress.shots) ? progress.shots : [];
  if (!shots.length) {
    return {
      ...progress,
      status: 'error',
      running_count: 0,
      failed_count: Number(progress.failed_count || 0) || 1,
      failure_reasons_summary: errorText,
      updated_at: new Date().toISOString(),
    };
  }

  const patchedShots = shots.map((shot) => {
    const rawStatus = String(shot.status || 'pending');
    if (rawStatus === 'running' || rawStatus === 'submitted') {
      return {
        ...shot,
        status: 'failed',
        error: shot.error || errorText,
        completed_at: new Date().toISOString(),
      };
    }
    return shot;
  });

  const next = {
    ...progress,
    shots: patchedShots,
    completed_count: patchedShots.filter((shot) => shot.status === 'completed').length,
    running_count: 0,
    failed_count: patchedShots.filter((shot) => shot.status === 'failed').length,
    status: patchedShots.some((shot) => shot.status === 'completed') ? 'partial_success' : 'error',
    failure_reasons_summary:
      String(progress.failure_reasons_summary || '').trim() ||
      patchedShots
        .filter((shot) => shot.status === 'failed')
        .map((shot) => `${shot.shot_id}: ${shot.error || errorText}`)
        .join(' | '),
    updated_at: new Date().toISOString(),
  };

  const progressPath = progress.progress_path || progressSidecarPath(progress.project_id || '');
  if (progressPath) {
    try {
      fs.writeFileSync(progressPath, JSON.stringify({ ...next, progress_path: undefined }, null, 2));
    } catch {}
  }
  return next;
}

function selectedConceptSidecarPath(projectId) {
  return path.join(
    SELECTED_CONCEPT_ROOT,
    `selected_concept_${String(projectId || '').replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`,
  );
}

function conceptRevisionPath(projectId) {
  return path.join(
    CONCEPT_REVISION_ROOT,
    `concept_revisions_${String(projectId || '').replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`,
  );
}

function readConceptRevisionState(projectId) {
  const filePath = conceptRevisionPath(projectId);
  if (!projectId || !fs.existsSync(filePath)) {
    return {
      project_id: projectId || '',
      revisions: {},
    };
  }
  const data = readContextFile(filePath);
  return {
    project_id: data.project_id || projectId || '',
    revisions: data.revisions && typeof data.revisions === 'object' ? data.revisions : {},
    updated_at: data.updated_at || '',
  };
}

function saveConceptRevisionState(projectId, conceptId, patch) {
  if (!projectId) throw new Error('缺少 project_id');
  const safeConceptId = String(conceptId || '').trim();
  if (!safeConceptId) throw new Error('缺少 concept_id');
  fs.mkdirSync(CONCEPT_REVISION_ROOT, { recursive: true });
  const filePath = conceptRevisionPath(projectId);
  const current = readConceptRevisionState(projectId);
  const revisions = { ...(current.revisions || {}) };
  const currentRevision = revisions[safeConceptId] || {};
  const nextRevision = {
    ...currentRevision,
    ...patch,
    concept_id: safeConceptId,
    project_id: projectId,
    updated_at: new Date().toISOString(),
  };
  revisions[safeConceptId] = nextRevision;
  const next = {
    project_id: projectId,
    revisions,
    updated_at: nextRevision.updated_at,
  };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  return nextRevision;
}

function updateSelectedConceptSidecar(projectId, payload) {
  if (!projectId) throw new Error('缺少 project_id');
  fs.mkdirSync(SELECTED_CONCEPT_ROOT, { recursive: true });
  const filePath = selectedConceptSidecarPath(projectId);
  const next = {
    project_id: projectId,
    ...payload,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  return next;
}

function projectStatePath(projectId) {
  return path.join(
    PROJECT_STATE_ROOT,
    `project_${String(projectId || '').replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`,
  );
}

function projectFeedbackPath(projectId) {
  return path.join(
    PROJECT_FEEDBACK_ROOT,
    `feedback_${String(projectId || '').replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`,
  );
}

function readProjectState(projectId) {
  const filePath = projectStatePath(projectId);
  if (!projectId || !fs.existsSync(filePath)) return {};
  return readContextFile(filePath);
}

// B2: Atomic project state patch helper
function updateProjectState(projectId, patch) {
  if (!projectId) return;
  const filePath = projectStatePath(projectId);
  fs.mkdirSync(PROJECT_STATE_ROOT, { recursive: true });
  const existing = fs.existsSync(filePath) ? readContextFile(filePath) : { project_id: projectId };
  fs.writeFileSync(filePath, JSON.stringify({ ...existing, ...patch, project_id: projectId, updated_at: new Date().toISOString() }, null, 2));
}

const STORYBOARD_FAILURE_USER_MESSAGE = '分镜图生成失败：分镜提示词生成超时或模型返回异常，请稍后重试。如连续失败，请导出诊断包。';

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/Authorization:[^\n\r]+/gi, 'Authorization: [REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/key=[^&\s]+/gi, 'key=[REDACTED]')
    .replace(/AIzaSy[A-Za-z0-9_-]{30,}/g, '[REDACTED-AIZA]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED-SK]')
    .replace(/Kie[A-Za-z0-9_-]{10,}/g, '[REDACTED-KIE]')
    .replace(/\b[a-f0-9]{32}\b/gi, '[REDACTED-HEX32]')
    .slice(0, 800);
}

function markStoryboardGenerationFailed(projectId, execution) {
  if (!projectId || !execution || execution.status !== 'error') return null;
  const summary = readExecutionDataSummary(execution.id);
  const technicalMessage = redactSensitiveText(summary.errorSummary || summary.rawResponseSummary || '');
  const lastNode = redactSensitiveText(summary.lastNodeExecuted || '');
  const timeoutLike = /time(?:d)?\s*out|超时|timeout/i.test(`${technicalMessage} ${lastNode}`);
  const patch = {
    status: 'failed',
    stage: 'storyboard_failed',
    error_type: timeoutLike ? 'storyboard_prompt_timeout' : 'storyboard_generation_failed',
    user_message: STORYBOARD_FAILURE_USER_MESSAGE,
    technical_message: technicalMessage,
    execution_id: String(execution.id || ''),
    workflow_id: STORYBOARD_GENERATE_WORKFLOW_ID,
    last_node_executed: lastNode,
    can_retry: true,
  };
  updateProjectState(projectId, patch);
  return patch;
}

// B2: Derive correct status by reading actual artifacts on disk (cascading)
function deriveProjectStatusFromArtifacts(projectId) {
  if (!projectId) return null;
  const state = readProjectState(projectId);
  const original = String(state.status || '');
  let derived = original;
  // Step 1: if storyboard artifacts exist, advance past script stages
  const rcFile = getLatestReviewContextFileForProject(projectId);
  if (['storyboard_generating', 'script_generated', 'script_generating'].includes(derived) && rcFile) {
    derived = 'storyboard_generated';
  }
  // Step 2+3: read progress once for all post-storyboard checks
  if (['storyboard_generated', 'video_generating', 'video_clips_generated'].includes(derived)) {
    const prog = readProgressFile(projectId);
    // Step 2: advance past storyboard/video_generating if all shots done
    if (['storyboard_generated', 'video_generating'].includes(derived)) {
      const shots = Array.isArray(prog.shots) ? prog.shots : [];
      if (shots.length > 0 && shots.every(s => ['success', 'completed', 'final_generated'].includes(String(s.status || '').toLowerCase()))) {
        derived = 'video_clips_generated';
      }
    }
    // Step 3: advance to final_generated whenever final merged video file exists
    // (covers video_clips_generated persisted from prior run, not only freshly derived)
    if (['storyboard_generated', 'video_generating', 'video_clips_generated'].includes(derived)) {
      const finalPath = String(prog.final_merged_video_path || '');
      if (finalPath) {
        try { if (fs.statSync(finalPath).isFile()) derived = 'final_generated'; } catch {}
      }
    }
  }
  // Step 4: check Movies output dir for exported files
  if (derived === 'final_generated') {
    try {
      const epTok = String(projectId).toLowerCase();
      const checkDir = getConfiguredFinalOutputDir();
      if (checkDir && fs.existsSync(checkDir)) {
        const hasExport = fs.readdirSync(checkDir).some(f => f.toLowerCase().includes(epTok));
        if (hasExport) derived = 'exported';
      }
    } catch {}
  }
  return derived !== original ? derived : null;
}

// P17-REGRESSION-HARDENING: fully artifact-first cascade stage derivation.
// Checks disk independently of current project_state (no origStatus gating).
// Returns { status, stage } at the highest artifact level found, or null if
// no artifacts exist for this project at all.
function deriveProjectStage(projectId) {
  if (!projectId) return null;
  const pid  = String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_');
  const ptok = pid.toLowerCase();

  const hasFileIn = (dir, prefix, ext) => {
    if (!fs.existsSync(dir)) return false;
    try { return fs.readdirSync(dir).some(f => f.startsWith(prefix) && f.endsWith(ext)); }
    catch { return false; }
  };

  // ── Level 1: exported ──────────────────────────────────────────────────────
  try {
    const checkDir = getConfiguredFinalOutputDir();
    if (checkDir && fs.existsSync(checkDir)) {
      if (fs.readdirSync(checkDir).some(f => f.toLowerCase().includes(ptok) && f.endsWith('.mp4'))) {
        return { status: 'exported', stage: 'exported' };
      }
    }
  } catch {}

  // ── Level 2: final_generated ───────────────────────────────────────────────
  if (hasFileIn(path.join(CACHE_ROOT, 'final-video'), `final_${ptok}_`, '.mp4')) {
    return { status: 'final_generated', stage: 'final_generated' };
  }
  const _prog = readProgressFile(projectId);
  const _finalPath = String(_prog.final_merged_video_path || '').trim();
  if (_finalPath) {
    try { if (fs.statSync(_finalPath).isFile()) return { status: 'final_generated', stage: 'final_generated' }; } catch {}
  }

  // ── Level 3: video_clips_generated ────────────────────────────────────────
  const _shots = Array.isArray(_prog.shots) ? _prog.shots : [];
  if (_shots.length > 0 && _shots.every(s => ['success','completed','final_generated'].includes(String(s.status || '').toLowerCase()))) {
    return { status: 'video_clips_generated', stage: 'video_clips_generated' };
  }

  // ── Level 4: storyboard_ready_for_review (review_context exists) ──────────
  if (getLatestReviewContextFileForProject(projectId)) {
    return { status: 'storyboard_generated', stage: 'storyboard_ready_for_review' };
  }

  // ── Level 5: storyboard_generated (images present, review_context pending) ─
  if (hasFileIn(path.join(CACHE_ROOT, 'nanobanana'), `storyboard_${ptok}_`, '.png') ||
      hasFileIn(path.join(CACHE_ROOT, '分镜图裁剪', 'full'), `panel_full_${ptok}_`, '.jpg') ||
      hasFileIn(path.join(CACHE_ROOT, '分镜图裁剪', 'previews'), `panel_preview_${ptok}_`, '.jpg')) {
    return { status: 'storyboard_generated', stage: 'storyboard_generated' };
  }

  // ── Level 6: script_confirmed ─────────────────────────────────────────────
  if (fs.existsSync(path.join(SCRIPT_CONTEXT_ROOT, `confirmed_script_context_${pid}.json`))) {
    return { status: 'script_confirmed', stage: 'script_confirmed' };
  }

  // ── Level 7: script_generated ─────────────────────────────────────────────
  if (fs.existsSync(path.join(SCRIPT_CONTEXT_ROOT, `script_context_${pid}.json`))) {
    return { status: 'script_generated', stage: 'script_generated' };
  }

  // ── Level 7.5: script_failed — concept selected, no script_context, WF02a errored ──
  if (fs.existsSync(selectedConceptSidecarPath(projectId))) {
    const _scriptExec = findLatestExecutionForProject(projectId, CONCEPT_SELECT_WORKFLOW_ID);
    if (_scriptExec && (_scriptExec.status === 'error' || _scriptExec.status === 'crashed')) {
      // H1-fix-A / P12-H1b-A: classify script failure cause to guide safe retry
      const _cls = classifyScriptFailure(_scriptExec);
      const _isScriptPolicyOrParse = _cls.is_safe_retryable;
      const _scriptRetryMsg = _isScriptPolicyOrParse
        ? '脚本框架生成失败：模型内容政策拦截或 JSON 格式异常。系统将在您点击重试时使用更安全的提示词自动重新生成。如连续失败，请检查产品名称和卖点描述是否包含敏感词。'
        : '脚本框架生成失败：文本模型连接中断或请求失败，请稍后重试。如连续失败，请导出诊断包。';
      return {
        status: 'failed', stage: 'script_failed',
        script_failure_type: _cls.script_failure_type,
        is_safe_retryable: _cls.is_safe_retryable,
        user_message: _scriptRetryMsg,
      };
    }
  }

  // ── Level 8: creative_generated ───────────────────────────────────────────
  if (fs.existsSync(CONCEPT_CONTEXT_ROOT)) {
    try {
      if (fs.readdirSync(CONCEPT_CONTEXT_ROOT).some(f => f.startsWith(`concept_context_${pid}`) && f.endsWith('.json'))) {
        return { status: 'creative_generated', stage: 'creative_generated' };
      }
    } catch {}
  }
  if (fs.existsSync(selectedConceptSidecarPath(projectId))) {
    return { status: 'creative_generated', stage: 'creative_generated' };
  }

  return null; // no artifacts found for this project
}

function mergeDerivedProjectStateForUi(projectId, state = {}, options = {}) {
  const pid = String(projectId || state.project_id || '').trim();
  if (!pid) return state || {};
  const derived = deriveProjectStage(pid);
  if (!derived) return state || {};
  const currentStage = String(state.stage || '');
  const explicitErrorStages = new Set(['storyboard_failed', 'script_failed', 'video_failed']);
  if (explicitErrorStages.has(currentStage)) {
    return { ...state, ...(derived.user_message && !state.user_message ? { user_message: derived.user_message } : {}) };
  }
  const next = { ...state };
  if (derived.status) next.status = derived.status;
  if (derived.stage) next.stage = derived.stage;
  if (derived.user_message && !next.user_message) next.user_message = derived.user_message;
  if (options.write) {
    const patch = {};
    if (derived.status && derived.status !== String(state.status || '')) patch.status = derived.status;
    if (derived.stage && derived.stage !== String(state.stage || '')) patch.stage = derived.stage;
    if (derived.user_message && !state.user_message) patch.user_message = derived.user_message;
    if (Object.keys(patch).length > 0) updateProjectState(pid, patch);
  }
  return next;
}

// B3: Path for confirmed script snapshot
function confirmedScriptContextPath(projectId) {
  return path.join(SCRIPT_CONTEXT_ROOT, `confirmed_script_context_${String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`);
}

function scriptContextPath(projectId) {
  return path.join(SCRIPT_CONTEXT_ROOT, `script_context_${String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`);
}

// ═══ P12-H1b-A: scriptGenerateV1 safe automatic second-submission closure ══════
// Allowed auto-retry failure types: content policy / safety block, JSON parse or
// extract failure, invalid JSON schema. Connection errors are NEVER auto-retried.
const SCRIPT_AUTO_RETRY_MAX = 1; // hard cap — no infinite loop

// Shared classifier (also used by deriveProjectStage Level 7.5). Pure.
function classifyScriptFailure(execution) {
  if (!execution || (execution.status !== 'error' && execution.status !== 'crashed')) {
    return { script_failure_type: '', is_safe_retryable: false };
  }
  let isPolicyOrParse = false;
  try {
    const raw = JSON.stringify(execution || {}).toLowerCase();
    isPolicyOrParse = raw.includes('policy') || raw.includes('json') ||
      raw.includes('parse') || raw.includes('safety') ||
      raw.includes('content') || raw.includes('invalid') ||
      raw.includes('schema');
  } catch { isPolicyOrParse = false; }
  return {
    script_failure_type: isPolicyOrParse ? 'policy_or_parse' : 'connection_error',
    is_safe_retryable: isPolicyOrParse,
  };
}

function extractScriptErrorMessage(execution) {
  try {
    return String(
      execution?.data?.executionData?.lastNodeExecuted ||
      execution?.data?.resultData?.error?.message ||
      execution?.error?.message || ''
    );
  } catch { return ''; }
}

function scriptRetryStatePath(projectId) {
  return path.join(SCRIPT_CONTEXT_ROOT, `script_retry_state_${String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`);
}
function readScriptRetryState(projectId) {
  try {
    const p = scriptRetryStatePath(projectId);
    if (fs.existsSync(p)) {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      return {
        attempt_count: Number(s.attempt_count || 0),
        concept_id: String(s.concept_id || ''),
        previous_error: String(s.previous_error || ''),
        previous_failure_type: String(s.previous_failure_type || ''),
        previous_attempt_context: s.previous_attempt_context || null,
      };
    }
  } catch {}
  return { attempt_count: 0, concept_id: '', previous_error: '', previous_failure_type: '', previous_attempt_context: null };
}
function writeScriptRetryState(projectId, state) {
  try {
    fs.mkdirSync(SCRIPT_CONTEXT_ROOT, { recursive: true });
    fs.writeFileSync(scriptRetryStatePath(projectId), JSON.stringify(state, null, 2));
  } catch {}
}
function clearScriptRetryState(projectId) {
  try { const p = scriptRetryStatePath(projectId); if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

// Pure decision function. Performs no model call and no I/O. Never returns success.
// previous_error / previous_failure_type / previous_attempt_context are preserved
// across the single permitted retry.
function planScriptSafeRetry({ execution, retryState = {}, conceptId = '' } = {}) {
  const cls = classifyScriptFailure(execution);
  if (!cls.script_failure_type) {
    return { action: 'none', is_safe_retryable: false };
  }
  if (!cls.is_safe_retryable) {
    // connection_error and any non-safe type → never auto-retry
    return {
      action: 'no_auto_retry',
      is_safe_retryable: false,
      script_failure_type: cls.script_failure_type,
      status: 'failed',
      user_message: '脚本框架生成失败：文本模型连接中断或请求失败。系统不会自动重试连接类错误，请稍后手动点击重试。如连续失败，请导出诊断包。',
    };
  }
  // concept changed since last attempt → fresh retry budget
  const sameConcept = !retryState.concept_id || String(retryState.concept_id) === String(conceptId || '');
  const attempts = sameConcept ? Number(retryState.attempt_count || 0) : 0;
  if (attempts >= SCRIPT_AUTO_RETRY_MAX) {
    return {
      action: 'exhausted',
      is_safe_retryable: true,
      script_failure_type: cls.script_failure_type,
      status: 'failed',
      exhausted: true,
      attempt: attempts,
      previous_error: String(retryState.previous_error || ''),
      previous_failure_type: String(retryState.previous_failure_type || cls.script_failure_type),
      user_message: '脚本框架自动重试已达上限（最多 1 次）。请检查产品名称与卖点描述是否包含敏感词后手动重试，或导出诊断包。',
    };
  }
  return {
    action: 'auto_retry',
    is_safe_retryable: true,
    script_failure_type: cls.script_failure_type,
    status: 'retrying',
    attempt: attempts + 1,
    script_safe_retry: true,
    previous_error: String(retryState.previous_error || extractScriptErrorMessage(execution) || '').slice(0, 2000),
    previous_failure_type: cls.script_failure_type,
    previous_attempt_context: {
      execution_id: execution?.id || '',
      classified_at: new Date().toISOString(),
      prior_attempt_count: attempts,
    },
  };
}

// Safe automatic second-submission closure. Resubmits the SAME selected concept
// exactly once for safe-retryable failures. Does NOT change user form input,
// product images, selected concept, target market/language, or creative_task_type.
// Forward is injectable so non-paid tests never trigger the real model. Never
// fabricates success — on exhaustion or non-safe failure it returns a clear error.
async function maybeAutoRetryScriptGeneration(projectId, opts = {}) {
  const forward = typeof opts.forward === 'function' ? opts.forward : forwardConceptSelection;
  const execution = opts.execution !== undefined
    ? opts.execution
    : findLatestExecutionForProject(projectId, CONCEPT_SELECT_WORKFLOW_ID);
  let sidecar = {};
  try {
    const p = selectedConceptSidecarPath(projectId);
    if (fs.existsSync(p)) sidecar = readContextFile(p);
  } catch {}
  const conceptId = String(sidecar.selected_concept_id || '');
  const retryState = readScriptRetryState(projectId);
  const plan = planScriptSafeRetry({ execution, retryState, conceptId });

  if (plan.action === 'none') {
    if (retryState.attempt_count) clearScriptRetryState(projectId);
    return { retried: false, ...plan };
  }
  if (plan.action === 'no_auto_retry' || plan.action === 'exhausted') {
    // surface failure; DO NOT write success, DO NOT forward
    return { retried: false, ...plan };
  }
  // plan.action === 'auto_retry' — rebuild payload from EXISTING selected concept only
  const payload = {
    project_id: projectId,
    selected_concept_id: conceptId,
    concept_context_path: String(sidecar.concept_context_path || ''),
    ...(sidecar.selected_concept_json ? { selected_concept_json: sidecar.selected_concept_json } : {}),
    // additive safe-retry augmentation (not contract fields)
    script_safe_retry: true,
    previous_error: plan.previous_error,
    previous_failure_type: plan.previous_failure_type,
    previous_attempt_context: plan.previous_attempt_context,
  };
  writeScriptRetryState(projectId, {
    attempt_count: plan.attempt,
    concept_id: conceptId,
    previous_error: plan.previous_error,
    previous_failure_type: plan.previous_failure_type,
    previous_attempt_context: plan.previous_attempt_context,
    last_retry_at: new Date().toISOString(),
  });
  await forward(payload);
  return { retried: true, attempt: plan.attempt, status: 'retrying', script_safe_retry: true };
}

function reconcileScriptContextStateForUi(projectId, state, hasScriptContext) {
  if (!projectId || !hasScriptContext) return state || {};
  const currentStage = String(state?.stage || state?.status || '').trim().toLowerCase();
  const scriptPendingStages = new Set([
    '',
    'form_submitted',
    'creative_generating',
    'creative_generated',
    'waiting_for_concept_selection',
    'concept_selected',
    'script_generating',
    'script_failed',
    'failed',
  ]);
  if (!scriptPendingStages.has(currentStage)) return state || {};
  updateProjectState(projectId, { stage: 'script_generated', status: 'script_generated' });
  return { ...(state || {}), stage: 'script_generated', status: 'script_generated' };
}

function reconcileStoryboardContextStateForUi(projectId, state, hasReviewContext) {
  if (!projectId || !hasReviewContext) return state || {};
  const currentStage = String(state?.stage || state?.status || '').trim().toLowerCase();
  const storyboardPendingStages = new Set([
    '',
    'script_generated',
    'script_confirmed',
    'storyboard_generating',
    'storyboard_generated',
  ]);
  if (!storyboardPendingStages.has(currentStage)) return state || {};
  updateProjectState(projectId, { stage: 'storyboard_ready_for_review', status: 'storyboard_ready_for_review' });
  return { ...(state || {}), stage: 'storyboard_ready_for_review', status: 'storyboard_ready_for_review' };
}

// B3: Merge base script_context + saved overrides + current form shots into confirmed snapshot
function buildConfirmedScriptContext(projectId, formShots) {
  const pid = String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_');
  const scriptFile = scriptContextPath(pid);
  let base = {};
  if (fs.existsSync(scriptFile)) {
    try { base = JSON.parse(fs.readFileSync(scriptFile, 'utf8')); } catch (_) {}
  }
  const overridesFile = path.join(SCRIPT_CONTEXT_ROOT, `script_user_overrides_${pid}.json`);
  let savedOverrides = {};
  if (fs.existsSync(overridesFile)) {
    try { savedOverrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8')); } catch (_) {}
  }
  const overrideMap = {};
  if (Array.isArray(savedOverrides.shots)) {
    for (const ov of savedOverrides.shots) { if (ov.shot_id) overrideMap[ov.shot_id] = ov; }
  }
  const formMap = {};
  if (Array.isArray(formShots)) {
    for (const s of formShots) { if (s.shot_id) formMap[s.shot_id] = s; }
  }
  const baseShots = Array.isArray(base.shots) ? base.shots : [];
  const mergedShots = baseShots.map(shot => {
    const ov = overrideMap[shot.shot_id] || {};
    const fm = formMap[shot.shot_id] || {};
    return { ...shot, ...ov, ...fm, shot_id: shot.shot_id };
  });
  return { ...base, shots: mergedShots, confirmed_at: new Date().toISOString(), confirmed_from: 'script_review', _confirmed: true };
}

// Reusable export helper — copies project artifacts to configured output dirs.
// Returns { ok, copied, skipped, errors, output_dirs }.
// Idempotent: same-size files are skipped, never overwritten.
function exportProjectArtifacts(projectId) {
  if (!projectId || !/^[a-zA-Z0-9_\-]{4,80}$/.test(String(projectId))) {
    return { ok: false, copied: [], skipped: [], errors: [{ file: '', error: 'project_id 无效或缺失' }], output_dirs: {} };
  }
  const _cfg = loadConfig();
  const _outCfg = _cfg.output || {};
  const _sbDir  = String(_outCfg.storyboard_dir || _cfg.storyboard_output_dir || '').trim();
  const _vidDir = String(_outCfg.video_dir      || _cfg.video_output_dir      || '').trim();
  const _finDir = String(_outCfg.final_dir      || '').trim();
  const _dirSpec = { storyboard: _sbDir, video: _vidDir, final: _finDir };
  const _dirErrs = [];
  const _resDirs = {};
  for (const [_dk, _dv] of Object.entries(_dirSpec)) {
    if (!_dv) {
      if (_dk !== 'final') _dirErrs.push(`output.${_dk}_dir 未配置`);
      continue;
    }
    const _dSafe = isOutputPathSafe(_dv);
    if (!_dSafe.ok) { _dirErrs.push(`output.${_dk}_dir 不安全：${_dSafe.reason}`); continue; }
    const _dNorm = _dSafe.normalized;
    try { fs.mkdirSync(_dNorm, { recursive: true }); } catch {}
    const _dSt = (() => { try { return fs.statSync(_dNorm); } catch { return null; } })();
    if (!_dSt || !_dSt.isDirectory()) { _dirErrs.push(`output.${_dk}_dir 目录不存在且无法创建：${_dNorm}`); continue; }
    try { const _wt = path.join(_dNorm, '.write_test_' + Date.now()); fs.writeFileSync(_wt, ''); fs.unlinkSync(_wt); }
    catch { _dirErrs.push(`output.${_dk}_dir 目录不可写：${_dNorm}`); continue; }
    _resDirs[_dk] = _dNorm;
  }
  if (_dirErrs.length > 0) {
    return { ok: false, copied: [], skipped: [], errors: _dirErrs.map(e => ({ file: '', error: e })), output_dirs: _resDirs };
  }
  const _tok = String(projectId).toLowerCase();
  // F-fix: build canonical file sets from review-progress (not glob)
  const _progExport = readProgressFile(projectId);
  const _canonicalVideoNames = new Set(
    (Array.isArray(_progExport.shots) ? _progExport.shots : [])
      .map(s => path.basename(String(s.video_path || '')))
      .filter(Boolean),
  );
  const _canonicalFinalName = path.basename(String(_progExport.final_merged_video_path || ''));
  const _hasCanonicalProgress = _canonicalVideoNames.size > 0 || _canonicalFinalName;
  const _candidates = [
    { srcDir: path.join(CACHE_ROOT, 'nanobanana'),              prefix: `storyboard_${_tok}_`,    ext: '.png', destKey: 'storyboard' },
    { srcDir: path.join(CACHE_ROOT, '分镜图裁剪', 'full'),       prefix: `panel_full_${_tok}_`,    ext: '.jpg', destKey: 'storyboard' },
    { srcDir: path.join(CACHE_ROOT, '分镜图裁剪', 'previews'),   prefix: `panel_preview_${_tok}_`, ext: '.jpg', destKey: 'storyboard' },
    { srcDir: path.join(CACHE_ROOT, 'videos'), prefix: `kie_veo31_${_tok}_`,    ext: '.mp4', destKey: 'video' },
    { srcDir: path.join(CACHE_ROOT, 'videos'), prefix: `kie_${_tok}_`,          ext: '.mp4', destKey: 'video' },
    { srcDir: path.join(CACHE_ROOT, 'videos'), prefix: `veo_${_tok}_`,          ext: '.mp4', destKey: 'video' },
    { srcDir: path.join(CACHE_ROOT, 'videos'), prefix: `wavespeed_${_tok}_`,    ext: '.mp4', destKey: 'video' },
    { srcDir: path.join(CACHE_ROOT, 'videos'), prefix: `modelhub_${_tok}_`,     ext: '.mp4', destKey: 'video' },
    { srcDir: path.join(CACHE_ROOT, 'videos'), prefix: `tk888_media_${_tok}_`,  ext: '.mp4', destKey: 'video' },
    { srcDir: path.join(CACHE_ROOT, 'final-video'),              prefix: `final_${_tok}_`,         ext: '.mp4', destKey: 'final'  },
  ];
  const _copied = [], _skipped = [], _errors = [];
  for (const { srcDir, prefix, ext, destKey } of _candidates) {
    if (!_resDirs[destKey] || !fs.existsSync(srcDir)) continue;
    let _names; try { _names = fs.readdirSync(srcDir); } catch { continue; }
    for (const fname of _names) {
      const fLow = fname.toLowerCase();
      if (!fLow.startsWith(prefix) || !fLow.endsWith(ext)) continue;
      // F-fix: skip non-canonical video/final files when canonical progress is available
      if (_hasCanonicalProgress && destKey === 'video' && !_canonicalVideoNames.has(fname)) continue;
      if (_hasCanonicalProgress && destKey === 'final' && (!_canonicalFinalName || fname !== _canonicalFinalName)) continue;
      const srcPath = path.join(srcDir, fname);
      const srcSt = (() => { try { return fs.statSync(srcPath); } catch { return null; } })();
      if (!srcSt || !srcSt.isFile()) continue;
      const destPath = path.join(_resDirs[destKey], fname);
      const destSt = (() => { try { return fs.statSync(destPath); } catch { return null; } })();
      if (destSt) {
        if (destSt.size === srcSt.size) {
          _skipped.push({ file: fname, dest: destPath, reason: '已存在且大小相同，跳过' });
        } else {
          _skipped.push({ file: fname, dest: destPath, reason: `已存在但大小不同（cache=${srcSt.size}B 本地=${destSt.size}B），未覆盖` });
        }
        continue;
      }
      try { fs.copyFileSync(srcPath, destPath); _copied.push({ file: fname, dest: destPath, size: srcSt.size }); }
      catch (e) { _errors.push({ file: fname, error: '复制文件失败：' + String(e.message || e).slice(0, 200) }); }
    }
  }
  return { ok: _errors.length === 0, copied: _copied, skipped: _skipped, errors: _errors, output_dirs: _resDirs };
}

function resolveFinalOutputDisplay(projectId, finalMergedVideoPath, isFreshFile, projectState = {}) {
  const outputFinalDir = getConfiguredFinalOutputDir();
  const tok = String(projectId || '').toLowerCase();
  const fresh = typeof isFreshFile === 'function' ? isFreshFile : (p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  };
  const internalFinals = [];
  const addInternal = (filePath) => {
    const p = String(filePath || '').trim();
    if (!p) return;
    try {
      if (fs.statSync(p).isFile() && fresh(p) && !internalFinals.includes(p)) internalFinals.push(p);
    } catch {}
  };
  addInternal(finalMergedVideoPath);
  try {
    const cacheFinalDir = path.join(CACHE_ROOT, 'final-video');
    if (fs.existsSync(cacheFinalDir)) {
      for (const name of fs.readdirSync(cacheFinalDir)) {
        const low = name.toLowerCase();
        if (low.startsWith(`final_${tok}_`) && low.endsWith('.mp4')) addInternal(path.join(cacheFinalDir, name));
      }
    }
  } catch {}
  internalFinals.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });

  const userFinals = [];
  if (outputFinalDir) {
    const expectedNames = new Set(internalFinals.map((p) => path.basename(p).toLowerCase()));
    try {
      if (fs.existsSync(outputFinalDir)) {
        for (const name of fs.readdirSync(outputFinalDir)) {
          const low = name.toLowerCase();
          if (!low.endsWith('.mp4')) continue;
          const matchesProject = low.startsWith(`final_${tok}_`) || expectedNames.has(low);
          if (!matchesProject) continue;
          const full = path.join(outputFinalDir, name);
          try {
            if (fs.statSync(full).isFile() && fresh(full)) userFinals.push(full);
          } catch {}
        }
      }
    } catch {}
  }
  userFinals.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });

  const exportSummary = projectState.export_summary || projectState.auto_export_summary || {};
  const exportedAt = String(exportSummary.exported_at || projectState.auto_exported_at || '').trim();
  return {
    outputFinalDir,
    userFinals,
    internalFinals,
    hasInternalFinal: internalFinals.length > 0,
    hasUserFinal: userFinals.length > 0,
    needsExport: internalFinals.length > 0 && userFinals.length === 0,
    exportedAt,
  };
}

function appendProjectFeedback(projectId, payload) {
  if (!projectId) throw new Error('缺少 project_id');
  fs.mkdirSync(PROJECT_FEEDBACK_ROOT, { recursive: true });
  const filePath = projectFeedbackPath(projectId);
  const current = fs.existsSync(filePath) ? readContextFile(filePath) : { project_id: projectId, feedback: [] };
  const feedback = Array.isArray(current.feedback) ? current.feedback : [];
  feedback.unshift({
    ...payload,
    created_at: new Date().toISOString(),
  });
  fs.writeFileSync(filePath, JSON.stringify({ project_id: projectId, feedback: feedback.slice(0, 50) }, null, 2));
}

function readProjectFeedback(projectId) {
  const filePath = projectFeedbackPath(projectId);
  if (!projectId || !fs.existsSync(filePath)) return [];
  const data = readContextFile(filePath);
  return Array.isArray(data.feedback) ? data.feedback : [];
}

function projectNotesPath(projectId) {
  return path.join(
    PROJECT_NOTES_ROOT,
    `project_notes_${String(projectId || '').replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`,
  );
}

function readProjectNotes(projectId) {
  const filePath = projectNotesPath(projectId);
  if (!projectId || !fs.existsSync(filePath)) return {};
  return readContextFile(filePath);
}

function saveProjectNotes(projectId, notes) {
  if (!projectId) throw new Error('缺少 project_id');
  fs.mkdirSync(PROJECT_NOTES_ROOT, { recursive: true });
  const filePath = projectNotesPath(projectId);
  const next = {
    project_id: projectId,
    notes: String(notes || '').trim(),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
  return next;
}

function syncProjectHistory(limit = 3) {
  try {
    const items = fs
      .readdirSync(PROJECT_STATE_ROOT)
      .filter((name) => name.startsWith('project_') && name.endsWith('.json'))
      .map((name) => path.join(PROJECT_STATE_ROOT, name))
      .filter((fullPath) => fs.statSync(fullPath).isFile())
      .map((fullPath) => {
        const rawState = readContextFile(fullPath);
        const stat = fs.statSync(fullPath);
        const projectId = String(rawState.project_id || path.basename(fullPath)).trim();
        const state = mergeDerivedProjectStateForUi(projectId, rawState);
        return {
          projectId,
          productName: state.product_name || '',
          targetMarket: state.target_market || '',
          targetLanguage: state.target_language || '',
          creativeTaskType: state.creative_task_type || '',
          status: state.stage || state.status || '',
          updatedAt: state.updated_at || state.created_at || stat.mtime.toISOString(),
          mtimeMs: stat.mtimeMs,
          openUrl: `/active?project_id=${encodeURIComponent(projectId)}`,
          conceptUrl: getLatestConceptContextFileForProject(projectId)
            ? `/concepts/item?context=${encodeURIComponent(getLatestConceptContextFileForProject(projectId))}`
            : '',
          reviewUrl: getLatestReviewContextFileForProject(projectId)
            ? `/review-status?context=${encodeURIComponent(getLatestReviewContextFileForProject(projectId))}`
            : '',
        };
      })
      .filter((item) => item.projectId)
      .filter((item) => hoursAgo(item.mtimeMs))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const seen = new Set();
    const filtered = items.filter((item) => {
      if (seen.has(item.projectId)) return false;
      seen.add(item.projectId);
      return true;
    }).slice(0, limit);

    const payload = {
      updated_at: new Date().toISOString(),
      ttl_hours: REVIEW_MAX_AGE_HOURS,
      limit,
      items: filtered.map(({ mtimeMs, ...rest }) => rest),
    };
    fs.writeFileSync(PROJECT_HISTORY_PATH, JSON.stringify(payload, null, 2));
    return payload.items;
  } catch {
    try {
      if (fs.existsSync(PROJECT_HISTORY_PATH)) {
        const cached = readContextFile(PROJECT_HISTORY_PATH);
        return Array.isArray(cached.items) ? cached.items.slice(0, limit) : [];
      }
    } catch {}
    return [];
  }
}

function readProjectHistory(limit = 3) {
  return syncProjectHistory(limit);
}

function readCreativeTaskTypeMapping() {
  const promptCenter = loadPromptCenter();
  if (promptCenter && typeof promptCenter === 'object' && promptCenter.creative_task_type_mapping) {
    return promptCenter.creative_task_type_mapping;
  }
  const mappingPath = path.join(BUNDLED_CONFIG_DIR, 'creative_task_type_mapping.json');
  try {
    if (fs.existsSync(mappingPath)) {
      return JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    }
  } catch {}
  return {
    '种草': {
      video_type: 'local_voiceover',
      style: 'local TikTok creator product recommendation',
      script_focus: ['hook', 'ugc', 'user insight', 'product benefit', 'trust building', 'soft conversion'],
      voiceover_required: true,
      recommended_grid: '6_grid',
    },
    '口播': {
      video_type: 'local_voiceover',
      style: 'direct-to-camera product introduction',
      script_focus: ['hook', 'pain point', 'product intro', 'benefit proof', 'call to action'],
      voiceover_required: true,
      recommended_grid: '6_grid',
    },
    '开箱': {
      video_type: 'pure_display_or_light_voiceover',
      style: 'real unboxing showcase',
      script_focus: ['package', 'opening action', 'first impression', 'product reveal', 'detail display'],
      voiceover_required: false,
      recommended_grid: '6_grid',
    },
    '产品展示': {
      video_type: 'mixed',
      style: 'product benefit demonstration',
      script_focus: ['core selling points', 'usage demo', 'detail proof', 'result scene'],
      voiceover_required: false,
      recommended_grid: '6_grid',
    },
    '痛点前置': {
      video_type: 'local_voiceover',
      style: 'pain-point-led conversion story',
      script_focus: ['pain point hook', 'problem agitation', 'solution reveal', 'product proof', 'conversion'],
      voiceover_required: true,
      recommended_grid: '6_grid',
    },
    '故事剧情带货': {
      video_type: 'story_drama',
      style: 'TikTok UGC short drama — real-life micro-awkward moments, small misunderstandings, subtle contrast; one simple action per shot; natural product placement; no theatrical exaggeration',
      script_focus: ['真实生活小尴尬/小误会 Hook', '微压力/微困扰持续', '产品自然进入剧情', '关键使用过程', '日常问题轻松解决', '自然轻 CTA'],
      voiceover_required: true,
      recommended_grid: '6_grid',
    },
    '真实故事剧情': {
      video_type: 'story_drama',
      style: 'TikTok UGC short drama — real-life micro-awkward moments, small misunderstandings, subtle contrast; one simple action per shot; natural product placement; no theatrical exaggeration',
      script_focus: ['真实生活小尴尬/小误会 Hook', '微压力/微困扰持续', '产品自然进入剧情', '关键使用过程', '日常问题轻松解决', '自然轻 CTA'],
      voiceover_required: true,
      recommended_grid: '6_grid',
    },
    '爆点故事剧情': {
      video_type: 'story_drama',
      style: 'TikTok UGC short drama — high-impact social embarrassment, extreme emotion close-ups, strong dramatic reversal; one simple action per shot; product as key plot device; UGC authenticity preserved',
      script_focus: ['极致冲突/尴尬社死 Hook', '情绪爆点但单动作', '产品自然进入剧情', '戏剧性转折', '情绪释放爽点', '自然轻 CTA'],
      voiceover_required: true,
      recommended_grid: '6_grid',
    },
    '自由创作': {
      video_type: 'mixed',
      style: 'model-selected best-fit strategy',
      script_focus: ['product analysis', 'best-fit type', 'hook', 'ugc', 'conversion'],
      voiceover_required: 'optional',
      recommended_grid: '6_grid',
    },
  };
}

function getTextModelConfig() {
  const cfg = loadConfig();
  const adapters = cfg.adapters || {};
  const kie = cfg.kie || {};
  const gemini = cfg.gemini || {};
  const apis = cfg.apis || {};
  const textAdapter = adapters.text || 'kie_openai_chat';

  if (textAdapter === 'kie_openai_chat') {
    const key = (kie.api_key || '').trim();
    if (!key) throw new Error('缺少 Kie API Key。请在「系统配置」页填写 Kie API Key。');
    const model = KIE_CONSTANTS.text_model;
    const kieOrigin = KIE_CONSTANTS.base_url.replace(/\/api\/?$/, '').replace(/\/$/, '');
    const url = `${kieOrigin}/${model}/v1/chat/completions`;
    return { adapter: 'kie_openai_chat', url, key, model, authHeader: `Bearer ${key}` };
  }

  // gemini_native fallback
  let key = (apis.creative_direction?.api_key || gemini.api_key || '').trim();
  if (!key) {
    try { key = fs.readFileSync(path.join(os.homedir(), '.n8n', 'gemini-api-key'), 'utf8').trim(); } catch {}
  }
  if (!key) key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('缺少 Kie API Key。请在「系统配置」页填写 Kie API Key。');
  const model = (apis.creative_direction?.model || gemini.text_model || KIE_CONSTANTS.text_model).trim();
  const base = (apis.creative_direction?.base_url || gemini.base_url || '').trim();
  const envUrl = (process.env.GEMINI_TEXT_MODEL_URL || '').trim();
  const url = envUrl || (base
    ? `${base.replace(/\/$/, '')}/v1beta/models/${model}:generateContent?key=${key}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`);
  return { adapter: 'gemini_native', url, key, model, authHeader: '' };
}

function optionHtml(value, label, current) {
  return `<option value="${htmlEscape(value)}"${String(current || '') === value ? ' selected' : ''}>${htmlEscape(label)}</option>`;
}

function extractJsonText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '{}';
  const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/```\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const objStart = raw.indexOf('{');
  const objEnd = raw.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) return raw.slice(objStart, objEnd + 1).trim();
  const arrStart = raw.indexOf('[');
  const arrEnd = raw.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) return raw.slice(arrStart, arrEnd + 1).trim();
  return raw;
}

function normalizeDirectorConcepts(result, context, typeRules) {
  const concepts = Array.isArray(result.creative_concepts) ? result.creative_concepts : [];
  return concepts.slice(0, 3).map((concept, index) => ({
    concept_id: concept.concept_id || `concept_${String(index + 1).padStart(2, '0')}`,
    concept_name: concept.concept_name || concept.direction_name || concept.direction || `创意方向 ${index + 1}`,
    creative_form: concept.creative_form || concept.video_type || '',
    video_type: concept.video_type || typeRules.video_type || '',
    core_selling_angle: concept.core_selling_angle || concept.visual_hook || concept.hook_visual || concept.selling_point_focus || concept.voiceover_focus || '',
    target_user: concept.target_user || concept.audience_focus || concept.character_status || concept.persona_and_scene || '',
    pain_point: concept.pain_point || '',
    usage_scene: concept.usage_scene || concept.scene_atmosphere || concept.scene_vibe || concept.character_and_scene || concept.persona_and_scene || '',
    visual_expression: concept.visual_expression || concept.camera_performance || concept.camera_movement || concept.wearing_and_mood || '',
    hook_strategy: concept.hook_strategy || concept.visual_hook || concept.hook_visual || '',
    why_it_fits_tiktok: concept.why_it_fits_tiktok || concept.scene_atmosphere || concept.scene_vibe || concept.voiceover_focus || '',
    recommended_grid: concept.recommended_grid || context.recommended_grid || typeRules.recommended_grid || '6_grid',
    risk_notes: concept.risk_notes || '',
    score: concept.score || {},
    original_direction_name: concept.direction_name || concept.direction || '',
    original_payload: concept,
  }));
}

function mergeConceptWithRevision(concept, revision = {}) {
  const fields = revision && typeof revision === 'object' ? revision.fields || {} : {};
  return {
    ...concept,
    target_user: fields.target_user ?? concept.target_user ?? '',
    usage_scene: fields.usage_scene ?? concept.usage_scene ?? '',
    visual_expression: fields.visual_expression ?? concept.visual_expression ?? '',
    hook_strategy: fields.hook_strategy ?? concept.hook_strategy ?? '',
    video_type: fields.video_type ?? concept.video_type ?? '',
    core_selling_angle: fields.core_selling_angle ?? concept.core_selling_angle ?? '',
    why_it_fits_tiktok: fields.why_it_fits_tiktok ?? concept.why_it_fits_tiktok ?? '',
    recommended_grid: fields.recommended_grid ?? concept.recommended_grid ?? '',
    risk_notes: fields.risk_notes ?? concept.risk_notes ?? '',
    model_profile: fields.model_profile ?? concept.model_profile ?? '',
  };
}

function conceptEditFieldValue(concept, revision, key) {
  const fields = revision && typeof revision === 'object' ? revision.fields || {} : {};
  // If the field was explicitly saved (even as empty ""), use it; don't fall back to model value.
  if (key in fields) return String(fields[key] ?? '');
  if (concept[key] != null && String(concept[key]).trim() !== '') return String(concept[key]);
  return '';
}

function rerunDirectorConcepts(contextPath, freeFormRequirement = '') {
  const context = readContextFile(contextPath);
  const projectId = String(context.project_id || '').trim();
  if (!projectId) throw new Error('当前创意方向上下文缺少 project_id，无法重跑。');

  const promptCenter = loadPromptCenter();
  const director = promptCenter.director || {};
  const mapping = readCreativeTaskTypeMapping();
  const creativeTaskType = String(context.creative_task_type || '').trim();
  const typeRules = mapping[creativeTaskType] || {};
  // 只向导演层暴露方向级字段，剔除 script_structure/shots 等脚本级字段
  const DIRECTOR_ALLOWED_KEYS = ['video_type', 'style', 'script_focus', 'visual_focus', 'avoid', 'recommended_grid', 'name', 'description', 'voiceover_required'];
  const sanitizedTypeRules = Object.fromEntries(Object.entries(typeRules).filter(([k]) => DIRECTOR_ALLOWED_KEYS.includes(k)));
  const projectNotes = readProjectNotes(projectId);
  const conceptRevisions = readConceptRevisionState(projectId);

  // Collect images — 1 to 5, at least 1 required for real model request
  const imagePaths = [
    context.image_1_path,
    context.image_2_path,
    ...(Array.isArray(context.product_image_local_paths) ? context.product_image_local_paths : []),
  ].filter(Boolean);
  const uniqueImagePaths = [...new Set(imagePaths)].filter(p => fs.existsSync(p)).slice(0, 5);
  if (uniqueImagePaths.length === 0) {
    throw new Error('当前项目没有记录产品图片，请重新上传至少一张产品图后再重新生成创意方向。');
  }

  const renderedUserPrompt = renderTemplate(director.user_template || '', {
    product_name: context.product_name || '',
    product_desc: context.product_desc || context.product_selling_points || '',
    target_market: context.target_market || '',
    target_language: context.target_language || '',
    creative_task_type: creativeTaskType,
    reference_case_url: context.reference_case_url || '',
  });

  const voiceoverBlock =
    creativeTaskType === '种草' || creativeTaskType === '口播'
      ? [
          '',
          '【口播强制规则】',
          '- 本次必须是口播类型，每个创意方向都要像本地 TikTok 创作者在真实分享，必须包含口播表达角度。',
          '- creative_concepts[*].video_type 必须倾向 local_voiceover。',
          '- 创意方向要服务后续口播脚本：Hook、真实体验、产品好处、信任建立、软转化。',
        ].join('\n')
      : '';

  const isRealStoryDrama = creativeTaskType === '真实故事剧情' || creativeTaskType === '故事剧情带货';
  const isHighHookStoryDrama = creativeTaskType === '爆点故事剧情';
  const dramaBlock = isRealStoryDrama
    ? [
        '',
        '【真实故事剧情强制规则 — TikTok UGC 微剧情，不是品牌广告】',
        '- 这是更真实、更低 AI 感的剧情化带货。每个创意方向必须像真实生活里的小尴尬、小误会、小痛点或微反差，保持 UGC 手持感。',
        '- 【前0-3秒 Drama Hook — 硬约束】画面第一秒必须有具体可见的小冲突或小困扰，不能温和开场，但也不要夸张表演：',
        '  · 类型（不要照抄）：找不到东西、包里太乱、开合卡住、物品掉落、小摩擦、小尴尬、出门前临时发现问题。',
        '  · 小冲突必须和产品核心卖点强相关，不能为剧情乱编无关场景。',
        '  · 前3秒内不得出现产品实物；产品在 shot_3 以自然解决问题的道具方式登场。',
        '- 每个镜头只有一个主体动作，动作简单、真实、低穿模风险。',
        '- 禁止夸张颜艺、影视剧表演、大幅肢体动作、多人混乱互动、奔跑、摔倒、哭喊。',
        '- 【前后对比拆镜规则】before/after 必须拆成不同 shot 顺序表达；绝不能在同一个 shot 里写左右分屏/拼接图。',
        '- creative_concepts[*].video_type 必须是 story_drama。',
        '- 口播/台词风格：自然本地口语，像真实用户轻分享，不要硬广腔。',
        '- 不要写死产品名、国家、模特；产品描述由 product_name/product_desc 传入。',
        '- 不得在 creative_concepts 里输出 script_structure、shots、shot_1/shot_2 等脚本字段。',
      ].join('\n')
    : isHighHookStoryDrama
      ? [
          '',
          '【爆点故事剧情强制规则 — 强 Hook 测试，但保持工程稳定】',
          '- 这是高冲击剧情带货，用于测试点击率/停留率。每个创意方向可以有更强的社死瞬间、情绪爆点、强反差和反转，但必须保持 TikTok UGC 真实感。',
          '- 【前0-3秒 Drama Hook — 硬约束】画面第一秒必须有强冲突/强反差/尴尬社死瞬间，绝不能温和开场或平铺直叙。',
          '  · 类型（不要照抄）：公开尴尬、被误会、当众失败、身份反差、突然发现问题。',
          '  · 冲突必须和产品核心卖点强相关，不能为戏剧化乱编与产品无关的场景。',
          '  · 前3秒内不得出现产品实物；产品在 shot_3 以剧情转折道具方式自然登场。',
          '- 可使用极致表情和情绪爆点，但每个镜头只有一个主体动作，动作必须简单清晰。',
          '- 工程护栏：禁止复杂多人互动、奔跑、摔倒、哭喊失控、连续多个动作、快速切换和夸张肢体调度。',
          '- 【前后对比拆镜规则】before/after 必须拆成不同 shot 顺序表达；绝不能在同一个 shot 里写左右分屏/拼接图。',
          '- creative_concepts[*].video_type 必须是 story_drama。',
          '- 口播/台词风格：自然口语，带情绪，但不要品牌广告腔。',
          '- 不要写死产品名、国家、模特；产品描述由 product_name/product_desc 传入。',
          '- 不得在 creative_concepts 里输出 script_structure、shots、shot_1/shot_2 等脚本字段。',
        ].join('\n')
      : '';

  // Build structured user variable constraints from all revised concepts
  const allRevisionFields = {};
  for (const revision of Object.values(conceptRevisions.revisions || {})) {
    const fields = revision.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      if (v && String(v).trim()) allRevisionFields[k] = String(v).trim();
    }
  }
  const varLines = [
    allRevisionFields.target_user ? `- 目标用户：${allRevisionFields.target_user}` : '',
    allRevisionFields.model_profile ? `- 人物/模特设定：${allRevisionFields.model_profile}` : '',
    allRevisionFields.usage_scene ? `- 使用场景：${allRevisionFields.usage_scene}` : '',
    allRevisionFields.visual_expression ? `- 内容风格：${allRevisionFields.visual_expression}` : '',
    allRevisionFields.hook_strategy ? `- 视觉 Hook：${allRevisionFields.hook_strategy}` : '',
    allRevisionFields.core_selling_angle ? `- 核心卖点切入：${allRevisionFields.core_selling_angle}` : '',
    allRevisionFields.video_type ? `- 视频类型：${allRevisionFields.video_type}` : '',
  ].filter(Boolean);
  const varConstraintBlock = varLines.length
    ? '\n【用户变量约束（必须体现在新创意方向中）】\n' + varLines.join('\n')
    : '';

  // P18: voice_localization rules injection
  const _vlCenter = loadPromptCenter();
  const _vlRules = _vlCenter?.voice_localization || {};
  const _vlVeoConstraints = _vlCenter?.veo_quality_constraints?.hard_prohibitions || [];
  const _targetMarket = String(context.target_market || '').trim();
  const _targetLang = String(context.target_language || '').trim();
  const _vlMarketRule = _vlRules[_targetMarket] || _vlRules['default'] || {};
  const voiceLocalizationBlock = (_targetMarket || _targetLang)
    ? [
        '',
        '【P18 口播本地化规则 — Voice Localization】',
        `- 目标市场：${_targetMarket || '未指定'}；目标语言：${_targetLang || '未指定'}`,
        `- 口播/台词语气：${_vlMarketRule.tone || '自然、本地 TikTok 创作者真实分享感'}`,
        _vlMarketRule.opening_patterns ? `- 推荐开场模式：${_vlMarketRule.opening_patterns.join('、')}` : '',
        `- 必须避免：${(_vlMarketRule.avoid || _vlRules['default']?.avoid || []).join('、')}`,
        '- 用户已手动修改的 optional_voiceover_local / expression_focus / tone 字段拥有最高优先级，不覆盖。',
        '- 未手动修改的口播字段必须按上述语气规则自动调整，使口播像真实本地创作者分享。',
        _vlVeoConstraints.length ? `- 视频生成硬约束（Veo/image-to-video）：${_vlVeoConstraints.join('；')}` : '',
      ].filter(Boolean).join('\n')
    : '';

  const feedbackBlock = [
    '',
    projectNotes?.notes ? '【项目微调说明】\n' + projectNotes.notes + '\n' : '',
    varConstraintBlock,
    freeFormRequirement ? '\n【自由创作要求】\n' + freeFormRequirement : '',
    '',
    '【Form 业务硬约束】',
    '- creative_task_type 是最高优先级，必须严格使用：' + creativeTaskType,
    '- creative_task_type_rules：' + JSON.stringify(sanitizedTypeRules || {}, null, 2),
    '- target_market 必须严格使用：' + (_targetMarket || ''),
    '- target_language 必须严格使用：' + (_targetLang || ''),
    '- 这是重跑当前"创意方向"阶段，只重新输出导演层创意方向，不要输出脚本、分镜、图片提示词或视频提示词。',
    voiceoverBlock,
    dramaBlock,
    voiceLocalizationBlock,
  ].join('\n');

  const requestBody = {
    system_instruction: {
      parts: [{ text: director.system_instruction || '' }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: renderedUserPrompt + feedbackBlock },
          ...uniqueImagePaths.map((imagePath) => ({
            inline_data: {
              mime_type: MIME[path.extname(imagePath).toLowerCase()] || 'image/jpeg',
              data: fs.readFileSync(imagePath).toString('base64'),
            },
          })),
        ],
      },
    ],
    generationConfig: director.generation_config || { temperature: 0.8, responseMimeType: 'application/json' },
  };

  const textConfig = getTextModelConfig();
  // Convert Gemini-format request body to OpenAI format when using kie_openai_chat
  let callBody;
  if (textConfig.adapter === 'kie_openai_chat') {
    const sysText = (requestBody.system_instruction?.parts || []).map(p => p.text || '').join('\n').trim();
    const msgs = [];
    if (sysText) msgs.push({ role: 'system', content: sysText });
    const userParts = [];
    for (const block of (requestBody.contents || [])) {
      for (const part of (block.parts || [])) {
        if (part.text) userParts.push({ type: 'text', text: part.text });
        if (part.inline_data) {
          userParts.push({ type: 'image_url', image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` } });
        }
      }
    }
    const userContent = (userParts.length === 1 && userParts[0].type === 'text') ? userParts[0].text : userParts;
    msgs.push({ role: 'user', content: userContent });
    const genCfg = requestBody.generationConfig || {};
    callBody = { model: textConfig.model, messages: msgs };
    if (genCfg.temperature != null) callBody.temperature = genCfg.temperature;
    if (genCfg.maxOutputTokens) callBody.max_tokens = genCfg.maxOutputTokens;
    // Kie returns code=500 for generic response_format=json_object; prompts enforce JSON instead.
  } else {
    callBody = requestBody;
  }

  const requestDir = path.join(CACHE_ROOT, 'text-model-requests');
  const responseDir = path.join(CACHE_ROOT, 'text-model-responses');
  fs.mkdirSync(requestDir, { recursive: true });
  fs.mkdirSync(responseDir, { recursive: true });
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const requestHash = `director_rerun_${safeProjectId}_${Date.now()}`;
  const requestPath = path.join(requestDir, `${requestHash}.json`);
  const responsePath = path.join(responseDir, `${requestHash}.json`);
  fs.writeFileSync(requestPath, JSON.stringify(callBody, null, 2), 'utf8');

  let stdout;
  if (textConfig.adapter === 'kie_openai_chat') {
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';
    const curlArgs = [
      '-sS', '--fail-with-body', '--connect-timeout', '60', '-m', '900',
      ...(proxy ? ['-x', proxy] : []),
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: ${textConfig.authHeader}`,
      '--data-binary', `@${requestPath}`,
      textConfig.url,
    ];
    const rawStdout = execFileSync('/usr/bin/curl', curlArgs, { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, timeout: 920000 });
    // Normalize OpenAI response → Gemini-compatible format for downstream parsers
    const oai = JSON.parse(rawStdout || '{}');
    const oaiContent = oai?.choices?.[0]?.message?.content ?? '';
    const oaiText = typeof oaiContent === 'object' ? JSON.stringify(oaiContent) : String(oaiContent);
    stdout = JSON.stringify({ candidates: [{ content: { parts: [{ text: oaiText }] } }] });
  } else {
    stdout = execFileSync(process.execPath, [path.join(PROJECT_ROOT, 'gemini-generate.mjs'), textConfig.url, requestPath], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      maxBuffer: 40 * 1024 * 1024,
      timeout: 920000,
    });
  }
  fs.writeFileSync(responsePath, stdout, 'utf8');

  const responseJson = JSON.parse(stdout || '{}');
  const rawText = responseJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const parsed = JSON.parse(extractJsonText(rawText));
  const result = Array.isArray(parsed) ? parsed[0] || {} : parsed || {};
  const creativeConcepts = normalizeDirectorConcepts(result, context, typeRules);
  if (!creativeConcepts.length) {
    throw new Error('AI 模型重跑后没有返回 creative_concepts。');
  }

  const nextContext = {
    ...context,
    creative_task_type_rules_json: JSON.stringify(typeRules || {}),
    product_understanding_json: JSON.stringify(result.product_understanding || {}),
    audience_persona_json: JSON.stringify(result.audience_persona || {}),
    tiktok_content_strategy_json: JSON.stringify(result.tiktok_content_strategy || {}),
    creative_concepts_json: JSON.stringify(creativeConcepts),
    creative_concepts: creativeConcepts,
    concept_count: creativeConcepts.length,
    recommended_grid: creativeConcepts[0]?.recommended_grid || typeRules.recommended_grid || context.recommended_grid || '6_grid',
    status: 'waiting_for_concept_selection',
    director_status: 'concept_rerun_generated',
    latest_director_feedback: freeFormRequirement,
    latest_director_request_path: requestPath,
    latest_director_response_path: responsePath,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(contextPath, JSON.stringify(nextContext, null, 2), 'utf8');

  const statePath = projectStatePath(projectId);
  if (fs.existsSync(statePath)) {
    const state = readContextFile(statePath);
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          ...state,
          status: 'waiting_for_concept_selection',
          director_status: 'concept_rerun_generated',
          latest_director_feedback: freeFormRequirement,
          updated_at: nextContext.updated_at,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  // Concept regen produces new options → downstream script/storyboard/video/final are stale.
  markDownstreamStale(projectId, 'concept_regenerated', 'all');

  return nextContext;
}

function listRecentProjectStates(limit = 8) {
  return readProjectHistory(limit);
}

// ── Environment status & control ──────────────────────────────────────────────

async function collectEnvStatus() {
  const cfg = normalizeAiConfig(loadConfig());
  const n8nHost = getConfiguredN8nHost();

  // 1. UI service (self — always ok)
  const ui = { ok: true, port: PORT };

  // 2. n8n health
  let n8n = { ok: false, host: n8nHost, error: '' };
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${n8nHost}/healthz`, { signal: controller.signal });
    clearTimeout(tid);
    n8n.ok = resp.status < 500;
    if (!n8n.ok) n8n.error = `HTTP ${resp.status}`;
  } catch (e) {
    n8n.error = String(e.message || e).slice(0, 120);
  }

  // 3. Workflow version check via DB
  const WF_SPECS = [
    { id: 'rKHHjD2QBlL6EhaM',         label: 'WF01' },
    { id: 'conceptSelectStoryboardV1', label: 'WF02' },
    { id: 'scriptGenerateV1',          label: 'WF02a' },
    { id: 'storyboardGenerateV1',      label: 'WF02b' },
    { id: 'reviewSubmitVeoV2',         label: 'WF03' },
  ];
  const wfDetails = [];
  let wfAllFound = true;
  let wfHasStaleUrl = false;
  for (const { id, label } of WF_SPECS) {
    try {
      const eid = id.replace(/'/g, "''");
      const raw = runSqlite(['-json', DB_PATH,
        `SELECT id, name, active, nodes FROM workflow_entity WHERE id='${eid}' LIMIT 1;`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
      const rows = raw ? JSON.parse(raw) : [];
      if (rows[0]) {
        const wf = rows[0];
        const nodesStr = typeof wf.nodes === 'string' ? wf.nodes : JSON.stringify(wf.nodes || []);
        const stale = nodesStr.includes('127.0.0.1:8788') || nodesStr.includes('localhost:8788');
        if (stale) wfHasStaleUrl = true;
        wfDetails.push({ id, label, name: wf.name, active: !!Number(wf.active), found: true, hasStaleUrl: stale });
      } else {
        wfDetails.push({ id, label, found: false });
        wfAllFound = false;
      }
    } catch {
      wfDetails.push({ id, label, found: false, error: 'DB error' });
      wfAllFound = false;
    }
  }

  // 4. API key + config path
  const kieKey = (cfg.kie?.api_key || '').trim();
  const apiKey = { ok: kieKey.length > 0, masked: kieKey ? `${kieKey.slice(0, 4)}****` : '' };

  // Config single-source check: only in source dev mode
  const configInfo = { uiConfigPath: CONFIG_PATH };
  try {
    if (APP_MODE !== 'dist') {
      configInfo.keysDiffer = false;
      // Which config path will n8n Code nodes actually resolve (mirrors readKieKey priority)?
      const n8nCandidates = [
        process.env.AI_VIDEO_CONFIG_PATH,
        process.env.TIKTOK_WORKFLOW_ROOT ? path.join(process.env.TIKTOK_WORKFLOW_ROOT, '版本测试', 'config', 'local-config.json') : null,
        CONFIG_PATH,
      ].filter(Boolean);
      configInfo.n8nConfigPath = n8nCandidates.find(p => fs.existsSync(p)) || CONFIG_PATH;
    } else {
      // dist mode: no source dev comparison; App Support config is the only config
      configInfo.keysDiffer = false;
      const n8nCandidates = [process.env.AI_VIDEO_CONFIG_PATH, CONFIG_PATH].filter(Boolean);
      configInfo.n8nConfigPath = n8nCandidates.find(p => fs.existsSync(p)) || CONFIG_PATH;
    }
  } catch {}

  // Model info (derived from normalized config)
  const _tasks = cfg.tasks || {};
  const _presets = cfg.modelPresets || MODEL_PRESETS || {};
  const _imgModel = _tasks.storyboard_image?.model || KIE_CONSTANTS.image_model;
  const _imgPreset = (_presets.image || []).find(p => p.id === _imgModel) || {};
  configInfo.modelText = _tasks.creative_direction?.model || KIE_CONSTANTS.text_model;
  configInfo.modelImage = _imgModel;
  configInfo.modelImageLabel = _imgPreset.label || _imgModel;
  configInfo.modelImageResolution = _imgPreset.resolution || '';
  configInfo.modelVideo = _tasks.image_to_video?.model || KIE_CONSTANTS.video_model;

  // 5. Storage paths
  const storage = {
    ok: fs.existsSync(DB_PATH),
    workflowDataRoot: WORKFLOW_DATA_ROOT,
    cache: CACHE_ROOT,
    db: DB_PATH,
    dbExists: fs.existsSync(DB_PATH),
    videoOutput: VIDEO_OUTPUT_ROOT,
  };

  // 6. Active project (most-recently-modified project state file)
  // B2: auto-repair stale status by reading actual artifacts
  let activeProject = null;
  try {
    const data = getLatestProjectState(0);
    if (data.project_id) {
      // P17-REGRESSION-HARDENING: artifact-first full cascade; also patches stage
      const _fullyDerived = deriveProjectStage(data.project_id);
      let derivedStatus = _fullyDerived?.status || deriveProjectStatusFromArtifacts(data.project_id);
      const _envPatch = {};
      if (derivedStatus && derivedStatus !== String(data.status || '')) _envPatch.status = derivedStatus;
      if (_fullyDerived?.stage && _fullyDerived.stage !== String(data.stage || '')) _envPatch.stage = _fullyDerived.stage;
      if (_fullyDerived?.user_message && !data.user_message) _envPatch.user_message = _fullyDerived.user_message;
      if (Object.keys(_envPatch).length > 0) updateProjectState(data.project_id, _envPatch);
      let _activeState = Object.keys(_envPatch).length > 0 ? readProjectState(data.project_id) : data;
      // P17-C2: auto-export when final/video clips are ready. Failed or empty attempts do not set auto_exported_at.
      const _effectiveStatus = derivedStatus || String(data.status || '');
      const _shouldAutoExport = (
        (_effectiveStatus === 'final_generated' || _effectiveStatus === 'video_clips_generated') &&
        !data.auto_exported_at
      );
      if (_shouldAutoExport) {
        try {
          const _autoEx = exportProjectArtifacts(data.project_id);
          const _handledCount = _autoEx.copied.length + _autoEx.skipped.length;
          const _autoSummary = {
            status: _effectiveStatus,
            exported_at: _autoEx.errors.length === 0 && _handledCount > 0 ? new Date().toISOString() : '',
            copied: _autoEx.copied,
            skipped: _autoEx.skipped,
            errors: _autoEx.errors,
            copied_count: _autoEx.copied.length,
            skipped_count: _autoEx.skipped.length,
            error_count: _autoEx.errors.length,
            output_dirs: _autoEx.output_dirs,
          };
          const _autoExPatch = {
            auto_export_copied: _autoEx.copied.length,
            auto_export_skipped: _autoEx.skipped.length,
            auto_export_errors: _autoEx.errors.length,
            auto_export_summary: _autoSummary,
            export_summary: _autoSummary,
          };
          if (_autoEx.errors.length === 0 && _handledCount > 0) {
            _autoExPatch.auto_exported_at = _autoSummary.exported_at;
            if (_effectiveStatus === 'final_generated') {
              _autoExPatch.status = 'exported';
              derivedStatus = 'exported';
            }
          } else {
            _autoExPatch.auto_export_last_error_at = new Date().toISOString();
            data.auto_export_errors = _autoEx.errors.length;
          }
          updateProjectState(data.project_id, _autoExPatch);
          _activeState = readProjectState(data.project_id);
        } catch {}
      }
      activeProject = {
        project_id: String(data.project_id),
        status: derivedStatus || String(_activeState.status || ''),
        stage: String(_fullyDerived?.stage || _activeState.stage || ''),
        updated_at: String(_activeState.updated_at || data.updated_at || ''),
        auto_export_errors: _activeState.auto_export_errors || Number(_activeState.auto_export_errors || 0),
      };
    }
  } catch {}

  // 7. Output path status
  const _outCfg = cfg.output || {};
  const outputStatus = {};
  const _outputKeys = [
    ['output.base_dir',       _outCfg.base_dir       || ''],
    ['output.storyboard_dir', _outCfg.storyboard_dir || cfg.storyboard_output_dir || ''],
    ['output.video_dir',      _outCfg.video_dir      || cfg.video_output_dir      || ''],
    ['output.voiceover_dir',  _outCfg.voiceover_dir  || ''],
    ['output.final_dir',      _outCfg.final_dir      || ''],
  ];
  for (const [key, val] of _outputKeys) {
    outputStatus[key] = checkOutputPathStatus(val);
  }
  const _outputOk = ['output.storyboard_dir', 'output.video_dir'].every(
    k => outputStatus[k]?.configured && outputStatus[k]?.exists && outputStatus[k]?.writable
  );

  return {
    ui,
    n8n,
    workflows: { ok: wfAllFound && !wfHasStaleUrl, allFound: wfAllFound, hasStaleUrl: wfHasStaleUrl, details: wfDetails },
    apiKey,
    configInfo,
    storage,
    activeProject,
    output: { ok: _outputOk, paths: outputStatus },
    timestamp: new Date().toISOString(),
  };
}

function renderSystemPage(status) {
  const { ui, n8n, workflows, apiKey, configInfo, storage, activeProject } = status;

  function badge(ok) {
    return ok
      ? '<span style="background:#16a34a22;color:#4ade80;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;">正常</span>'
      : '<span style="background:#dc262622;color:#f87171;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;">异常</span>';
  }
  function card(icon, title, ok, detail, actionHtml) {
    return `<div class="card" style="margin-bottom:12px;">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
    <span style="font-size:18px;">${icon}</span>
    <strong style="font-size:14px;color:#e2e8f0;">${title}</strong>
    <span style="flex:1;"></span>${badge(ok)}
  </div>
  <div style="font-size:12px;color:#94a3b8;line-height:1.8;">${detail}</div>
  ${actionHtml ? `<div class="btn-row" style="margin-top:10px;">${actionHtml}</div>` : ''}
</div>`;
  }

  const wfRows = workflows.details.map(w => {
    const icon = !w.found ? '❌' : w.hasStaleUrl ? '⚠️' : '✅';
    const activeTip = w.found && w.active ? ' <span style="color:#4ade80;font-size:10px;">[active]</span>' : '';
    const staleTip  = w.hasStaleUrl ? ' <span style="color:#fbbf24;font-size:10px;">[含旧URL]</span>' : '';
    return `<div>${icon} <b>${htmlEscape(w.label)}</b> ${w.found ? htmlEscape(w.name || w.id) : '未找到'}${activeTip}${staleTip}</div>`;
  }).join('');

  const syncBtn  = `<button class="btn btn-primary" onclick="envAction('sync-workflows',this)" style="font-size:12px;padding:6px 14px;">重新同步工作流</button>`;
  const killBtn  = `<button class="btn btn-secondary" onclick="envAction('kill-stale-n8n',this)" style="font-size:12px;padding:6px 14px;">清除 n8n 僵尸进程</button>`;
  const clearBtn = `<button class="btn btn-secondary" onclick="envAction('clear-test-data',this)" style="font-size:12px;padding:6px 14px;">清空项目缓存</button>`;
  const cfgBtn   = `<a class="btn btn-secondary" href="/config" style="font-size:12px;padding:6px 14px;">前往系统配置</a>`;
  const testBtn  = `<button class="btn btn-primary" onclick="envAction('runtime-check',this)" style="font-size:12px;padding:6px 14px;">检测运行环境</button>`;
  const diagBtn  = `<button class="btn btn-secondary" onclick="exportDiag(this)" style="font-size:12px;padding:6px 14px;">导出诊断包</button>`;

  const wfDetail = wfRows +
    (workflows.hasStaleUrl ? '<div style="color:#fbbf24;margin-top:4px;">⚠ 工作流含旧端口 URL，建议立即同步</div>' : '') +
    (!workflows.allFound   ? '<div style="color:#f87171;margin-top:4px;">部分工作流未找到，请先同步</div>' : '');

  const n8nDetail = n8n.ok
    ? `已连接：${htmlEscape(n8n.host)}`
    : `无法连接 ${htmlEscape(n8n.host)}${n8n.error ? '：' + htmlEscape(n8n.error) : ''}`;

  const storageDetail = [
    `运行模式：<strong>${htmlEscape(APP_MODE)}</strong> &nbsp;|&nbsp; 端口：<strong>${PORT}</strong> &nbsp;|&nbsp; PID：<strong>${SERVER_PID}</strong>`,
    `启动时间：<code>${htmlEscape(SERVER_STARTED_AT)}</code>`,
    `UI 脚本根：<code>${htmlEscape(PROJECT_ROOT)}</code>`,
    `工作流数据根：<code>${htmlEscape(storage.workflowDataRoot)}</code>`,
    `配置路径：<code>${htmlEscape(CONFIG_PATH)}</code>`,
    `缓存目录：<code>${htmlEscape(storage.cache)}</code>`,
    `数据库：<code>${htmlEscape(storage.db)}</code> ${storage.dbExists ? '✅' : '❌ 不存在'}`,
    `视频输出：<code>${htmlEscape(storage.videoOutput)}</code>`,
  ].join('<br>');

  const projectDetail = activeProject
    ? `项目 <strong>${htmlEscape(activeProject.project_id)}</strong> · 状态：${htmlEscape(activeProject.status)} · 更新：${htmlEscape((activeProject.updated_at || '').slice(0, 16).replace('T', ' '))}`
    : '暂无活跃项目记录';

  // Config info card content
  const ci = configInfo || {};
  const cfgLines = [
    `客户端配置：<code>${htmlEscape(ci.uiConfigPath || CONFIG_PATH)}</code>`,
    `当前 Key：${apiKey.ok ? htmlEscape(apiKey.masked) : '<span style="color:#f87171;">未配置</span>'}`,
  ];
  if (ci.sourceConfigPath) {
    cfgLines.push(`开发配置：<code>${htmlEscape(ci.sourceConfigPath)}</code>`);
    cfgLines.push(`Source Key：${ci.sourceKeyMasked ? htmlEscape(ci.sourceKeyMasked) : '(空)'} ${ci.keysDiffer ? '<span style="color:#f87171;">❌ 与客户端 Key 不一致 — 请在「系统配置」重新保存 Key 以同步</span>' : '✅ 一致'}`);
  }
  if (ci.n8nConfigPath) {
    cfgLines.push(`n8n 读配置路径：<code>${htmlEscape(ci.n8nConfigPath)}</code>`);
  }
  const cfgDetail = cfgLines.join('<br>');
  const cfgOk = apiKey.ok && !ci.keysDiffer;

  const modelDetail = [
    `文本模型：<strong>${htmlEscape(ci.modelText || '-')}</strong>`,
    `图片模型：<strong>${htmlEscape(ci.modelImageLabel || ci.modelImage || '-')}</strong>${ci.modelImageResolution ? ` &nbsp;·&nbsp; 分辨率 <strong>${htmlEscape(ci.modelImageResolution)}</strong>` : ''}`,
    `视频模型：<strong>${htmlEscape(ci.modelVideo || '-')}</strong>`,
    `Provider：<strong>Kie</strong>`,
  ].join('<br>');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>运行环境｜AI Video</title>
  ${commonCSS()}
  <style>
    code{background:rgba(255,255,255,.07);border-radius:4px;padding:0 4px;font-size:11px;}
    #action-result{margin-top:12px;padding:8px 14px;border-radius:8px;font-size:13px;display:none;}
    #action-result.ok{background:#16a34a22;color:#4ade80;display:block;}
    #action-result.err{background:#dc262622;color:#f87171;display:block;}
  </style>
</head>
<body>
${renderStageNav('')}
<main style="max-width:800px;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin:28px 0 20px;">
    <h2 style="margin:0;font-size:18px;color:#e2e8f0;">运行环境状态</h2>
    <a href="/system" style="color:#60a5fa;font-size:12px;text-decoration:none;">刷新</a>
  </div>
  <div id="action-result"></div>
  ${card('🌐', '工作台服务 (本进程)', ui.ok, `端口 ${ui.port} 正在运行`, '')}
  ${card('⚙️', 'n8n 工作流引擎', n8n.ok, n8nDetail, killBtn)}
  ${card('📋', '工作流版本', workflows.ok, wfDetail, syncBtn)}
  ${card('🔑', '配置文件 & API Key', cfgOk, cfgDetail, cfgBtn + testBtn)}
  ${card('🤖', '当前生效模型', true, modelDetail, '')}
  ${card('💾', '数据存储', storage.ok, storageDetail, '')}
  ${card('📂', '活跃项目', true, projectDetail, clearBtn)}
  <div class="card" style="margin-bottom:12px;">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <span style="font-size:18px;">🛠️</span>
      <strong style="font-size:14px;color:#e2e8f0;">维护工具</strong>
    </div>
    <div style="font-size:12px;color:#94a3b8;line-height:1.8;margin-bottom:10px;">
      <b>导出诊断包</b>：自动收集系统状态，脱敏后输出到 logs/diagnostics/ 目录，可发给客服。<br>
      <b>恢复出厂设置</b>：清空本 App 配置中的 API Key 和所有项目缓存，需两次确认，<b style="color:#f87171;">无法撤销</b>。
    </div>
    <div class="btn-row">
      ${diagBtn}
      <button class="btn btn-danger" onclick="doFactoryReset(this)" style="font-size:12px;padding:6px 14px;">恢复出厂设置</button>
    </div>
    <div id="diag-result" style="margin-top:10px;font-size:12px;color:#4ade80;display:none;word-break:break-all;"></div>
  </div>
  <p style="font-size:11px;color:#475569;margin-top:16px;">最后检查：${htmlEscape(status.timestamp.replace('T', ' ').slice(0, 19))} UTC</p>
</main>
<script>
async function envAction(action, btn) {
  const resultEl = document.getElementById('action-result');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '执行中…';
  resultEl.className = '';
  resultEl.textContent = '';
  try {
    const r = await fetch('/api/env-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const d = await r.json();
    if (r.ok && d.ok) {
      resultEl.className = 'ok';
      resultEl.textContent = d.message || '操作成功';
    } else {
      resultEl.className = 'err';
      resultEl.textContent = d.error || ('操作失败 HTTP ' + r.status);
    }
  } catch (e) {
    resultEl.className = 'err';
    resultEl.textContent = '网络错误：' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
    setTimeout(() => location.reload(), 2500);
  }
}
async function doFactoryReset(btn) {
  if (!confirm('⚠️ 恢复出厂设置将清空 API Key 和所有项目缓存，无法撤销！')) return;
  if (!confirm('再次确认：清空 API Key、缓存和日志？')) return;
  await envAction('factory-reset', btn);
}
async function exportDiag(btn) {
  const diagEl = document.getElementById('diag-result');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '生成中…';
  diagEl.style.display = 'none';
  try {
    const r = await fetch('/api/export-diagnostics');
    const d = await r.json();
    if (r.ok && d.ok) {
      diagEl.style.display = 'block';
      diagEl.style.color = '#4ade80';
      diagEl.textContent = '✅ 诊断包已保存：' + d.path;
    } else {
      diagEl.style.display = 'block';
      diagEl.style.color = '#f87171';
      diagEl.textContent = '❌ ' + (d.error || '生成失败');
    }
  } catch (e) {
    diagEl.style.display = 'block';
    diagEl.style.color = '#f87171';
    diagEl.textContent = '网络错误：' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}
</script>
</body>
</html>`;
}

function getLatestProjectState(minMtimeMs = 0) {
  try {
    const files = fs
      .readdirSync(PROJECT_STATE_ROOT)
      .filter((name) => name.startsWith('project_') && name.endsWith('.json'))
      .map((name) => path.join(PROJECT_STATE_ROOT, name))
      .filter((fullPath) => fs.statSync(fullPath).isFile())
      .filter((fullPath) => fs.statSync(fullPath).mtimeMs >= Number(minMtimeMs || 0))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (!files.length) return {};
    return readContextFile(files[0]);
  } catch {
    return {};
  }
}

function getLatestConceptContextFileForProject(projectId) {
  if (!projectId || !fs.existsSync(CONCEPT_CONTEXT_ROOT)) return '';
  const files = fs
    .readdirSync(CONCEPT_CONTEXT_ROOT)
    .filter((name) => name.startsWith(`concept_context_${projectId}`) && name.endsWith('.json'))
    .sort();
  return files.at(-1) || '';
}

function getLatestReviewContextFileForProject(projectId) {
  if (!projectId || !fs.existsSync(REVIEW_CONTEXT_ROOT)) return '';
  const files = fs
    .readdirSync(REVIEW_CONTEXT_ROOT)
    .filter(
      (name) =>
        name.startsWith(`review_context_${projectId}`) &&
        name.endsWith('.json') &&
        !name.includes('.stale') &&
        !name.endsWith('.submitted.json'),
    )
    .sort();
  return files.at(-1) || '';
}

function markDownstreamStale(projectId, reason = '', scope = 'all') {
  const pid = String(projectId || '').replace(/[^a-zA-Z0-9_-]+/g, '_');
  if (!pid) return;
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const staleDir = path.join(CACHE_ROOT, 'stale', pid);
  fs.mkdirSync(staleDir, { recursive: true });

  const moveMatching = (dir, predicate) => {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      if (!predicate(file)) continue;
      const from = path.join(dir, file);
      if (!fs.statSync(from).isFile()) continue;
      const to = path.join(staleDir, `${now}__${file}`);
      try { fs.renameSync(from, to); } catch {}
    }
  };

  const shouldStaleStoryboards = scope === 'all' || scope === 'storyboard';
  const shouldStaleVideoProgress = scope === 'all' || scope === 'storyboard';
  const shouldStaleFinal = scope === 'all' || scope === 'storyboard' || scope === 'final';
  const shouldStaleScript = scope === 'all';

  if (shouldStaleStoryboards) {
    moveMatching(REVIEW_CONTEXT_ROOT, (file) =>
      file.startsWith(`review_context_${pid}_`) &&
      file.endsWith('.json') &&
      !file.includes('.stale') &&
      !file.endsWith('.submitted.json'));
  }
  if (shouldStaleVideoProgress) {
    moveMatching(REVIEW_PROGRESS_ROOT, (file) =>
      file.startsWith(`review_progress_${pid}`) && file.endsWith('.json'));
  }
  if (shouldStaleFinal) {
    moveMatching(path.join(CACHE_ROOT, 'final-video'), (file) =>
      file.toLowerCase().startsWith(`final_${pid.toLowerCase()}_`) && file.toLowerCase().endsWith('.mp4'));
  }
  if (shouldStaleScript) {
    moveMatching(SCRIPT_CONTEXT_ROOT, (file) =>
      (file.startsWith(`script_context_${pid}`) ||
       file.startsWith(`script_user_overrides_${pid}`) ||
       file.startsWith(`confirmed_script_context_${pid}`)) &&
      file.endsWith('.json'));
  }

  const statePath = path.join(PROJECT_STATE_ROOT, `project_${pid}.json`);
  const state = fs.existsSync(statePath) ? readContextFile(statePath) : { project_id: projectId };
  const iso = new Date().toISOString();
  if (shouldStaleStoryboards) state.storyboard_invalidated_at = iso;
  if (shouldStaleVideoProgress || shouldStaleStoryboards) state.video_invalidated_at = iso;
  if (shouldStaleFinal) state.final_invalidated_at = iso;
  if (shouldStaleScript) state.script_invalidated_at = iso;
  state.downstream_invalidated_reason = reason;
  if (scope === 'storyboard') {
    state.status = 'storyboard_generating';
    state.stage = 'storyboard_generating';
  } else if (scope === 'final') {
    state.status = 'video_generating';
    state.stage = 'video_generating';
  } else {
    state.status = 'script_generating';
    state.stage = 'script_generating';
  }
  state.updated_at = iso;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function getFinalRouteForProject(projectId, reviewFile = '') {
  const activeProjectId = String(projectId || '').trim();
  if (!activeProjectId) return '/';
  const finalReviewFile = reviewFile || getLatestReviewContextFileForProject(activeProjectId);
  if (finalReviewFile) return `/final-video?context=${encodeURIComponent(finalReviewFile)}`;
  return `/active?project_id=${encodeURIComponent(activeProjectId)}&stage=final`;
}

function getActiveRoute(projectId = '', minMtimeMs = 0) {
  const rawState = projectId ? readProjectState(projectId) : getLatestProjectState(minMtimeMs);
  const activeProjectId = String(rawState.project_id || projectId || '').trim();
  if (!activeProjectId) return '/';
  const latestState = mergeDerivedProjectStateForUi(activeProjectId, rawState);

  const conceptFile = getLatestConceptContextFileForProject(activeProjectId);
  const reviewFile = getLatestReviewContextFileForProject(activeProjectId);
  const reviewFilePath = reviewFile ? path.join(REVIEW_CONTEXT_ROOT, reviewFile) : '';
  const reviewSubmitted = reviewFilePath ? fs.existsSync(submittedSidecarPath(reviewFilePath)) : false;
  const artifactStage = (() => { try { return deriveProjectStage(activeProjectId); } catch { return null; } })();
  const artifactStageName = String(artifactStage?.stage || artifactStage?.status || '').toLowerCase();
  if (artifactStageName === 'exported' || artifactStageName === 'final_generated') {
    return getFinalRouteForProject(activeProjectId, reviewFile);
  }

  // B2 / P17-REGRESSION-HARDENING: explicit stage routing covers all derived stages
  const _stageLower = String(latestState.stage || '').toLowerCase();

  // All storyboard stages: check reviewFile first, then fall to storyboard-status
  if (['storyboard_generating','storyboard_generated','storyboard_ready_for_review'].includes(_stageLower)) {
    if (reviewFile && !reviewSubmitted) return `/reviews/item?context=${encodeURIComponent(reviewFile)}`;
    if (reviewFile && reviewSubmitted) return `/review-status?context=${encodeURIComponent(reviewFile)}`;
    return `/storyboard-status?project_id=${encodeURIComponent(activeProjectId)}`;
  }

  // script_confirmed → storyboard pending generation
  if (_stageLower === 'script_confirmed') {
    if (reviewFile && !reviewSubmitted) return `/reviews/item?context=${encodeURIComponent(reviewFile)}`;
    return `/storyboard-status?project_id=${encodeURIComponent(activeProjectId)}`;
  }

  if (_stageLower === 'script_generated' || String(latestState.stage || latestState.status || '').includes('script')) {
    return `/script-review?project_id=${encodeURIComponent(activeProjectId)}`;
  }

  if (reviewFile && !reviewSubmitted) {
    return `/reviews/item?context=${encodeURIComponent(reviewFile)}`;
  }

  if (reviewFile && reviewSubmitted) {
    return `/review-status?context=${encodeURIComponent(reviewFile)}`;
  }

  const hasSelectedConcept = fs.existsSync(selectedConceptSidecarPath(activeProjectId));
  if (conceptFile && !hasSelectedConcept && ['waiting_for_concept_selection', 'creative_generated'].includes(String(latestState.status || '').trim())) {
    return `/concepts/item?context=${encodeURIComponent(conceptFile)}`;
  }

  if (conceptFile) {
    return `/concept-status?context=${encodeURIComponent(conceptFile)}`;
  }

  return '/';
}

function readPendingConcepts() {
  try {
    const latestState = getLatestProjectState();
    const activeProjectId = String(latestState.project_id || '').trim();
    const files = fs
      .readdirSync(CONCEPT_CONTEXT_ROOT)
      .filter((name) => name.startsWith('concept_context_') && name.endsWith('.json'))
      .map((name) => path.join(CONCEPT_CONTEXT_ROOT, name))
      .filter((fullPath) => fs.statSync(fullPath).isFile())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    const seenProjects = new Set();
    const items = files
      .map((contextPath) => {
        const stat = fs.statSync(contextPath);
        if (!hoursAgo(stat.mtimeMs)) return null;
        const context = readContextFile(contextPath);
        const projectId = context.project_id || path.basename(contextPath);
        if (!projectId || seenProjects.has(projectId)) return null;
        if (activeProjectId && projectId !== activeProjectId) return null;
        seenProjects.add(projectId);
        if (fs.existsSync(selectedConceptSidecarPath(projectId))) return null;
        const state = readProjectState(projectId);
        if (String(state.status || '').trim() !== 'waiting_for_concept_selection') return null;
        const concepts = Array.isArray(context.creative_concepts)
          ? context.creative_concepts
          : [];
        return {
          projectId,
          productName: context.product_name || '',
          targetMarket: context.target_market || '',
          targetLanguage: context.target_language || '',
          creativeTaskType: context.creative_task_type || '',
          conceptCount: Number(context.concept_count || concepts.length || 0),
          openUrl: `/concepts/item?context=${encodeURIComponent(path.basename(contextPath))}`,
          startedAt: stat.mtime.toISOString(),
        };
      })
      .filter(Boolean)
      .slice(0, 1);

    return { ok: true, items };
  } catch (error) {
    return { ok: false, error: error.message || String(error), items: [] };
  }
}

function getConceptContextPathFromRequestUrl(urlString) {
  const url = new URL(urlString, `http://${HOST}:${PORT}`);
  const fileName = String(url.searchParams.get('context') || '').trim();
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) return '';
  const contextPath = path.join(CONCEPT_CONTEXT_ROOT, fileName);
  if (!contextPath.startsWith(CONCEPT_CONTEXT_ROOT)) return '';
  return contextPath;
}

function readPendingReviews() {
  try {
    const latestState = getLatestProjectState();
    const activeProjectId = String(latestState.project_id || '').trim();
    const files = fs
      .readdirSync(REVIEW_CONTEXT_ROOT)
      .filter(
        (name) =>
          name.startsWith('review_context_') &&
          name.endsWith('.json') &&
          !name.endsWith('.submitted.json'),
      )
      .map((name) => path.join(REVIEW_CONTEXT_ROOT, name))
      .filter((fullPath) => fs.statSync(fullPath).isFile())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    const seenProjects = new Set();
    const items = files
      .map((contextPath) => {
        const stat = fs.statSync(contextPath);
        if (!hoursAgo(stat.mtimeMs)) {
          return null;
        }
        const submittedPath = submittedSidecarPath(contextPath);
        if (fs.existsSync(submittedPath)) {
          return null;
        }
        const context = readContextFile(contextPath);
        const projectId = context.project_id || path.basename(contextPath);
        if (activeProjectId && projectId !== activeProjectId) {
          return null;
        }
        if (seenProjects.has(projectId)) {
          return null;
        }
        seenProjects.add(projectId);
        const panels = Array.isArray(context.panel_review_pack) ? context.panel_review_pack : [];
        const fileName = path.basename(contextPath);
        return {
          reviewContextPath: contextPath,
          reviewOpenUrl: `/reviews/item?context=${encodeURIComponent(fileName)}`,
          projectId,
          productName: context.product_name || '',
          reviewRound: Number(context.review_round || 1),
          panelCount: Number(context.panel_count || panels.length || 0),
          startedAt: stat.mtime.toISOString(),
          previews: panels
            .map((panel) => panel.panel_preview_path
              ? `/local-file?path=${encodeURIComponent(panel.panel_preview_path)}`
              : normalizeAssetUrl(panel.panel_preview_url))
            .filter(Boolean)
            .slice(0, 6),
        };
      })
      .filter(Boolean)
      .slice(0, REVIEW_MAX_ITEMS);

    const latestOnly = items.length > 1 ? [items[0]] : items;

    return { ok: true, items: latestOnly };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      items: [],
    };
  }
}

function buildProjectDashboard(projectId) {
  const state = mergeDerivedProjectStateForUi(projectId, readProjectState(projectId));
  const conceptFile = getLatestConceptContextFileForProject(projectId);
  const reviewFile = getLatestReviewContextFileForProject(projectId);
  const selectedPath = selectedConceptSidecarPath(projectId);
  const selected = fs.existsSync(selectedPath) ? readContextFile(selectedPath) : {};
  const reviewContextPath = reviewFile ? path.join(REVIEW_CONTEXT_ROOT, reviewFile) : '';
  const submitted = reviewContextPath && fs.existsSync(submittedSidecarPath(reviewContextPath))
    ? readContextFile(submittedSidecarPath(reviewContextPath))
    : {};
  const progress = readProgressFile(projectId);
  const execution = findLatestExecutionForProject(projectId);
  const hasReview = !!reviewFile;
  const hasConcept = !!conceptFile;
  const hasSelectedConcept = !!(selected.selected_concept_id || state.selected_concept_id);
  const shots = Array.isArray(progress.shots) ? progress.shots : [];
  const completedShots = shots.filter((shot) => String(shot.status || '') === 'completed').length;
  const runningShots = shots.filter((shot) => ['running', 'submitted'].includes(String(shot.status || ''))).length;
  const failedShots = shots.filter((shot) => String(shot.status || '') === 'failed').length;
  const hasMerged = !!String(progress.final_merged_video_path || '').trim();
  const videoFiles = listProjectVideoFiles(projectId);
  const expectedVideoClipCount = shots.length || 6;
  const finalVideoFromProgressRaw = String(progress.final_merged_video_path || '').trim();
  const finalVideoFromProgress = (() => {
    if (!finalVideoFromProgressRaw) return '';
    try { return fs.statSync(finalVideoFromProgressRaw).isFile() ? finalVideoFromProgressRaw : ''; } catch { return ''; }
  })();
  const finalVideoFromCache = (() => {
    const pid = String(projectId || '').replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase();
    const finalDir = path.join(CACHE_ROOT, 'final-video');
    try {
      return fs.readdirSync(finalDir)
        .find((name) => name.toLowerCase().startsWith(`final_${pid}_`) && name.toLowerCase().endsWith('.mp4')) || '';
    } catch {
      return '';
    }
  })();
  const exportedFinal = (() => {
    const pid = String(projectId || '').replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase();
    const finalDir = getConfiguredFinalOutputDir();
    if (!finalDir) return '';
    try {
      const name = fs.readdirSync(finalDir)
        .find((fileName) => fileName.toLowerCase().includes(pid) && fileName.toLowerCase().endsWith('.mp4')) || '';
      return name ? path.join(finalDir, name) : '';
    } catch {
      return '';
    }
  })();
  const facadeDerivedStage = deriveStageFacade(state, {
    conceptContext: conceptFile,
    selectedConcept: hasSelectedConcept,
    scriptContext: fs.existsSync(path.join(SCRIPT_CONTEXT_ROOT, `script_context_${String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`)),
    confirmedScriptContext: fs.existsSync(confirmedScriptContextPath(projectId)),
    reviewContexts: reviewFile ? [reviewFile] : [],
    expectedVideoClipCount,
    videoClipCount: Math.max(videoFiles.length, completedShots),
    finalVideo: finalVideoFromProgress || finalVideoFromCache,
    exportedFinal,
  });
  const currentStageLabel = getStageStatusLabelFacade(facadeDerivedStage);
  const stages = [
    { key: 'input', label: '1. 提交表单', status: state.project_id ? 'done' : 'todo' },
    { key: 'concept', label: '2. 生成创意方向', status: hasConcept ? 'done' : 'running' },
    { key: 'select', label: '3. 选择创意方向', status: hasSelectedConcept ? 'done' : (String(state.status || '') === 'waiting_for_concept_selection' ? 'running' : 'todo') },
    { key: 'storyboard', label: '4. 脚本与分镜生成', status: hasReview ? 'done' : (hasSelectedConcept ? 'running' : 'todo') },
    { key: 'review', label: '5. 分镜审核', status: submitted.submittedAt ? 'done' : (hasReview ? 'running' : 'todo') },
    { key: 'video', label: '6. 视频生成', status: completedShots ? (runningShots ? 'running' : 'done') : (submitted.submittedAt ? (failedShots ? 'failed' : 'running') : 'todo') },
    { key: 'final', label: '7. 完成下载', status: completedShots ? 'done' : 'todo' },
  ];
  return { state, selected, progress, execution, stages, hasReview, hasConcept, hasSelectedConcept, hasMerged, reviewFile, conceptFile, facadeDerivedStage, currentStageLabel };
}

function buildRunContextSummary(projectId) {
  const state = readProjectState(projectId);
  const selectedPath = selectedConceptSidecarPath(projectId);
  const selected = fs.existsSync(selectedPath) ? readContextFile(selectedPath) : {};
  const revisions = readConceptRevisionState(projectId);
  const promptCenter = loadPromptCenter();

  // confirmed_script_context is written when the user confirms a script and is the
  // authoritative record of which concept was actually used downstream.  The
  // selected-concept sidecar can drift (e.g. if revisions were saved after script
  // confirmation) so when a confirmed context exists we prefer its concept_id.
  const confirmedPath = confirmedScriptContextPath(projectId);
  const confirmedCtx = fs.existsSync(confirmedPath) ? readContextFile(confirmedPath) : null;
  const confirmedConceptId = String(confirmedCtx?.selected_concept_id || '').trim();

  const conceptId = String(confirmedConceptId || selected.selected_concept_id || state.selected_concept_id || '').trim();

  // If confirmed context exists and its concept differs from the sidecar, reconstruct
  // the concept display object from the fields the confirmed context has inline.
  const sidecarConceptId = String(selected.selected_concept_id || '').trim();
  let selectedConceptRaw = selected.selected_concept_json || {};
  if (confirmedCtx && confirmedConceptId && confirmedConceptId !== sidecarConceptId) {
    selectedConceptRaw = {
      concept_id: confirmedConceptId,
      concept_name: confirmedCtx.selected_concept_name || '',
      concept_name_original: confirmedCtx.selected_concept_name_original || '',
      video_type: confirmedCtx.video_type || confirmedCtx.creative_task_type || '',
      target_user: confirmedCtx.target_user || '',
      usage_scene: confirmedCtx.usage_scene || '',
      visual_expression: confirmedCtx.visual_expression || '',
      hook_strategy: confirmedCtx.hook_strategy || '',
      core_selling_angle: confirmedCtx.core_selling_angle || '',
      why_it_fits_tiktok: confirmedCtx.why_it_fits_tiktok || '',
      model_profile: confirmedCtx.model_profile || '',
    };
  }

  const selectedConceptRevision = conceptId ? revisions.revisions?.[conceptId] || {} : {};
  const selectedConcept = mergeConceptWithRevision(selectedConceptRaw, selectedConceptRevision);
  return {
    projectId,
    promptCenterVersion: promptCenter._version || '',
    promptCenterUpdatedAt: promptCenter.updated_at || '',
    selectedConceptId: conceptId,
    selectedConceptName: selectedConcept.concept_name || selectedConcept.concept_name_original || '',
    selectedConceptVideoType: selectedConcept.video_type || '',
    selectedConceptTargetUser: selectedConcept.target_user || '',
    selectedConceptUsageScene: selectedConcept.usage_scene || '',
    selectedConceptVisualExpression: selectedConcept.visual_expression || '',
    selectedConceptHook: selectedConcept.hook_strategy || '',
    selectedConceptCoreSellingAngle: selectedConcept.core_selling_angle || '',
    selectedConceptWhyTikTok: selectedConcept.why_it_fits_tiktok || '',
    selectedConceptModelProfile: selectedConcept.model_profile || '',
    conceptRevisionStatePath: conceptRevisionPath(projectId),
    conceptRevisionCount: Object.keys(revisions.revisions || {}).length,
    selectedConceptRevision: selectedConceptRevision,
    selectedSidecarPath: selectedPath,
    confirmedConceptId: confirmedConceptId || '',
    sidecarStale: !!(confirmedConceptId && confirmedConceptId !== sidecarConceptId),
  };
}

function commonCSS() {
  return `<style>
    :root {
      --bg:#eef2f7;--surface:#ffffff;--surface-2:#f8fafc;
      --border:#e2e8f0;--border-strong:#cbd5e1;
      --text:#0f172a;--muted:#475569;
      --accent:#2563eb;--accent-hov:#1d4ed8;--accent-dim:rgba(37,99,235,0.08);
      --danger:#dc2626;--danger-dim:rgba(220,38,38,0.08);
      --success:#16a34a;--success-dim:rgba(22,163,74,0.1);
      --warning:#d97706;--warning-dim:rgba(217,119,6,0.08);
      --info:#0284c7;--info-dim:rgba(2,132,199,0.08);
      --nav-bg:#0f172a;
      --r:7px;--rl:11px;
      --shadow:0 1px 2px rgba(15,23,42,0.04),0 2px 6px rgba(15,23,42,0.06);
      --shadow-md:0 2px 4px rgba(15,23,42,0.05),0 8px 22px rgba(15,23,42,0.08);
      --shadow-lg:0 12px 34px rgba(15,23,42,0.12);
    }
    *,*::before,*::after{box-sizing:border-box;}
    body{margin:0;font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.6;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;}
    main{max-width:1120px;margin:0 auto;padding:24px 20px 56px;}
    h1{font-size:23px;margin:0 0 14px;letter-spacing:-.012em;color:var(--text);font-weight:700;}
    h2{font-size:17px;margin:0 0 10px;color:var(--text);letter-spacing:-.006em;font-weight:700;}
    h3{font-size:15px;margin:0 0 8px;color:var(--text);font-weight:600;}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);padding:18px;margin-bottom:12px;box-shadow:var(--shadow);transition:box-shadow .18s ease,border-color .18s ease,transform .18s ease;}
    .card:hover{box-shadow:var(--shadow-md);border-color:var(--border-strong);}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 15px;border:1px solid transparent;border-radius:var(--r);font:inherit;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap;transition:background .15s,border-color .15s,box-shadow .15s,transform .12s;outline:none;}
    .btn:active{transform:translateY(.5px);}
    .btn-primary{background:linear-gradient(180deg,#2f6df0,var(--accent));color:#fff;border-color:var(--accent-hov);box-shadow:0 1px 2px rgba(37,99,235,0.25);}
    .btn-primary:hover{background:var(--accent-hov);border-color:var(--accent-hov);color:#fff;box-shadow:0 2px 8px rgba(37,99,235,0.25);}
    .btn-primary:focus-visible{background:var(--accent-hov);border-color:var(--accent-hov);color:#fff;box-shadow:0 0 0 3px rgba(37,99,235,0.35);}
    .btn-primary:active{background:#1e40af;border-color:#1e40af;color:#fff;box-shadow:none;}
    .btn-secondary{background:var(--surface);color:var(--text);border-color:var(--border-strong);}
    .btn-secondary:hover{background:#dbeafe;border-color:var(--accent);color:#1d4ed8;}
    .btn-secondary:focus-visible{background:#dbeafe;border-color:var(--accent);color:#1d4ed8;box-shadow:0 0 0 3px rgba(37,99,235,0.15);}
    .btn-secondary:active{background:#bfdbfe;border-color:#1d4ed8;color:#1d4ed8;}
    .btn-danger{background:var(--danger);color:#fff;border-color:var(--danger);}
    .btn-danger:hover{background:#b91c1c;border-color:#b91c1c;color:#fff;box-shadow:0 2px 8px rgba(220,38,38,0.25);}
    .btn-danger:focus-visible{background:#b91c1c;border-color:#b91c1c;color:#fff;box-shadow:0 0 0 3px rgba(220,38,38,0.3);}
    .btn-danger:active{background:#991b1b;border-color:#991b1b;color:#fff;box-shadow:none;}
    .btn:disabled,.btn[disabled]{opacity:.45;cursor:not-allowed;pointer-events:none;}
    .btn-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}
    .muted{color:var(--muted);}
    code{font-family:Menlo,Monaco,Consolas,monospace;font-size:12px;word-break:break-all;background:#f1f5f9;color:#1e40af;padding:1px 5px;border-radius:3px;border:1px solid #dde4f0;}
    pre{white-space:pre-wrap;word-break:break-word;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);padding:12px;font:13px/1.6 Menlo,Monaco,Consolas,monospace;margin:0;color:var(--text);}
    a{color:var(--accent);text-decoration:none;}
    a:hover{color:var(--accent-hov);text-decoration:underline;}
    .btn:hover,.btn:focus-visible,.btn:active{text-decoration:none;}
    a.btn-primary:hover,a.btn-primary:focus-visible,a.btn-primary:active{color:#fff;}
    a.btn-secondary:hover,a.btn-secondary:focus-visible,a.btn-secondary:active{color:#1d4ed8;}
    a.btn-danger:hover,a.btn-danger:focus-visible,a.btn-danger:active{color:#fff;}
    .badge{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;font-weight:600;font-size:12px;letter-spacing:.02em;line-height:1.5;}
    .badge-done{background:#dcfce7;color:#15803d;border:1px solid #bbf7d0;}
    .badge-running{background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe;}
    .badge-failed{background:#fee2e2;color:#b91c1c;border:1px solid #fecaca;}
    .badge-todo{background:#f1f5f9;color:#64748b;border:1px solid var(--border-strong);}
    .field-label{display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.06em;}
    .field-value{display:block;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--text);}
    .field-row{padding:8px 10px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface-2);margin-bottom:6px;}
    .structured-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0;}
    input[type=text],input[type=email],input[type=password],select,textarea{width:100%;padding:7px 10px;border:1px solid var(--border-strong);border-radius:var(--r);font:inherit;font-size:13px;background:var(--surface);color:var(--text);transition:border-color .15s,box-shadow .15s;}
    input[type=text]:focus,input[type=email]:focus,input[type=password]:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim);}
    textarea{resize:vertical;min-height:80px;}
    .form-row{margin-bottom:14px;}
    .form-label{display:block;font-weight:600;margin-bottom:5px;font-size:13px;color:var(--text);}
    .table-wrap{overflow:auto;border:1px solid var(--border);border-radius:var(--rl);box-shadow:var(--shadow);}
    table{width:100%;border-collapse:collapse;min-width:960px;}
    th,td{border-bottom:1px solid var(--border);padding:8px 10px;text-align:left;vertical-align:top;font-size:13px;}
    th{position:sticky;top:0;background:var(--surface-2);font-weight:700;white-space:nowrap;z-index:1;color:var(--text);font-size:11px;text-transform:uppercase;letter-spacing:.07em;border-bottom:2px solid var(--border-strong);}
    tr:last-child td{border-bottom:0;}
    tr:hover td{background:#fafbff;}
    .progress-track{height:6px;border-radius:99px;background:var(--border);overflow:hidden;margin:8px 0;box-shadow:inset 0 1px 1px rgba(15,23,42,0.05);}
    .progress-bar{height:100%;background:linear-gradient(90deg,var(--accent),#22a3c4);border-radius:99px;transition:width .4s ease;}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    .shot-row{border:1px solid var(--border);border-radius:var(--rl);padding:11px 13px;margin-bottom:8px;background:var(--surface);box-shadow:var(--shadow);transition:box-shadow .16s ease,border-color .16s ease;}
    .shot-row:hover{box-shadow:var(--shadow-md);border-color:var(--border-strong);}
    .alert-ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d;padding:11px 15px;border-radius:var(--r);margin-bottom:12px;box-shadow:var(--shadow);}
    .alert-err{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;padding:11px 15px;border-radius:var(--r);margin-bottom:12px;box-shadow:var(--shadow);}
    .alert-info{background:#f0f9ff;border:1px solid #bae6fd;color:#0369a1;padding:11px 15px;border-radius:var(--r);margin-bottom:12px;box-shadow:var(--shadow);line-height:1.7;}
    .alert-warn{background:#fffbeb;border:1px solid #fde68a;color:#b45309;padding:11px 15px;border-radius:var(--r);margin-bottom:12px;box-shadow:var(--shadow);line-height:1.7;}
    details summary{cursor:pointer;font-size:12px;color:var(--accent);user-select:none;list-style:none;display:inline-flex;align-items:center;gap:4px;}
    details summary::-webkit-details-marker{display:none;}
    details summary::before{content:'▸';font-size:10px;transition:transform .15s;display:inline-block;}
    details[open] summary::before{transform:rotate(90deg);}
    .hint-box{margin-top:8px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);padding:10px 14px;font-size:12px;color:var(--muted);line-height:1.85;}
    .hint-box code{font-size:11px;}
    @media(max-width:720px){.grid-2{grid-template-columns:1fr;}}
  </style>`;
}

function resolveStageNavFiles(contextFile = '') {
  let projectId = '';
  let conceptFile = '';
  let reviewFile = '';
  const base = contextFile ? path.basename(contextFile) : '';

  if (base.startsWith('review_context_')) {
    reviewFile = base;
    try {
      const ctx = readContextFile(path.join(REVIEW_CONTEXT_ROOT, base));
      projectId = String(ctx.project_id || '').trim();
    } catch {}
  } else if (base.startsWith('concept_context_')) {
    conceptFile = base;
    try {
      const ctx = readContextFile(path.join(CONCEPT_CONTEXT_ROOT, base));
      projectId = String(ctx.project_id || '').trim();
    } catch {}
  }

  if (!projectId) projectId = getLatestProjectId();
  if (!conceptFile && projectId) conceptFile = getLatestConceptContextFileForProject(projectId);
  if (!reviewFile && projectId) reviewFile = getLatestReviewContextFileForProject(projectId);
  return { projectId, conceptFile, reviewFile };
}

// contextFile may be either concept_context_*.json or review_context_*.json.
// The nav always points to the latest available stage for the same project.
function renderStageNav(active = '', contextFile = '') {
  const { projectId, conceptFile, reviewFile } = resolveStageNavFiles(contextFile);
  const reviewQp = reviewFile ? `?context=${encodeURIComponent(reviewFile)}` : '';
  const conceptQp = conceptFile ? `?context=${encodeURIComponent(conceptFile)}` : '';
  // Script link: prefer new project_id mode (editable), fall back to legacy review_context mode
  const scriptHref = projectId
    ? `/script-review?project_id=${encodeURIComponent(projectId)}`
    : (reviewFile ? `/script-review${reviewQp}` : '');
  const stages = [
    { key: 'form',      label: '表单',    href: '/' },
    { key: 'concept',   label: '创意方向', href: conceptFile ? `/concepts/item${conceptQp}` : '/concepts' },
    { key: 'script',    label: '脚本框架', href: scriptHref },
    { key: 'storyboard',label: '分镜图',   href: reviewFile ? `/reviews/item${reviewQp}`     : '/reviews' },
    { key: 'video',     label: '视频',     href: reviewFile ? `/review-status${reviewQp}`    : '' },
    { key: 'final',     label: '最终成片', href: reviewFile ? `/final-video${reviewQp}`      : '' },
  ];
  const items = stages.map((s, i) => {
    const isActive = s.key === active;
    const baseStyle = `font-weight:${isActive ? '700' : '400'};font-size:13px;`;
    const el = s.href
      ? `<a href="${s.href}" style="color:${isActive ? '#60a5fa' : '#94a3b8'};text-decoration:none;${baseStyle}transition:color .15s;" onmouseover="this.style.color='#93c5fd'" onmouseout="this.style.color='${isActive ? '#60a5fa' : '#94a3b8'}'">${htmlEscape(s.label)}</a>`
      : `<span style="color:#475569;${baseStyle}cursor:default;" title="需要分镜上下文">${htmlEscape(s.label)}</span>`;
    return i < stages.length - 1 ? el + '<span style="color:#334155;margin:0 6px;font-size:11px;">›</span>' : el;
  }).join('');
  return `<nav style="background:var(--nav-bg);padding:10px 20px;display:flex;align-items:center;gap:0;border-bottom:1px solid rgba(255,255,255,0.06);position:sticky;top:0;z-index:100;">${items}<span style="flex:1;"></span><a href="/system" style="color:#94a3b8;font-size:12px;text-decoration:none;margin-right:14px;transition:color .15s;" onmouseover="this.style.color='#93c5fd'" onmouseout="this.style.color='#94a3b8'">运行环境</a><a href="/" style="color:#94a3b8;font-size:12px;text-decoration:none;transition:color .15s;" onmouseover="this.style.color='#93c5fd'" onmouseout="this.style.color='#94a3b8'">工作台</a></nav>`;
}

// Parse "Scene: xxx Action: yyy Camera: zzz ..." style zh prompt into structured fields
function parseZhPromptFields(raw) {
  if (!raw) return {};
  const fieldMap = {
    'Scene': 'scene',
    'Action': 'action',
    'Camera': 'camera',
    'Product state': 'product_state',
    'Expression': 'expression',
    'Voiceover (local)': 'voiceover',
    'Continuity': 'continuity',
  };
  const keys = Object.keys(fieldMap);
  // Build regex that splits on "FieldName: " boundaries
  const pattern = new RegExp(`(${keys.map(k => k.replace(/[()]/g, '\\$&')).join('|')}):\\s*`, 'g');
  const parts = raw.split(pattern);
  const result = {};
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i];
    const val = (parts[i + 1] || '').trim();
    const mapped = fieldMap[key];
    if (mapped && val) result[mapped] = val;
  }
  return result;
}

// renderScriptReviewPage: new main version reads from script_context.json (editable + confirm)
// renderScriptReviewLegacyPage: backward-compat reads from review_context.json (read-only)

function renderScriptReviewPage(projectId) {
  const scriptFile = scriptContextPath(projectId);
  let ctx = {};
  if (fs.existsSync(scriptFile)) {
    try { ctx = JSON.parse(fs.readFileSync(scriptFile, 'utf8')); } catch (_) {}
  }
  const hasContext = fs.existsSync(scriptFile);

  // P17-C1: check if downstream storyboard/video was invalidated
  let _scriptProjState = readProjectState(projectId);
  _scriptProjState = reconcileScriptContextStateForUi(projectId, _scriptProjState, hasContext);
  const _storyboardInvalidatedAt = _scriptProjState.storyboard_invalidated_at || '';
  const _scriptInvalidatedAt = _scriptProjState.script_invalidated_at || '';
  const _staleDir = path.join(CACHE_ROOT, 'stale', String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_'));
  const _hasStaleItems = fs.existsSync(_staleDir) && (() => { try { return fs.readdirSync(_staleDir).length > 0; } catch { return false; } })();
  const _staleBanner = (_storyboardInvalidatedAt || _hasStaleItems) && !_scriptInvalidatedAt
    ? `<div style="background:rgba(251,191,36,.12);border:1px solid #fbbf24;border-radius:8px;padding:10px 16px;color:#fcd34d;font-size:13px;margin-bottom:14px;line-height:1.7;">
        ⚠ <strong>脚本已更新，旧分镜和旧视频已过期。</strong> 确认新脚本后系统将重新生成分镜图；旧内容不会再作为当前结果展示。
       </div>`
    : '';

  // Load user overrides if present
  const overridesFile = path.join(SCRIPT_CONTEXT_ROOT, `script_user_overrides_${String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`);
  let overrides = {};
  if (fs.existsSync(overridesFile)) {
    try { overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8')); } catch (_) {}
  }
  const overrideMap = {};
  if (Array.isArray(overrides.shots)) {
    for (const ov of overrides.shots) { if (ov.shot_id) overrideMap[ov.shot_id] = ov; }
  }

  const shots = Array.isArray(ctx.shots) ? ctx.shots : [];
  const productName = ctx.product_name || '';
  const conceptName = ctx.selected_concept_name || '';
  const taskType = ctx.creative_task_type || '';
  const taskLabelStr = taskTypeLabel(taskType);

  const conceptContextBase = (() => {
    if (ctx.concept_context_path) return path.basename(ctx.concept_context_path);
    if (projectId) {
      const inferred = `concept_context_${projectId}.json`;
      if (fs.existsSync(path.join(CONCEPT_CONTEXT_ROOT, inferred))) return inferred;
    }
    return '';
  })();
  const conceptLink = conceptContextBase
    ? `/concepts/item?context=${encodeURIComponent(conceptContextBase)}`
    : '/concepts';

  const inp = (name, val, placeholder = '') =>
    `<input name="${htmlEscape(name)}" value="${htmlEscape(val || '')}" placeholder="${htmlEscape(placeholder)}"
      style="width:100%;box-sizing:border-box;padding:5px 7px;font-size:12px;border:1px solid var(--border-strong);border-radius:4px;background:var(--surface);color:var(--text);line-height:1.4;">`;

  const textareaField = (name, val, rows = 2) =>
    `<textarea name="${htmlEscape(name)}" rows="${rows}"
      style="width:100%;box-sizing:border-box;padding:5px 7px;font-size:12px;border:1px solid var(--border-strong);border-radius:4px;background:var(--surface);color:var(--text);resize:vertical;line-height:1.5;">${htmlEscape(val || '')}</textarea>`;

  const thCell = (label, sub = '') => `<th style="padding:8px 10px;text-align:left;font-size:11px;font-weight:700;color:var(--text);white-space:nowrap;background:var(--surface-2);border-bottom:2px solid var(--border-strong);">${label}${sub ? `<div style="font-size:10px;font-weight:400;color:var(--muted);margin-top:1px;">${sub}</div>` : ''}</th>`;
  const tdCell = (content, extra = '') => `<td style="padding:7px 9px;vertical-align:top;border-bottom:1px solid var(--border);${extra}">${content}</td>`;

  const stageStyleMap = {
    'hook':         { bg:'#eff6ff', color:'#1d4ed8', label:'Hook' },
    'demo':         { bg:'#f0fdf4', color:'#15803d', label:'展示' },
    'edu':          { bg:'#fefce8', color:'#a16207', label:'教育' },
    'cta':          { bg:'#fff7ed', color:'#c2410c', label:'CTA'  },
    'bridge':       { bg:'#faf5ff', color:'#7e22ce', label:'过渡' },
    'drama_hook':   { bg:'#fdf4ff', color:'#7c3aed', label:'Drama Hook' },
    'conflict':     { bg:'#fef9c3', color:'#854d0e', label:'冲突升级' },
    'product_turn': { bg:'#dbeafe', color:'#1d4ed8', label:'产品介入' },
    'payoff':       { bg:'#dcfce7', color:'#15803d', label:'情绪释放' },
    'soft_cta':     { bg:'#fff7ed', color:'#c2410c', label:'轻 CTA'   },
  };

  const rows = shots.map((shot, idx) => {
    const ov = overrideMap[shot.shot_id] || {};
    const shotId = shot.shot_id || `shot_${idx + 1}`;
    const shotNum = String(shot.shot_order || idx + 1);
    const stageKey = String(shot.stage || '').toLowerCase();
    const stageSt = stageStyleMap[stageKey] || null;
    const stageBadge = stageSt
      ? `<span style="display:inline-block;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:700;background:${stageSt.bg};color:${stageSt.color};">${stageSt.label}</span>`
      : (shot.stage ? `<span class="badge badge-todo" style="font-size:10px;">${htmlEscape(String(shot.stage))}</span>` : '');

    return `<tr style="background:${idx % 2 === 1 ? 'var(--surface-2)' : 'var(--surface)'};">
      <td style="padding:7px 10px;vertical-align:middle;border-bottom:1px solid var(--border);text-align:center;white-space:nowrap;min-width:70px;">
        <div style="font-size:16px;font-weight:700;color:var(--accent);line-height:1;">${htmlEscape(shotNum)}</div>
        <input type="hidden" name="shots[${idx}][shot_id]" value="${htmlEscape(shotId)}">
        <div style="margin-top:5px;">${inp(`shots[${idx}][duration]`, ov.duration ?? shot.duration ?? '', '时长')}</div>
      </td>
      <td style="padding:7px 9px;vertical-align:middle;border-bottom:1px solid var(--border);min-width:80px;text-align:center;">
        ${stageBadge || '<span style="color:var(--muted);font-size:11px;">—</span>'}
      </td>
      ${tdCell(
        `<div style="margin-bottom:5px;">${inp(`shots[${idx}][camera_movement]`, ov.camera_movement ?? shot.camera_movement ?? '', '运镜方式')}</div>` +
        inp(`shots[${idx}][scene_setting]`, ov.scene_setting ?? shot.scene_setting ?? '', '景别/场景设置'),
        'min-width:150px;'
      )}
      ${tdCell(textareaField(`shots[${idx}][visual_action]`, ov.visual_action ?? shot.visual_action ?? '', 3), 'min-width:180px;')}
      ${tdCell(inp(`shots[${idx}][product_state]`, ov.product_state ?? shot.product_state ?? '', '产品状态/重点'), 'min-width:130px;')}
      ${tdCell(inp(`shots[${idx}][continuity_requirements]`, ov.continuity_requirements ?? shot.continuity_requirements ?? '', '转场/节奏说明'), 'min-width:130px;')}
      ${tdCell(textareaField(`shots[${idx}][optional_voiceover_local]`, ov.optional_voiceover_local ?? shot.optional_voiceover_local ?? '', 3), 'min-width:170px;')}
      ${tdCell(inp(`shots[${idx}][expression_focus]`, ov.expression_focus ?? shot.expression_focus ?? '', '语气/情绪'), 'min-width:110px;')}
    </tr>`;
  }).join('');

  const _isScriptFailed = !hasContext && (
    String(_scriptProjState.stage || '').toLowerCase() === 'script_failed' ||
    (String(_scriptProjState.status || '').toLowerCase() === 'failed' && !!_scriptProjState.user_message)
  );
  const waitingState = !hasContext
    ? (_isScriptFailed
        ? `<div style="background:rgba(239,68,68,.1);border:1px solid #ef4444;border-radius:8px;padding:14px 18px;color:#fca5a5;font-size:14px;margin:24px 0;line-height:1.8;">
            ⚠ <strong>脚本框架生成失败。</strong><br>
            <span style="font-size:13px;color:var(--muted);">${htmlEscape(String(_scriptProjState.user_message || '文本模型连接失败，请稍后重试。'))}</span><br>
            <span style="font-size:12px;color:var(--muted);margin-top:6px;display:block;">项目 ID：${htmlEscape(String(projectId))}</span>
           </div>`
        : (_scriptInvalidatedAt
            ? `<div style="background:rgba(239,68,68,.1);border:1px solid #ef4444;border-radius:8px;padding:14px 18px;color:#fca5a5;font-size:14px;margin:24px 0;line-height:1.8;">
                ⚠ <strong>已选择新的创意方向，旧脚本和后续内容已过期，请重新生成脚本框架。</strong><br>
                <span style="font-size:13px;color:var(--muted);">新脚本框架正在生成中，请稍候刷新页面。项目 ID：${htmlEscape(String(projectId))}</span>
               </div>`
            : `<div class="alert-info" style="margin:32px 0;">脚本框架生成中，请稍等...<br><small style="color:var(--muted);">项目 ID：${htmlEscape(String(projectId))}</small></div>`))
    : '';
  const emptyState = hasContext && shots.length === 0
    ? `<div class="alert-info" style="margin:16px 0;">脚本框架为空，请检查 WF02A 是否正常运行。</div>`
    : '';

  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>短视频执行表</title>
${commonCSS()}
<style>
  .script-table{width:100%;border-collapse:collapse;}
  .script-table td,.script-table th{border-right:1px solid var(--border);}
  .script-table td:last-child,.script-table th:last-child{border-right:none;}
  .exec-header{background:linear-gradient(135deg,#f8faff 0%,#f0f4fb 100%);border:1px solid var(--border);border-radius:var(--rl);padding:16px 20px;margin-bottom:14px;box-shadow:var(--shadow);}
</style>
</head><body>
${renderStageNav('script', '')}
<div style="padding:20px 24px;overflow-x:auto;max-width:1600px;">
  <div class="exec-header">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <div>
        <h1 style="font-size:17px;font-weight:700;margin:0 0 2px;">短视频执行表</h1>
        ${conceptName ? `<p style="margin:0;font-size:12px;color:var(--muted);">创意方向：${htmlEscape(conceptName)}</p>` : ''}
      </div>
      ${productName ? `<span style="font-size:13px;font-weight:600;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:3px 10px;">${htmlEscape(productName)}</span>` : ''}
      ${taskType ? `<span class="badge badge-running">${htmlEscape(taskLabelStr)}</span>` : ''}
      <span style="flex:1;"></span>
      <a href="${conceptLink}" class="btn btn-secondary" style="font-size:12px;">← 创意方向</a>
      ${projectId ? `<button type="button" class="btn btn-secondary" style="font-size:12px;" data-project-id="${htmlEscape(String(projectId))}" onclick="!function(b){if(b.dataset.s)return;b.dataset.s=1;var t=b.textContent,p=b.dataset.projectId;b.disabled=true;b.textContent='同步中…';fetch('/api/reconcile-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:p})}).then(function(r){return r.json()}).then(function(d){if(!d.ok){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包';return}if(d.activeRoute&&d.activeRoute!==window.location.pathname+window.location.search){b.textContent='已同步当前项目状态';setTimeout(function(){window.location.href=d.activeRoute},600);return}b.textContent=(d.patched&&d.patched.length)?'已同步当前项目状态':'未发现新的生成结果';setTimeout(function(){b.disabled=false;delete b.dataset.s;b.textContent=t},3000)}).catch(function(){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包'})}(this)">同步当前项目状态</button>` : ''}
    </div>
  </div>
  ${_staleBanner}
  ${waitingState}
  ${emptyState}
  ${hasContext && shots.length > 0 ? `
  <p style="margin:0 0 10px;font-size:13px;color:var(--muted);">可直接编辑各字段后点击「保存草稿」，确认无误后点击「确认脚本 → 生成分镜图」。</p>
  <form id="script-form" method="POST" action="/script-shot-save">
    <input type="hidden" name="project_id" value="${htmlEscape(String(projectId))}">
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:var(--rl);box-shadow:var(--shadow);margin-bottom:14px;">
      <table class="script-table">
        <thead><tr>
          ${thCell('镜头', '编号 · 时长')}
          ${thCell('镜头目标', '阶段定位')}
          ${thCell('构图 / 运镜', '景别 · 镜头运动')}
          ${thCell('画面描述', '视觉动作')}
          ${thCell('产品展示', '状态 · 重点')}
          ${thCell('转场 / 节奏', '连续性')}
          ${thCell('口播 / 台词', '旁白参考')}
          ${thCell('语气 / 情绪', '表情基调')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="btn-row" style="gap:10px;">
      <button type="submit" class="btn btn-secondary">保存草稿（不触发生成）</button>
    </div>
  </form>
  <div class="btn-row" style="margin-top:10px;">
    <button type="button" id="confirm-script-btn" class="btn btn-primary" style="padding:9px 20px;">确认脚本 → 生成分镜图</button>
    <div id="confirm-script-error" style="display:none;color:var(--danger,#ef4444);font-size:13px;margin-top:8px;"></div>
  </div>
  <script>
  (function() {
    var btn = document.getElementById('confirm-script-btn');
    if (!btn) return;
    btn.addEventListener('click', function() {
      if (!confirm('确认脚本并开始生成分镜图？')) return;
      btn.disabled = true;
      btn.textContent = '分镜图生成中，请稍等…';
      var errEl = document.getElementById('confirm-script-error');
      if (errEl) errEl.style.display = 'none';
      var ov = document.createElement('div');
      ov.id = 'script-confirm-overlay';
      ov.style.cssText = 'position:fixed;inset:0;background:#0f172a;display:flex;align-items:center;justify-content:center;z-index:9999;flex-direction:column;gap:14px;';
      ov.innerHTML = '<div style="font-size:20px;font-weight:700;color:#e2e8f0;">分镜图生成中，请稍等…</div><div style="color:#94a3b8;font-size:14px;">正在提交脚本并触发分镜生成，即将跳转到状态页</div>';
      document.body.appendChild(ov);
      var projId = ${JSON.stringify(String(projectId))};
      var mf = document.getElementById('script-form');
      var params = new URLSearchParams();
      params.set('project_id', projId);
      if (mf) { mf.querySelectorAll('input,textarea,select').forEach(function(el) { if (el.name) params.set(el.name, el.value); }); }
      fetch('/script-confirm', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() })
        .then(function(r) {
          if (!r.ok) return r.text().then(function(t) { throw new Error('服务器错误 ' + r.status + (t ? '：' + t.slice(0, 120) : '')); });
          window.location.href = '/storyboard-status?project_id=' + encodeURIComponent(projId);
        })
        .catch(function(e) {
          var ovEl = document.getElementById('script-confirm-overlay');
          if (ovEl && ovEl.parentNode) ovEl.parentNode.removeChild(ovEl);
          btn.disabled = false;
          btn.textContent = '确认脚本 → 生成分镜图';
          if (errEl) { errEl.textContent = '提交失败：' + (e.message || '网络错误，请重试'); errEl.style.display = 'block'; }
        });
    });
  })();
  </script>
  <p style="margin:10px 0 0;font-size:12px;color:var(--muted);">共 ${shots.length} 个镜头 · 保存草稿后刷新可查看已保存内容</p>` : ''}
</div>
</body></html>`;
}

// Legacy: reads from review_context.json (read-only view of shots after storyboard is done)
function renderScriptReviewLegacyPage(contextPath) {
  let ctx = {};
  try { ctx = JSON.parse(fs.readFileSync(contextPath, 'utf8')); } catch (_) {}
  const shots = Array.isArray(ctx.panel_review_pack) ? ctx.panel_review_pack
    : Array.isArray(ctx.shots) ? ctx.shots : Array.isArray(ctx.panels) ? ctx.panels : [];
  const projectId = ctx.project_id || ctx.run_id || '';
  const productName = ctx.product_name || '';
  const conceptName = ctx.selected_concept_name || '';
  const taskType = ctx.creative_task_type || '';
  const th = (label) => `<th style="padding:8px 10px;text-align:left;font-size:12px;font-weight:600;color:var(--muted);white-space:nowrap;background:var(--bg);border-bottom:2px solid var(--border-strong);">${label}</th>`;
  const td = (content, extra = '') => `<td style="padding:8px 10px;vertical-align:top;font-size:13px;border-bottom:1px solid var(--border);${extra}">${content}</td>`;
  const dash = '<span style="color:var(--muted);">—</span>';
  const rows = shots.map((shot, idx) => {
    const parsed = parseZhPromptFields(shot.video_prompt_original_zh || '');
    const cell = (v) => td(v ? htmlEscape(v) : dash);
    const zhRaw = shot.video_prompt_original_zh || '';
    const vpRaw = shot.video_prompt || '';
    return `<tr>
      ${td(`<strong>${htmlEscape(String(shot.shot_order || idx + 1))}</strong>`, 'white-space:nowrap;')}
      ${td(shot.stage ? `<span class="badge badge-todo" style="font-size:11px;">${htmlEscape(shot.stage)}</span>` : dash)}
      ${td(htmlEscape(shot.duration || '') || dash, 'white-space:nowrap;color:var(--muted);')}
      ${cell(parsed.scene || shot.scene_setting || '')}
      ${cell(parsed.action || shot.visual_action || '')}
      ${cell(parsed.camera || shot.camera_movement || '')}
      ${cell(parsed.product_state || shot.product_state || '')}
      ${cell(parsed.expression || shot.expression_focus || '')}
      ${cell(parsed.voiceover || shot.optional_voiceover_local || '')}
      ${cell(parsed.continuity || shot.continuity_requirements || '')}
      ${td((zhRaw ? `<details style="margin:0;"><summary style="cursor:pointer;font-size:12px;color:var(--muted);">中文脚本</summary><pre style="margin:4px 0 0;font-size:11px;white-space:pre-wrap;word-break:break-all;">${htmlEscape(zhRaw)}</pre></details>` : '') + (vpRaw ? `<details style="margin:0;"><summary style="cursor:pointer;font-size:12px;color:var(--muted);">英文提示词</summary><pre style="margin:4px 0 0;font-size:11px;white-space:pre-wrap;word-break:break-all;">${htmlEscape(vpRaw)}</pre></details>` : '') || dash)}
    </tr>`;
  }).join('');
  const reviewQp = `?context=${encodeURIComponent(path.basename(contextPath))}`;
  const conceptContextBase = ctx.concept_context_path ? path.basename(ctx.concept_context_path) : '';
  const conceptLink = conceptContextBase ? `/concepts/item?context=${encodeURIComponent(conceptContextBase)}` : '/concepts';
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>脚本框架</title>
${commonCSS()}
<style>.script-table{width:100%;border-collapse:collapse;background:var(--surface);}.script-table td,.script-table th{border-right:1px solid var(--border);}.script-table td:last-child,.script-table th:last-child{border-right:none;}</style>
</head><body>
${renderStageNav('script', path.basename(contextPath))}
<div style="padding:20px 24px;overflow-x:auto;">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
    <h1 style="font-size:18px;font-weight:700;margin:0;">脚本框架</h1>
    ${productName ? `<span style="font-size:13px;color:var(--muted);">${htmlEscape(productName)}</span>` : ''}
    ${projectId ? `<span class="badge badge-todo" style="font-size:11px;">${htmlEscape(projectId)}</span>` : ''}
    ${taskType ? `<span class="badge badge-running" style="font-size:11px;">${htmlEscape(taskTypeLabel(taskType))}</span>` : ''}
    <span style="flex:1;"></span>
    <a href="/reviews/item${reviewQp}" class="btn btn-secondary" style="font-size:13px;">分镜图</a>
    <a href="${conceptLink}" class="btn btn-secondary" style="font-size:13px;">创意方向</a>
  </div>
  ${conceptName ? `<p style="margin:0 0 16px;font-size:13px;color:var(--muted);">概念：${htmlEscape(conceptName)}</p>` : ''}
  <div class="card" style="padding:0;overflow-x:auto;">
    <table class="script-table">
      <thead><tr>${th('镜号')}${th('阶段')}${th('时长')}${th('场景')}${th('动作')}${th('运镜')}${th('产品状态')}${th('表情/情绪')}${th('旁白/字幕')}${th('连续性/风险')}${th('脚本详情')}</tr></thead>
      <tbody>${shots.length === 0 ? `<tr><td colspan="11" style="padding:48px;text-align:center;color:var(--muted);">暂无数据</td></tr>` : ''}${rows}</tbody>
    </table>
  </div>
  <p style="margin:12px 0 0;font-size:12px;color:var(--muted);">共 ${shots.length} 个分镜</p>
</div></body></html>`;
}

function renderRunContextSummary(summary, title = '本次使用的创意变量') {
  const fields = [
    ['Prompt Center 版本', summary.promptCenterVersion || '未记录'],
    ['Prompt Center 更新时间', summary.promptCenterUpdatedAt || '未记录'],
    ['选定创意方向', summary.selectedConceptName || '未选择'],
    ['视频类型', summary.selectedConceptVideoType || '未填写'],
    ['目标用户', summary.selectedConceptTargetUser || '未填写'],
    ['使用场景', summary.selectedConceptUsageScene || '未填写'],
    ['内容风格', summary.selectedConceptVisualExpression || '未填写'],
    ['视觉 Hook', summary.selectedConceptHook || '未填写'],
    ['人物/模特设定', summary.selectedConceptModelProfile || '未填写'],
    ['核心卖点切入', summary.selectedConceptCoreSellingAngle || '未填写'],
    ['为什么适合 TikTok', summary.selectedConceptWhyTikTok || '未填写'],
    ['结构化修改数', summary.conceptRevisionCount || 0],
  ];
  return `<div class="card" style="background:var(--surface-2);">
    <p style="margin:0 0 8px;font-weight:600;">${htmlEscape(title)}</p>
    <div class="structured-grid">
      ${fields.map(([label, value]) => renderConceptField(label, value)).join('')}
    </div>
    ${summary.sidecarStale ? `<div style="margin-top:10px;padding:8px 12px;background:rgba(217,119,6,.08);border:1px solid #d97706;border-radius:6px;font-size:12px;color:#92400e;">⚠ 选定方向快照已过期：脚本以 <strong>${htmlEscape(summary.confirmedConceptId)}</strong> 确认，sidecar 记录为其他 ID。以上展示为脚本确认时使用的创意数据，sidecar 文件未修改。</div>` : ''}
    <p class="muted" style="margin:8px 0 0;font-size:12px;">修订文件：<code>${htmlEscape(summary.conceptRevisionStatePath || '')}</code></p>
    <p class="muted" style="margin:4px 0 0;font-size:12px;">选定概念文件：<code>${htmlEscape(summary.selectedSidecarPath || '')}</code></p>
  </div>`;
}

function renderCurrentProjectPage(projectId, options = {}) {
  const state = readProjectState(projectId);
  const dashboard = buildProjectDashboard(projectId);
  const runSummary = buildRunContextSummary(projectId);
  const conceptFile = dashboard.conceptFile;
  const reviewFile = dashboard.reviewFile;
  const conceptContext = conceptFile ? readContextFile(path.join(CONCEPT_CONTEXT_ROOT, conceptFile)) : {};
  const reviewContext = reviewFile ? readContextFile(path.join(REVIEW_CONTEXT_ROOT, reviewFile)) : {};
  const panelPack = Array.isArray(reviewContext.panel_review_pack) ? reviewContext.panel_review_pack : [];
  const notes = readProjectNotes(projectId);
  const historyItems = readProjectHistory(3);
  const activeRoute = getActiveRouteFacade(projectId, dashboard.facadeDerivedStage, {
    conceptContext: conceptFile,
    reviewContext: reviewFile,
  }) || getActiveRoute(projectId);
  const activeStageLabel = dashboard.currentStageLabel || dashboard.stages.find((s) => s.status === 'running')?.label || dashboard.stages.find((s) => s.status === 'done')?.label || '未开始';
  const conceptUrl = conceptFile ? `/concepts/item?context=${encodeURIComponent(conceptFile)}` : '';
  const reviewStatusUrl = reviewFile ? `/review-status?context=${encodeURIComponent(reviewFile)}` : '';
  const reviewDetailUrl = reviewFile ? `/reviews/item?context=${encodeURIComponent(reviewFile)}` : '';
  // Detect storyboard_generated (Level-5): panels exist but review context missing
  const _cpStage = (() => { try { return deriveProjectStage(projectId); } catch { return null; } })();
  const _cpContextMissing = _cpStage?.stage === 'storyboard_generated' && !getLatestReviewContextFileForProject(projectId);

  const stageRows = dashboard.stages.map((s) => {
    const cls = s.status === 'done' ? 'badge-done' : s.status === 'running' ? 'badge-running' : s.status === 'failed' ? 'badge-failed' : 'badge-todo';
    const label = s.status === 'done' ? '已完成' : s.status === 'running' ? '进行中' : s.status === 'failed' ? '失败' : '未开始';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
      <span>${htmlEscape(s.label)}</span><span class="badge ${cls}">${label}</span></div>`;
  }).join('');

  const historyCards = historyItems.length
    ? historyItems.map((item) => {
        const pUrl = item.openUrl || `/active?project_id=${encodeURIComponent(item.projectId)}`;
        return `<div class="card">
          <div style="font-weight:600;margin-bottom:4px;">${htmlEscape(item.projectId)}</div>
          <div class="muted">${htmlEscape(item.productName || '未填写')}</div>
          <div class="muted" style="font-size:12px;margin:4px 0;">${htmlEscape(item.creativeTaskType || '')} · ${htmlEscape(item.status || '')} · ${htmlEscape(item.updatedAt || '')}</div>
          <div class="btn-row">
            <a class="btn btn-secondary" href="${htmlEscape(pUrl)}">打开项目</a>
            ${item.conceptUrl ? `<a class="btn btn-secondary" href="${htmlEscape(item.conceptUrl)}">创意方向</a>` : ''}
            ${item.reviewUrl ? `<a class="btn btn-secondary" href="${htmlEscape(item.reviewUrl)}">脚本分镜</a>` : ''}
          </div></div>`;
      }).join('')
    : '<p class="muted">24 小时内没有可显示的项目历史。</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>当前项目 — ${htmlEscape(projectId)}</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('video', reviewFile)}
  <main>
    ${options.notesSaved ? `<div class="alert-ok">项目微调已保存，下一轮重跑会参考这份说明。</div>` : ''}
    ${_cpContextMissing ? `<div style="background:rgba(220,38,38,.08);border:1px solid #dc2626;border-radius:8px;padding:12px 16px;color:#dc2626;font-size:13px;margin-bottom:14px;">⚠ 分镜审核数据缺失：分镜图已生成但审核数据无效，请点击「重新生成分镜图」重新触发分镜生成。</div>` : ''}
    <div class="card">
      <h1 style="margin-bottom:4px;">${htmlEscape(projectId || '当前项目')}</h1>
      <p class="muted" style="margin:0 0 12px;">当前阶段：${htmlEscape(activeStageLabel)}</p>
      <div class="btn-row">
        <a class="btn btn-primary" href="${htmlEscape(activeRoute)}">继续当前阶段</a>
        ${conceptUrl ? `<a class="btn btn-secondary" href="${htmlEscape(conceptUrl)}">创意方向</a>` : ''}
        ${reviewDetailUrl ? `<a class="btn btn-secondary" href="${htmlEscape(reviewDetailUrl)}">脚本分镜</a>` : ''}
        ${reviewStatusUrl ? `<a class="btn btn-secondary" href="${htmlEscape(reviewStatusUrl)}">审核状态</a>` : ''}
        <a class="btn btn-secondary" href="/">工作台</a>
        <button type="button" class="btn btn-secondary" data-project-id="${htmlEscape(projectId)}" onclick="!function(b){if(b.dataset.s)return;b.dataset.s=1;var t=b.textContent,p=b.dataset.projectId;b.disabled=true;b.textContent='同步中…';fetch('/api/reconcile-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:p})}).then(function(r){return r.json()}).then(function(d){if(!d.ok){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包';return}if(d.activeRoute&&d.activeRoute!==window.location.pathname+window.location.search){b.textContent='已同步当前项目状态';setTimeout(function(){window.location.href=d.activeRoute},600);return}b.textContent=(d.patched&&d.patched.length)?'已同步当前项目状态':'未发现新的生成结果';setTimeout(function(){b.disabled=false;delete b.dataset.s;b.textContent=t},3000)}).catch(function(){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包'})}(this)">同步当前项目状态</button>
      </div>
    </div>
    <div class="grid-2">
      <div>
        <div class="card">
          <h2>项目信息</h2>
          <div class="muted" style="font-size:13px;">
            <div><strong>产品：</strong>${htmlEscape(state.product_name || '未填写')}</div>
            <div><strong>目标市场：</strong>${htmlEscape(state.target_market || '未填写')}</div>
            <div><strong>创作类型：</strong>${htmlEscape(taskTypeLabel(state.creative_task_type) || '未填写')}</div>
            <div><strong>状态：</strong>${htmlEscape(state.status || '')}</div>
          </div>
        </div>
        <div class="card">
          <h2>阶段进度</h2>
          ${stageRows}
        </div>
      </div>
      <div>
        <div class="card">
          <h2>项目微调</h2>
          <p class="muted" style="font-size:13px;">受众、场景、内容偏好等补充说明，供后续重跑时参考。</p>
          <form method="POST" action="/project-notes-save">
            <input type="hidden" name="project_id" value="${htmlEscape(projectId)}" />
            <div class="form-row"><textarea name="project_notes" placeholder="例如：目标用户更年轻；创意方向要更 UGC；前 3 秒要更强。">${htmlEscape(notes.notes || '')}</textarea></div>
            <button class="btn btn-primary" type="submit">保存微调</button>
          </form>
        </div>
        <div class="card">
          <h2>文件</h2>
          <p style="font-size:12px;margin:0;" class="muted">创意方向：<code>${htmlEscape(conceptFile || '未生成')}</code></p>
          <p style="font-size:12px;margin:4px 0 0;" class="muted">脚本分镜：<code>${htmlEscape(reviewFile || '未生成')}</code></p>
          <p style="font-size:12px;margin:4px 0 0;" class="muted">更新时间：<code>${htmlEscape(state.updated_at || state.created_at || '')}</code></p>
          ${dashboard.execution ? `<p style="font-size:12px;margin:4px 0 0;" class="muted">执行：<code>${htmlEscape(String(dashboard.execution.id || ''))}</code> · ${htmlEscape(dashboard.execution.status || '')}</p>` : ''}
        </div>
      </div>
    </div>
    <div class="card">
      <h2>创意方向概览</h2>
      ${conceptUrl ? `<p><a href="${htmlEscape(conceptUrl)}">创意方向文件：${htmlEscape(conceptFile || '')}</a></p>` : '<p class="muted">当前项目还没有创意方向上下文。</p>'}
      ${renderRunContextSummary(runSummary, '本次使用的创意变量')}
    </div>
    <div class="card">
      <h2>脚本表格预览</h2>
      ${panelPack.length ? `<p class="muted" style="margin-bottom:10px;">共 ${htmlEscape(String(panelPack.length))} 个镜头</p>` : '<p class="muted">等创意方向确认后会出现在这里。</p>'}
      ${renderShotScriptAndPromptCards(panelPack)}
    </div>
    <div class="card">
      <h2>项目历史</h2>
      ${historyCards}
    </div>
  </main>
</body>
</html>`;
}

function looksMostlyEnglish(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  return latin > 40 && cjk < Math.max(8, latin * 0.08);
}

function pickReadable(value, fallback = '未填写') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function renderShotScriptAndPromptCards(panelPack) {
  if (!Array.isArray(panelPack) || !panelPack.length) {
    return '<p class="muted">当前项目还没有可展示的分镜表。</p>';
  }
  const rows = panelPack.map((panel, index) => {
    const shotId = panel.shot_id || `shot_${index + 1}`;
    const parsed = parseZhPromptFields(panel.video_prompt_original_zh || '');
    const _thumbSrc = panel.panel_preview_path
      ? `/local-file?path=${encodeURIComponent(panel.panel_preview_path)}`
      : (panel.panel_preview_url ? normalizeAssetUrl(panel.panel_preview_url) : null);
    const thumb = _thumbSrc
      ? `<img src="${htmlEscape(_thumbSrc)}" loading="lazy" style="width:80px;aspect-ratio:9/16;object-fit:cover;border-radius:4px;border:1px solid var(--border);display:block;" />`
      : '<div style="width:80px;aspect-ratio:9/16;border-radius:4px;border:1px solid var(--border);background:#f1f0ef;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted);">无图</div>';
    const detail = panel.video_prompt_original_zh || panel.video_prompt
      ? `<details><summary style="cursor:pointer;font-size:12px;color:var(--muted);">提示词</summary>
          ${panel.video_prompt_original_zh ? `<pre style="margin-top:6px;font-size:11px;">${htmlEscape(panel.video_prompt_original_zh)}</pre>` : ''}
          ${panel.video_prompt ? `<pre style="margin-top:6px;font-size:11px;">${htmlEscape(panel.video_prompt)}</pre>` : ''}
        </details>`
      : '';
    return `<tr>
      <td style="font-weight:600;white-space:nowrap;">${htmlEscape(shotId)}</td>
      <td>${htmlEscape(panel.stage || '')}</td>
      <td>${htmlEscape(panel.duration || '')}</td>
      <td>${htmlEscape(pickReadable(parsed.scene || panel.scene_setting))}</td>
      <td>${htmlEscape(pickReadable(parsed.action || panel.visual_action))}</td>
      <td>${htmlEscape(pickReadable(parsed.product_state || panel.product_state))}</td>
      <td>${htmlEscape(pickReadable(parsed.camera || panel.camera_movement))}</td>
      <td>${htmlEscape(pickReadable(parsed.expression || panel.expression_focus))}</td>
      <td>${htmlEscape(pickReadable(parsed.voiceover || panel.optional_voiceover_local, ''))}</td>
      <td>${htmlEscape(pickReadable(parsed.continuity || panel.continuity_requirements))}</td>
      <td>${detail || '<span class="muted">—</span>'}</td>
      <td>${thumb}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap">
    <table>
      <thead><tr>
        <th>镜头</th><th>阶段</th><th>时长</th><th>场景</th><th>画面内容</th>
        <th>产品展示</th><th>镜头运动</th><th>核心表达</th><th>口播参考</th>
        <th>连续性要求</th><th>提示词</th><th>分镜图</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function getContextPathFromRequestUrl(urlString) {
  const url = new URL(urlString, `http://${HOST}:${PORT}`);
  const fileName = String(url.searchParams.get('context') || '').trim();
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
    return '';
  }
  const contextPath = normalizeReviewContextPath(path.join(REVIEW_CONTEXT_ROOT, fileName));
  if (!contextPath.startsWith(REVIEW_CONTEXT_ROOT)) {
    return '';
  }
  return contextPath;
}

function getLatestProjectId() {
  return String(getLatestProjectState().project_id || '').trim();
}

function shouldRedirectOldProjectPage(reqUrl, projectId) {
  const url = new URL(reqUrl, `http://${HOST}:${PORT}`);
  if (url.searchParams.get('allow_old') === '1') return false;
  const latestProjectId = getLatestProjectId();
  return Boolean(projectId && latestProjectId && projectId !== latestProjectId);
}

function latestProjectRouteFallback() {
  const latestProjectId = getLatestProjectId();
  return latestProjectId ? getActiveRoute(latestProjectId) : '/';
}

function renderReviewDetailPage(contextPath) {
  const context = readContextFile(contextPath);
  const panels = Array.isArray(context.panel_review_pack) ? context.panel_review_pack : [];
  const projectId = context.project_id || path.basename(contextPath);
  const productName = context.product_name || '';
  const reviewRound = Number(context.review_round || 1);

  // P17-C1: stale banner for invalidated video
  const _rdProjState = readProjectState(projectId);
  const _videoInvalidatedAt = _rdProjState.video_invalidated_at || _rdProjState.storyboard_invalidated_at || '';
  const _rdStaleBanner = _videoInvalidatedAt
    ? `<div class="card" style="background:rgba(251,191,36,.06);border:1px solid #fbbf24;">
        <p style="margin:0;color:#fcd34d;font-size:13px;">⚠ <strong>分镜已更新，旧视频已过期。</strong> 请重新确认分镜图以生成新视频；旧视频不作为当前结果展示。</p>
       </div>`
    : '';

  const panelCards = panels.length
    ? panels.map((panel) => {
        const title = panel.shot_id || `shot_${panel.shot_order || ''}`;
        const meta = [panel.shot_order != null ? `顺序：${panel.shot_order}` : '', panel.stage || '', panel.duration || ''].filter(Boolean).join(' · ');
        const _imgSrc = panel.panel_preview_path
          ? `/local-file?path=${encodeURIComponent(panel.panel_preview_path)}`
          : (panel.panel_preview_url ? normalizeAssetUrl(panel.panel_preview_url) : null);
        const img = _imgSrc
          ? `<img src="${htmlEscape(_imgSrc)}" loading="lazy" style="width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:var(--r);border:1px solid var(--border);display:block;" />`
          : '<div style="aspect-ratio:9/16;border-radius:var(--r);border:1px solid var(--border);background:#f1f0ef;display:flex;align-items:center;justify-content:center;color:var(--muted);">暂无预览图</div>';
        return `<div class="card" style="display:grid;grid-template-columns:160px 1fr;gap:16px;">
          <div>${img}</div>
          <div>
            <h3 style="margin-bottom:4px;">${htmlEscape(title)}</h3>
            <p class="muted" style="font-size:12px;margin:0 0 10px;">${htmlEscape(meta)}</p>
            <details>
              <summary style="cursor:pointer;font-size:13px;color:var(--muted);">Video Prompt</summary>
              <pre style="margin-top:8px;">${htmlEscape(panel.video_prompt || '')}</pre>
            </details>
          </div>
        </div>`;
      }).join('')
    : '<div class="card"><p class="muted">这个审核包里没有可展示的分镜，请回到列表页重新刷新。</p></div>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>分镜审核 — ${htmlEscape(projectId)}</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('storyboard', path.basename(contextPath))}
  <main>
    ${_rdStaleBanner}
    <div class="card">
      <h1 style="margin-bottom:4px;">${htmlEscape(projectId)}</h1>
      <p class="muted" style="margin:0 0 10px;">产品：${htmlEscape(productName || '未填写')} · 第 ${reviewRound} 轮审核</p>
      <div class="btn-row">
        <a class="btn btn-secondary" href="/reviews">返回列表</a>
        <a class="btn btn-secondary" href="/script-review?context=${encodeURIComponent(path.basename(contextPath))}">脚本框架</a>
        <a class="btn btn-secondary" href="/active?project_id=${encodeURIComponent(projectId)}">当前项目</a>
        <a class="btn btn-secondary" href="/">工作台</a>
        <button type="button" class="btn btn-secondary" data-project-id="${htmlEscape(projectId)}" onclick="!function(b){if(b.dataset.s)return;b.dataset.s=1;var t=b.textContent,p=b.dataset.projectId;b.disabled=true;b.textContent='同步中…';fetch('/api/reconcile-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:p})}).then(function(r){return r.json()}).then(function(d){if(!d.ok){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包';return}if(d.activeRoute&&d.activeRoute!==window.location.pathname+window.location.search){b.textContent='已同步当前项目状态';setTimeout(function(){window.location.href=d.activeRoute},600);return}b.textContent=(d.patched&&d.patched.length)?'已同步当前项目状态':'未发现新的生成结果';setTimeout(function(){b.disabled=false;delete b.dataset.s;b.textContent=t},3000)}).catch(function(){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包'})}(this)">同步当前项目状态</button>
      </div>
    </div>
    <div class="card">
      <h2>脚本框架预览</h2>
      <p class="muted" style="font-size:12px;margin:0 0 8px;">这里展示每个镜头的脚本骨架，用来核对分镜图是否贴合短视频结构。</p>
      ${renderShotScriptAndPromptCards(panels)}
    </div>
    ${panelCards}
    <div class="card">
      <h2>确认分镜图</h2>
      <p class="muted" style="font-size:13px;margin:0 0 12px;">确认后系统开始逐镜生成视频。如对分镜效果不满意，可点击下方「重新生成分镜图」重新触发分镜生成。</p>
      <form method="POST" action="/review-submit">
        <input type="hidden" name="review_context_path" value="${htmlEscape(contextPath)}" />
        <input type="hidden" name="review_round" value="${reviewRound}" />
        <input type="hidden" name="project_id" value="${htmlEscape(projectId)}" />
        <input type="hidden" name="product_name" value="${htmlEscape(productName)}" />
        <input type="hidden" name="review_decision" value="确认通过" />
        <button class="btn btn-primary" type="submit" style="width:100%;"
          onclick="if(!confirm('确认分镜图，开始生成 ${panels.length} 段视频？'))return false;this.disabled=true;this.textContent='视频生成中…请稍候';this.form.submit();">✅ 确认分镜图 → 开始生成视频</button>
      </form>
      <form method="POST" action="/review-submit" style="margin-top:10px;">
        <input type="hidden" name="review_context_path" value="${htmlEscape(contextPath)}" />
        <input type="hidden" name="review_round" value="${reviewRound}" />
        <input type="hidden" name="project_id" value="${htmlEscape(projectId)}" />
        <input type="hidden" name="product_name" value="${htmlEscape(productName)}" />
        <input type="hidden" name="review_decision" value="重做" />
        <button class="btn btn-secondary" type="submit" style="width:100%;"
          onclick="if(!confirm('重新生成分镜图会使当前视频片段和最终成片失效，是否继续？'))return false;this.disabled=true;this.textContent='重新生成中…请稍候';return true;">🔄 重新生成分镜图</button>
      </form>
    </div>
  </main>
</body>
</html>`;
}

function renderSubmitResultPage({ ok, message, contextPath = '', executionId = '' }) {
  const title = ok ? '审核结果已提交' : '审核提交失败';
  const contextParam = contextPath ? `?context=${encodeURIComponent(path.basename(contextPath))}` : '';
  const refresh = ok ? `<meta http-equiv="refresh" content="1; url=/review-status${contextParam}" />` : '';
  const okMessage = message || '工作流已收到审核结论，页面会自动跳转到状态页。';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${refresh}
  <title>${htmlEscape(title)}</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('video', contextPath ? path.basename(contextPath) : '')}
  <main style="max-width:680px;">
    <div class="card">
      <h1>${htmlEscape(title)}</h1>
      ${ok ? `<div class="alert-ok" style="margin-bottom:12px;">${htmlEscape(okMessage)}</div><p class="muted">页面会自动进入视频状态页，那里会显示每个镜头的生成状态。</p>` : `<p class="muted">${htmlEscape(message || '')}</p>`}
      ${executionId ? `<p>续跑执行 ID：<code>${htmlEscape(String(executionId))}</code></p>` : ''}
      ${contextPath ? `<p class="muted" style="font-size:12px;">上下文：<code>${htmlEscape(contextPath)}</code></p>` : ''}
      <div class="btn-row">
        ${ok ? `<a class="btn btn-primary" href="/review-status${contextParam}">查看状态</a>` : ''}
        <a class="btn btn-secondary" href="/reviews">返回列表</a>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function renderFinalVideoPage(contextPath) {
  const context = readContextFile(contextPath);
  const projectId = context.project_id || path.basename(contextPath);
  const productName = context.product_name || '';
  const rawProgress = readProgressFile(projectId);
  const execution = findLatestExecutionForProject(projectId);
  const progress = hydrateProgressFromExecutionError(contextPath, rawProgress, execution);
  const panelPack = Array.isArray(context.panel_review_pack) ? context.panel_review_pack : [];
  const runSummary = buildRunContextSummary(projectId);
  const projectState = readProjectState(projectId);
  const finalInvalidatedAt = String(projectState.final_invalidated_at || projectState.video_invalidated_at || '').trim();
  const finalInvalidatedMs = finalInvalidatedAt ? new Date(finalInvalidatedAt).getTime() : 0;
  const isFreshAfterFinalInvalidation = (filePath) => {
    if (!finalInvalidatedMs) return true;
    try { return fs.statSync(filePath).mtimeMs > finalInvalidatedMs; } catch { return false; }
  };
  const finalMergedVideoPathRaw = String(progress.final_merged_video_path || '').trim();
  const finalMergedVideoPath = finalMergedVideoPathRaw && isFreshAfterFinalInvalidation(finalMergedVideoPathRaw)
    ? finalMergedVideoPathRaw
    : '';
  const reviewRound = Number(context.review_round || 1);
  const finalOutputInfo = resolveFinalOutputDisplay(projectId, finalMergedVideoPath, isFreshAfterFinalInvalidation, projectState);

  // Build shot status map from progress
  const shotProgressMap = {};
  if (Array.isArray(rawProgress.shots)) {
    for (const shot of rawProgress.shots) shotProgressMap[String(shot.shot_id || '')] = shot;
  }

  // All shot videos
  const shotVideos = listProjectVideoFiles(projectId);

  const findShotVideo = (panel, i) => {
    const shotId = String(panel.shot_id || `shot_${i + 1}`);
    const order = String(panel.shot_order || i + 1);
    const paddedOrder = order.padStart(2, '0');
    const shotProg = shotProgressMap[shotId] || {};
    const progressVideoPath = String(shotProg.video_path || '').trim();
    if (progressVideoPath && fs.existsSync(progressVideoPath) && fs.statSync(progressVideoPath).isFile()) {
      return progressVideoPath;
    }
    return shotVideos.find((videoPath) => {
      const name = path.basename(videoPath).toLowerCase();
      if (name.startsWith(`kie_veo31_${String(projectId).toLowerCase()}_${order}_`)) return true;
      if (name.includes(`shot_${paddedOrder}`) || name.includes(`shot-${paddedOrder}`)) return true;
      if (name.includes(`_${paddedOrder}_`) || name.includes(`_${order}_`)) return true;
      return /^shot[_-]/i.test(shotId) && name.includes(shotId.toLowerCase());
    }) || '';
  };

  // Shot list with script summary and generated video preview.
  const finalShotStatusLabels = { pending:'待开始', running:'Veo 排队中', processing:'Veo 处理中', submitted:'Veo 已提交', completed:'已完成', done:'已完成', failed:'失败' };
  const finalShotBadgeCls = { pending:'badge-todo', running:'badge-running', processing:'badge-running', submitted:'badge-running', completed:'badge-done', done:'badge-done', failed:'badge-failed' };
  const panelRows = panelPack.map((panel, i) => {
    const zhFields = parseZhPromptFields(panel.video_prompt_original_zh || '');
    const scene = zhFields.scene || panel.scene || '';
    const action = zhFields.action || '';
    const shotId = String(panel.shot_id || `shot_${i + 1}`);
    const shotProg = shotProgressMap[shotId] || {};
    const videoPath = findShotVideo(panel, i);
    const shotStatus = String(shotProg.status || (videoPath ? 'completed' : 'pending'));
    const shotBadge = `<span class="badge ${finalShotBadgeCls[shotStatus] || 'badge-todo'}" style="font-size:11px;">${finalShotStatusLabels[shotStatus] || shotStatus}</span>`;
    return `<div class="shot-row" style="font-size:13px;display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:16px;align-items:start;">
      <div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
          <strong style="white-space:nowrap;">镜头 ${i + 1}</strong>
          <span class="muted" style="font-size:12px;">${htmlEscape(shotId)}</span>
          ${panel.duration ? `<span class="muted" style="font-size:12px;">${htmlEscape(String(panel.duration).replace(/s+$/i, ''))}s</span>` : ''}
          ${shotBadge}
        </div>
        ${scene ? `<div style="font-size:12px;margin-top:4px;"><span style="color:var(--muted);font-weight:600;">场景：</span>${htmlEscape(scene)}</div>` : ''}
        ${action ? `<div style="font-size:12px;"><span style="color:var(--muted);font-weight:600;">动作：</span>${htmlEscape(action)}</div>` : ''}
        ${['completed', 'done', 'failed'].includes(shotStatus) ? `<form method="POST" action="/review-rerun-shot" style="margin-top:8px;">
          <input type="hidden" name="review_context_path" value="${htmlEscape(contextPath)}" />
          <input type="hidden" name="project_id" value="${htmlEscape(projectId)}" />
          <input type="hidden" name="product_name" value="${htmlEscape(productName)}" />
          <input type="hidden" name="review_round" value="${htmlEscape(String(reviewRound))}" />
          <input type="hidden" name="shot_id" value="${htmlEscape(shotId)}" />
          <input type="hidden" name="shot_order" value="${htmlEscape(String(panel.shot_order || i + 1))}" />
          <input type="hidden" name="cost_confirmed" value="1" />
          <button class="btn btn-secondary" type="submit" style="padding:6px 10px;font-size:12px;" onclick="if(!confirm('⚠️ ${shotStatus === 'failed' ? '重做失败镜头会再次消耗 credits。' : '该镜头已生成成功，重新生成会消耗一次视频额度。'}\\n\\n镜头：${htmlEscape(shotId)}\\n\\n确认继续？')) return false; this.disabled=true; this.textContent='已提交，生成中…'; this.form.submit(); return false;">${shotStatus === 'failed' ? '重做失败镜头' : '重新生成此镜头'}</button>
        </form>` : ''}
      </div>
      <div>
        ${videoPath
          ? `<video src="${htmlEscape(localFileAssetUrl(videoPath))}" controls playsinline style="width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:10px;border:1px solid var(--border);background:#0f172a;"></video>
             <div class="muted" style="font-size:11px;word-break:break-all;margin-top:4px;">${htmlEscape(path.basename(videoPath))}</div>`
          : `<div style="height:180px;border:1px dashed var(--border-strong);border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;background:var(--bg);">等待生成</div>`}
      </div>
    </div>`;
  }).join('') || '<p class="muted">无分镜数据</p>';

  const finalVideoBlock = finalOutputInfo.hasUserFinal
    ? `<div id="final-path-list">${finalOutputInfo.userFinals.map((f) => `<div class="alert-ok" style="word-break:break-all;">${htmlEscape(f)}</div>`).join('')}</div>
       <div id="final-export-status" class="alert-ok" style="margin-top:8px;">已导出到本地输出文件夹</div>`
    : (finalOutputInfo.needsExport
      ? `<div id="final-path-list"></div>
         <div id="final-export-status" class="alert-ok" data-auto-export="1" data-project-id="${htmlEscape(projectId)}" style="word-break:break-word;">最终成片已生成，正在导出到输出文件夹...</div>`
      : '<p class="muted">最终成片尚未生成（视频生成完成后会出现在这里）。</p>');
  const staleFinalBanner = finalInvalidatedAt && !finalOutputInfo.hasInternalFinal && !finalOutputInfo.hasUserFinal
    ? `<div class="alert-err" style="margin-bottom:12px;">旧成片已失效：项目已重新生成分镜或视频，请等待新视频完成后再查看当前结果。用户输出目录中的旧文件不会被删除。</div>`
    : '';
  const finalStageLabel = finalOutputInfo.hasUserFinal
    ? '最终成片已导出'
    : (finalOutputInfo.hasInternalFinal ? '最终成片已生成' : '最终成片尚未生成');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>最终成片 — ${htmlEscape(projectId)}</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('final', path.basename(contextPath))}
	  <main>
	    <div class="card">
		      <h1 style="margin-bottom:4px;">最终成片</h1>
		      ${staleFinalBanner}
		      <p class="muted" style="margin:0 0 10px;"><strong>${htmlEscape(projectId)}</strong> · 产品：${htmlEscape(productName || '未填写')}</p>
	      <p class="muted" style="margin:0 0 12px;">当前阶段：<strong>${htmlEscape(finalStageLabel)}</strong></p>
	      <h2 style="font-size:15px;margin-bottom:8px;">成片文件路径</h2>
	      ${finalVideoBlock}
      <div class="btn-row" style="margin-top:12px;">
        <a class="btn btn-secondary" href="/review-status?context=${encodeURIComponent(path.basename(contextPath))}">视频生成状态</a>
        <a class="btn btn-secondary" href="/active?project_id=${encodeURIComponent(projectId)}">项目管理</a>
        <a class="btn btn-secondary" href="/">工作台</a>
        <button type="button" class="btn btn-secondary" data-project-id="${htmlEscape(projectId)}" onclick="!function(b){if(b.dataset.s)return;b.dataset.s=1;var t=b.textContent,p=b.dataset.projectId;b.disabled=true;b.textContent='同步中…';fetch('/api/reconcile-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:p})}).then(function(r){return r.json()}).then(function(d){if(!d.ok){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包';return}if(d.activeRoute&&d.activeRoute!==window.location.pathname+window.location.search){b.textContent='已同步当前项目状态';setTimeout(function(){window.location.href=d.activeRoute},600);return}b.textContent=(d.patched&&d.patched.length)?'已同步当前项目状态':'未发现新的生成结果';setTimeout(function(){b.disabled=false;delete b.dataset.s;b.textContent=t},3000)}).catch(function(){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包'})}(this)">同步当前项目状态</button>
        <button class="btn btn-primary" id="export-proj-btn" data-project-id="${htmlEscape(projectId)}" onclick="exportProject(this)">导出本项目文件</button>
        <button class="btn btn-secondary" id="open-output-folder-btn" onclick="openOutputFolderFinal(this)">打开输出文件夹</button>
      </div>
      <div id="export-result" style="display:none;margin-top:10px;font-size:13px;padding:10px 14px;border-radius:8px;line-height:1.7;"></div>
    </div>
    <div class="card">
      <h2>单镜头视频检查</h2>
      <p class="muted" style="font-size:12px;margin:0 0 12px;">每个镜头的视频会显示在对应脚本右侧，方便直接核对画面是否符合脚本。</p>
      ${panelRows}
    </div>
  </main>
  <script>
  function escapeHtmlClient(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safeExportError(s) {
    var t = String(s || '未知错误');
    t = t.replace(/\\/(?:Users|private|var|tmp|Volumes|Library|Applications|System)(?:\\/[^<>"'\\n\\r\\t，。；;]{1,120})+/g, '路径已隐藏');
    t = t.replace(/(?:key|token|secret|bearer|authorization|password|credential)[^，。；\\n\\r<>]{0,120}/gi, '[已脱敏]');
    if (t.length > 120) t = t.slice(0, 120) + '…';
    return t;
  }
  async function exportProject(btn) {
    var projId = btn.dataset.projectId || '';
    const resultEl = document.getElementById('export-result');
    const origText = btn.textContent;
    const show = (html, ok) => {
      resultEl.innerHTML = html;
      resultEl.style.display = 'block';
      resultEl.style.background = ok ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)';
      resultEl.style.border = ok ? '1px solid rgba(34,197,94,.25)' : '1px solid rgba(239,68,68,.25)';
      resultEl.style.color = ok ? '#16a34a' : '#ef4444';
    };
    if (!projId) {
      show('导出失败：未找到当前项目 ID', false);
      return;
    }
    btn.disabled = true;
    btn.textContent = '导出中…';
    resultEl.style.display = 'none';
    try {
      const r = await fetch('/api/export-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projId })
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        show('导出失败：' + escapeHtmlClient(safeExportError(d.error || '服务器错误，请重试')), false);
        btn.disabled = false; btn.textContent = origText; return;
      }
      const copiedN = (d.copied || []).length;
      const skippedN = (d.skipped || []).length;
      const errorsN = (d.errors || []).length;
      if (copiedN === 0 && skippedN === 0 && errorsN === 0) {
        show('当前项目暂无可导出的文件', false);
        btn.disabled = false; btn.textContent = origText; return;
      }
      let html = '<strong>已导出到本地输出文件夹</strong>';
      html += '　已复制 <strong>' + copiedN + '</strong> 个';
      if (skippedN) html += '　已跳过 <strong>' + skippedN + '</strong> 个（已存在）';
      if (errorsN) {
        html += '　<span style="color:#ef4444;">失败 <strong>' + errorsN + '</strong> 个</span>';
        const errMsgs = (d.errors || []).slice(0, 3).map(function(e) {
          return escapeHtmlClient(safeExportError(e.error || String(e)));
        });
        html += '<div style="margin-top:6px;font-size:12px;color:#ef4444;">' + errMsgs.join('<br>') + '</div>';
      }
      show(html, errorsN === 0);
      if (errorsN > 0) { btn.disabled = false; btn.textContent = origText; }
      else { btn.textContent = copiedN > 0 ? '✅ 已导出' : '✅ 已导出（已是最新）'; }
    } catch(e) {
      show('导出失败：' + escapeHtmlClient(safeExportError(e.message)), false);
      btn.disabled = false; btn.textContent = origText;
    }
  }
  async function autoExportFinalIfNeeded() {
    const statusEl = document.getElementById('final-export-status');
    const pathListEl = document.getElementById('final-path-list');
    if (!statusEl || statusEl.dataset.autoExport !== '1') return;
    const projId = statusEl.dataset.projectId || '';
    if (!projId) return;
    try {
      const r = await fetch('/api/export-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projId })
      });
      const d = await r.json();
      if (!r.ok || d.error || d.ok === false) throw new Error(d.error || '导出失败');
      const handled = [].concat(d.copied || [], d.skipped || []);
      const finalPaths = handled
        .map(function(item) { return String(item.dest || ''); })
        .filter(function(p) { return /\\/Final\\/final_[^/]+\\.mp4$/i.test(p) || /\\/Final\\/[^/]+\\.mp4$/i.test(p); });
      if (finalPaths.length && pathListEl) {
        pathListEl.innerHTML = finalPaths.map(function(p) {
          return '<div class="alert-ok" style="word-break:break-all;">' + escapeHtmlClient(p) + '</div>';
        }).join('');
      }
      statusEl.textContent = '已导出到本地输出文件夹';
      delete statusEl.dataset.autoExport;
    } catch(e) {
      statusEl.className = 'alert-err';
      statusEl.textContent = '导出到输出文件夹失败，请点击“导出本项目文件”重试。';
    }
  }
  async function openOutputFolderFinal(btn) {
    const resultEl = document.getElementById('export-result');
    const origText = btn ? btn.textContent : '';
    const showRes = (html, ok) => {
      resultEl.innerHTML = html;
      resultEl.style.display = 'block';
      resultEl.style.background = ok ? 'rgba(34,197,94,.08)' : 'rgba(239,68,68,.08)';
      resultEl.style.border = ok ? '1px solid rgba(34,197,94,.25)' : '1px solid rgba(239,68,68,.25)';
      resultEl.style.color = ok ? '#16a34a' : '#ef4444';
    };
    let _d = null;
    try {
      if (btn) { btn.disabled = true; btn.textContent = '正在打开输出文件夹...'; }
      showRes('正在打开输出文件夹...', true);
      const _r = await fetch('/api/output-folder-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'open', target: 'final' })
      });
      _d = await _r.json();
      if (!_d.ok) throw new Error(_d.error || '操作失败');
      showRes('已打开输出文件夹。', true);
    } catch(e) {
      var pathLine = '';
      if (_d && _d.path) {
        pathLine = '<br><code style="user-select:all;word-break:break-all;">' + escapeHtmlClient(_d.path) + '</code>';
      }
      showRes('打开失败，请复制以下路径手动打开：' + pathLine, false);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = origText || '打开输出文件夹'; }
    }
  }
  document.addEventListener('DOMContentLoaded', autoExportFinalIfNeeded);
  </script>
</body>
</html>`;
}

// P12-H1b-B: reconcile stale in-flight shots after a successful execution.
// Only running/submitted/processing shots are reset to pending. A failed shot
// (including audio_generation_failure) is NEVER downgraded to pending — it stays
// failed until an explicit user rerun (/review-rerun-shot) or rerun_failed_only flow.
function reconcileStaleShotStatus(shot, executionSucceeded) {
  if (!executionSucceeded) return shot;
  const s = String(shot.status || 'pending').toLowerCase();
  if (s === 'failed') return shot; // never downgrade a failed shot to pending
  if (s === 'running' || s === 'submitted' || s === 'processing') return { ...shot, status: 'pending' };
  return shot;
}

function renderReviewStatusPage(contextPath) {
  const context = readContextFile(contextPath);
  const projectId = context.project_id || path.basename(contextPath);
  const productName = context.product_name || '';
  const reviewRound = Number(context.review_round || 1);
  const submittedPath = submittedSidecarPath(contextPath);
  const submitted = fs.existsSync(submittedPath) ? readContextFile(submittedPath) : {};
  const rawProgress = readProgressFile(projectId);
  const execution = findLatestExecutionForProject(projectId);
  const executionFailed = execution?.status === 'error' || execution?.status === 'crashed';
  const progress = hydrateProgressFromExecutionError(contextPath, rawProgress, execution);
  const videos = listProjectVideoFiles(projectId);
  const panelPack = Array.isArray(context.panel_review_pack) ? context.panel_review_pack : [];
  const totalPanels = Number(progress.total_panels || context.panel_count || panelPack.length || 0);
  const rawShots = Array.isArray(progress.shots) && progress.shots.length
    ? progress.shots
    : panelPack.map((panel) => ({ shot_id: panel.shot_id || `shot_${panel.shot_order || ''}`, shot_order: panel.shot_order || '', status: 'pending', video_path: '', operation_name: '' }));
  const rawIsPaused = Boolean(progress.paused || submitted.paused);
  const executionErrorSummary = executionFailed ? readExecutionErrorSummary(execution.id) : '';
  const isPauseStopError = /项目已暂停|不再提交新视频任务|paused/i.test(executionErrorSummary);
  const hasRealProgress = Array.isArray(rawProgress.shots) && rawProgress.shots.length > 0;
  const shotsWithDetectedVideos = rawShots.map((shot) => {
    const existingVideoPath = String(shot.video_path || '').trim();
    const detectedVideoPath = existingVideoPath && fs.existsSync(existingVideoPath)
      ? existingVideoPath
      : findProjectVideoForShot(projectId, videos, shot);
    return detectedVideoPath
      ? { ...shot, status: 'completed', video_path: detectedVideoPath, error: '' }
      : shot;
  });
  const _execSucceeded = execution?.status === 'success' && !rawIsPaused;
  const shots = shotsWithDetectedVideos.map((shot) => reconcileStaleShotStatus(shot, _execSucceeded));
  const completedCount = shots.filter((s) => String(s.status || '') === 'completed').length || Number(progress.completed_count || 0) || videos.length || 0;
  const runningCount = execution?.status === 'success' ? 0 : shots.filter((s) => ['running', 'submitted', 'processing'].includes(String(s.status || ''))).length || Number(progress.running_count || 0);
  const failedCount = shots.filter((s) => String(s.status || '') === 'failed').length || Number(progress.failed_count || 0);
  const pendingCount = Math.max(totalPanels - completedCount - runningCount - failedCount, 0);
  const allClipsComplete = completedCount >= totalPanels && totalPanels > 0;
  const isPaused = rawIsPaused && !allClipsComplete;
  const percent = totalPanels ? Math.min(100, Math.round((completedCount / totalPanels) * 100)) : 0;
  const failedShots = shots.filter((s) => String(s.status || '') === 'failed');
  const finalMergedVideoPath = String(progress.final_merged_video_path || '').trim();
  const rebuiltFailureSummary = failedShots.map((s) => `${s.shot_id}: ${s.error || '未知'}`).join(' | ');
  const rawFS = String(progress.failure_reasons_summary || '').trim();
  const failureSummary = rawFS && !rawFS.includes('续跑执行报错') ? rawFS : rebuiltFailureSummary || rawFS;
  const runSummary = buildRunContextSummary(projectId);
  const hasSubmissionRecord = Boolean(submitted.submittedAt);
  const videoSubmissionMissing = hasSubmissionRecord && !execution?.id && !hasRealProgress && videos.length === 0;
  let statusText = progress.status || execution?.status || (fs.existsSync(submittedPath) ? 'submitted' : 'pending_review');
  if (videoSubmissionMissing) statusText = 'submit_missing';
  if (isPaused || isPauseStopError) statusText = 'paused';
  if (progress.rerun_failed_only && execution?.status === 'success' && runningCount === 0 && videos.length) statusText = 'rerun_success';
  else if (execution?.status === 'success' && runningCount === 0 && completedCount > 0) statusText = completedCount >= totalPanels && totalPanels > 0 ? 'success' : 'partial_success';
  // P13-B1: clips complete but final merge failed → never present as success. Stage stays
  // video_clips_generated (no final file); surface an explicit merge-failure status/banner.
  const _finalMergeFailedState = completedCount >= totalPanels && totalPanels > 0 && !finalMergedVideoPath
    && (progress.final_merge_failed === true || String(progress.final_merge_error || '').trim() !== '');
  if (_finalMergeFailedState) statusText = 'final_merge_failed';
  const statusLabels = { pending_review:'等待审核提交', submitted:'视频生成已提交', submit_missing:'视频生成未提交成功', running:'视频生成中', processing:'视频生成中', waiting:'等待下一步/轮询', pending:'等待开始', partial_success:'部分完成', success:'视频生成完成', done:'视频生成完成', error:'视频生成失败', crashed:'视频生成失败', failed:'生成失败', paused:'已暂停', review_rejected:'审核未通过，等待重做', rerun_success:'失败镜头重跑完成', final_merge_failed:'视频片段已生成，最终合成失败' };
  const exStatusLabels = { success:'成功', error:'失败', running:'运行中', processing:'处理中', waiting:'等待中', crashed:'崩溃', canceled:'已取消', new:'新建' };
  const shotStatusLabels = { pending:'待开始', running:'Veo 排队中', processing:'Veo 处理中', submitted:'Veo 已提交', completed:'已完成', done:'已完成', failed:'失败' };
  const shotStageMap = {
    pending:   { pct: 0,   color: 'var(--border-strong)' },
    running:   { pct: 40,  color: 'var(--accent)' },
    processing: { pct: 60,  color: 'var(--accent)' },
    submitted: { pct: 70,  color: 'var(--accent)' },
    completed: { pct: 100, color: 'var(--success)' },
    failed:    { pct: 100, color: 'var(--danger)' },
  };
  const refreshMeta = isPaused ? '' : '<meta http-equiv="refresh" content="8" />';
  // C-fix: hide "继续生成剩余镜头" when n8n execution is already running/waiting
  const _veoActiveGen = !isPaused && execution && ['running', 'waiting'].includes(String(execution?.status || ''));
  const _progressActiveGen = !isPaused && runningCount > 0;
  const canContinuePending = hasRealProgress && pendingCount > 0 && !_veoActiveGen && !_progressActiveGen && (!executionFailed || isPauseStopError || isPaused);
  const videoStatusFeedback = (_veoActiveGen || _progressActiveGen)
    ? `<div class="alert-ok" style="margin-bottom:12px;">视频正在生成中（执行 #${htmlEscape(String(execution?.id || ''))}），请勿重复提交。</div>`
    : videoSubmissionMissing
    ? `<div class="alert-err" style="margin-bottom:12px;">视频生成未提交成功，请同步当前项目状态或导出诊断包。</div>`
    : (hasSubmissionRecord && ['submitted', 'running', 'processing', 'waiting'].includes(String(statusText || ''))
        ? `<div class="alert-ok" style="margin-bottom:12px;">视频生成已提交，正在生成 ${htmlEscape(String(totalPanels || 6))} 个镜头，请勿重复点击。</div>`
        : ((statusText === 'success' || statusText === 'partial_success' || statusText === 'rerun_success')
            ? `<div class="alert-ok" style="margin-bottom:12px;">视频片段状态：已完成 ${htmlEscape(String(completedCount))}/${htmlEscape(String(totalPanels || completedCount || 0))}${finalMergedVideoPath ? '，最终成片已生成。' : '。'}</div>`
            : ''));
  // P13-B1: explicit Chinese error when all clips exist but final merge failed (ffmpeg unavailable / command failed).
  const finalMergeFailedBanner = _finalMergeFailedState
    ? `<div class="alert-err" style="margin-bottom:12px;">视频片段已生成，但最终合成失败。原因：ffmpeg 不可用 / 合成命令失败。请导出诊断包。${String(progress.final_merge_error || '').trim() ? `<br><span style="font-size:12px;opacity:.85;">详情：${htmlEscape(String(progress.final_merge_error).slice(0, 240))}</span>` : ''}</div>`
    : '';

  const panelPackByShot = {};
  for (const p of panelPack) { panelPackByShot[String(p.shot_id || '')] = p; }
  const rerunnableShots = shots.filter((shot) => ['completed', 'done', 'failed'].includes(String(shot.status || '')));
  const now = Date.now();
  // P17-C6: Veo slow/very-slow hints based on execution start time
  const _execStartMs = execution?.startedAt ? new Date(execution.startedAt).getTime() : 0;
  const _veoElapsedMs = _execStartMs > 0 ? now - _execStartMs : 0;
  const _showVeoSlowHint = runningCount > 0 && !isPaused && !executionFailed && _veoElapsedMs > 180000;
  const _showVeoVerySlowHint = _showVeoSlowHint && _veoElapsedMs > 360000;

  const shotRows = shots.map((shot) => {
    const s = String(shot.status || 'pending');
    const badgeCls = (s === 'completed' || s === 'done') ? 'badge-done' : ['running', 'submitted', 'processing'].includes(s) ? 'badge-running' : s === 'failed' ? 'badge-failed' : 'badge-todo';
    const stage = shotStageMap[s] || shotStageMap.pending;
    const elapsedMs = shot.last_started_at ? now - new Date(shot.last_started_at).getTime() : 0;
    const elapsedStr = ['running', 'submitted', 'processing'].includes(s) && elapsedMs > 0 ? formatElapsed(elapsedMs) : '';
    const panel = panelPackByShot[String(shot.shot_id || '')] || {};
    const zhFields = parseZhPromptFields(panel.video_prompt_original_zh || '');
    const hasZh = Object.keys(zhFields).length > 0;
    const zhLabels = { scene:'场景', action:'动作', product_state:'产品状态', camera:'运镜', expression:'情绪', voiceover:'旁白', continuity:'连续性' };
    const zhGrid = hasZh ? Object.entries(zhLabels).filter(([k]) => zhFields[k]).map(([k, label]) =>
      `<div style="font-size:12px;"><span style="color:var(--muted);font-weight:600;">${label}：</span>${htmlEscape(zhFields[k])}</div>`
    ).join('') : '';
    const vpEn = panel.video_prompt || '';
    const friendlyError = shot.error ? translateShotError(shot.error) : '';
    return `<div class="shot-row" style="font-size:13px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <strong>${htmlEscape(shot.shot_id || '')}</strong>
        <div style="display:flex;align-items:center;gap:8px;">
          ${elapsedStr ? `<span class="muted" style="font-size:11px;">${htmlEscape(elapsedStr)}</span>` : ''}
          <span class="badge ${badgeCls}">${htmlEscape(shotStatusLabels[s] || s)}</span>
        </div>
      </div>
      <div class="progress-track" style="height:5px;margin:0 0 4px;">
        <div class="progress-bar" style="width:${stage.pct}%;background:${stage.color};transition:width .4s ease;"></div>
      </div>
      <div class="muted" style="font-size:11px;margin-bottom:6px;">${stage.pct}%</div>
      ${hasZh ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;margin-bottom:6px;">${zhGrid}</div>` : ''}
      ${vpEn ? `<details style="margin-bottom:4px;"><summary style="font-size:12px;color:var(--muted);cursor:pointer;">Video Prompt (EN)</summary><pre style="margin-top:6px;font-size:11px;">${htmlEscape(vpEn)}</pre></details>` : ''}
      ${shot.operation_name ? `<details style="margin-bottom:4px;"><summary style="font-size:11px;color:var(--muted);cursor:pointer;">Task ID</summary><code style="font-size:11px;">${htmlEscape(shot.operation_name)}</code></details>` : ''}
      ${shot.video_path ? `<div class="muted" style="font-size:11px;">视频：<code>${htmlEscape(shot.video_path)}</code></div>` : ''}
      ${friendlyError ? `<div style="color:var(--danger);font-size:12px;margin-top:4px;">⚠ ${htmlEscape(friendlyError)}</div>` : ''}
      ${['completed', 'done', 'failed'].includes(s) ? `<form method="POST" action="/review-rerun-shot" style="margin-top:8px;">
        <input type="hidden" name="review_context_path" value="${htmlEscape(contextPath)}" />
        <input type="hidden" name="project_id" value="${htmlEscape(projectId)}" />
        <input type="hidden" name="product_name" value="${htmlEscape(productName)}" />
        <input type="hidden" name="review_round" value="${htmlEscape(String(reviewRound))}" />
        <input type="hidden" name="shot_id" value="${htmlEscape(String(shot.shot_id || ''))}" />
        <input type="hidden" name="shot_order" value="${htmlEscape(String(shot.shot_order || ''))}" />
        <input type="hidden" name="cost_confirmed" value="1" />
        <button class="btn btn-secondary" type="submit" style="padding:7px 10px;font-size:12px;" onclick="if(!confirm('⚠️ ${s === 'failed' ? '重做失败镜头会再次消耗 credits。' : '该镜头已生成成功，重新生成会消耗一次视频额度。'}\\n\\n镜头：${htmlEscape(String(shot.shot_id || '该镜头'))}\\n\\n确认继续？')) return false; this.disabled=true; this.textContent='已提交，生成中…'; this.form.submit(); return false;">${s === 'failed' ? '重做失败镜头' : '重新生成此镜头'}</button>
      </form>` : ''}
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${refreshMeta}
  <title>视频状态 — ${htmlEscape(projectId)}</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('video', path.basename(contextPath))}
  <main>
    <div class="card">
      <h1 style="margin-bottom:4px;">视频生成状态</h1>
	      <p class="muted" style="margin:0 0 4px;"><strong>${htmlEscape(projectId)}</strong> · 产品：${htmlEscape(productName || '未填写')} · 第 ${reviewRound} 轮</p>
	      <p style="margin:0 0 10px;">状态：<strong>${htmlEscape(statusLabels[statusText] || statusText)}</strong>${isPaused ? ' <span class="badge badge-todo">已暂停</span>' : ''}</p>
	      ${videoStatusFeedback}
	      ${finalMergeFailedBanner}
	      ${executionFailed && !isPauseStopError && !isPaused && completedCount === 0 ? `<div class="alert-err" style="margin-bottom:12px;padding:18px 20px;border-width:2px;">
	        <strong style="display:block;font-size:18px;margin-bottom:6px;">续跑执行失败</strong>
	        <div style="font-size:14px;line-height:1.7;">视频生成失败：${htmlEscape(failureSummary || executionErrorSummary || '请同步当前项目状态或导出诊断包。')}</div>
	      </div>` : executionFailed && !isPauseStopError && !isPaused && completedCount > 0 ? `<div style="background:rgba(251,191,36,.08);border:1px solid #fbbf24;border-radius:8px;padding:12px 16px;color:#fcd34d;font-size:13px;margin-bottom:12px;">⚠ 执行流程已结束，但部分镜头（${completedCount} 个）已完成。失败镜头可使用下方"重做此镜头"功能单独重新生成。</div>` : ''}
      ${isPaused ? `<div class="alert-ok" style="margin-bottom:12px;">
        项目已暂停：系统不会再提交后续新镜头。已经提交的视频任务可能会自然完成；点击「继续生成剩余镜头」会从待开始镜头继续。
      </div>` : ''}
      ${progress.rerun_failed_only ? `<p class="muted" style="font-size:12px;margin:0 0 10px;">模式：仅重跑失败镜头，其余镜头"待开始"是正常的。</p>` : ''}
      <div class="progress-track"><div class="progress-bar" style="width:${percent}%;"></div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 12px;font-size:13px;" class="muted">
        <span>总：${htmlEscape(String(totalPanels || 0))}</span>
        <span>完成：${htmlEscape(String(completedCount))}</span>
        <span>进行中：${htmlEscape(String(runningCount))}</span>
        <span>${progress.rerun_failed_only ? '未参与' : '待开始'}：${htmlEscape(String(pendingCount))}</span>
        <span>失败：${htmlEscape(String(failedCount))}</span>
      </div>
      ${_showVeoVerySlowHint ? `<div style="background:rgba(239,68,68,.08);border:1px solid #ef4444;border-radius:8px;padding:10px 14px;color:#fca5a5;font-size:13px;margin-bottom:12px;">⚠ 视频生成已超过 6 分钟。若某镜头长时间未更新，可能遇到 Veo 排队超时或服务暂时不稳定。可点击"重做此镜头"重新提交该镜头。</div>` : _showVeoSlowHint ? `<div style="background:rgba(251,191,36,.12);border:1px solid #fbbf24;border-radius:8px;padding:10px 14px;color:#fcd34d;font-size:13px;margin-bottom:12px;">⏱ Veo 视频生成较慢，可能正在排队。每个镜头通常需要 60–180 秒；多镜头同时生成时等待会更长。请继续等待，页面每 8 秒自动刷新。</div>` : ''}
      <p class="muted" style="font-size:12px;margin:0 0 12px;">重做视频会重新消耗 credits。提交后请等待当前任务完成；同一镜头生成中再次提交会被系统拦截。</p>
      <div class="btn-row">
        <a class="btn btn-secondary" href="/reviews">审核列表</a>
        <a class="btn btn-secondary" href="/active?project_id=${encodeURIComponent(projectId)}">当前项目</a>
        <a class="btn btn-secondary" href="/">工作台</a>
        <button type="button" class="btn btn-secondary" data-project-id="${htmlEscape(projectId)}" onclick="!function(b){if(b.dataset.s)return;b.dataset.s=1;var t=b.textContent,p=b.dataset.projectId;b.disabled=true;b.textContent='同步中…';fetch('/api/reconcile-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:p})}).then(function(r){return r.json()}).then(function(d){if(!d.ok){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包';return}if(d.activeRoute&&d.activeRoute!==window.location.pathname+window.location.search){b.textContent='已同步当前项目状态';setTimeout(function(){window.location.href=d.activeRoute},600);return}b.textContent=(d.patched&&d.patched.length)?'已同步当前项目状态':'未发现新的生成结果';setTimeout(function(){b.disabled=false;delete b.dataset.s;b.textContent=t},3000)}).catch(function(){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包'})}(this)">同步当前项目状态</button>
        ${canContinuePending ? `<form method="POST" action="/review-rerun-pending" style="display:contents;">
          <input type="hidden" name="review_context_path" value="${htmlEscape(contextPath)}" />
          <input type="hidden" name="project_id" value="${htmlEscape(projectId)}" />
          <input type="hidden" name="product_name" value="${htmlEscape(productName)}" />
          <input type="hidden" name="review_round" value="${htmlEscape(String(reviewRound))}" />
          <button class="btn btn-primary" type="submit">继续生成剩余镜头</button>
        </form>` : ''}
	        ${executionFailed && !hasRealProgress ? `<a class="btn btn-primary" href="/reviews/item?context=${encodeURIComponent(path.basename(contextPath))}">返回分镜审核重新生成</a>` : ''}
        ${failedShots.length ? `<form method="POST" action="/review-rerun-failed" style="display:contents;">
          <input type="hidden" name="review_context_path" value="${htmlEscape(contextPath)}" />
          <input type="hidden" name="project_id" value="${htmlEscape(projectId)}" />
          <input type="hidden" name="product_name" value="${htmlEscape(productName)}" />
          <input type="hidden" name="review_round" value="${htmlEscape(String(reviewRound))}" />
          <button class="btn btn-danger" type="submit" onclick="if(!confirm('⚠️ 重跑失败镜头会重新创建视频任务，可能再次消耗 credits。\n\n确认继续？')) return false; this.disabled=true; this.textContent='已提交，生成中…'; this.form.submit(); return false;">只重跑失败镜头</button>
        </form>` : ''}
        ${rerunnableShots.length ? `<form method="POST" action="/review-rerun-shot" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <input type="hidden" name="review_context_path" value="${htmlEscape(contextPath)}" />
          <input type="hidden" name="project_id" value="${htmlEscape(projectId)}" />
          <input type="hidden" name="product_name" value="${htmlEscape(productName)}" />
          <input type="hidden" name="review_round" value="${htmlEscape(String(reviewRound))}" />
          <input type="hidden" name="shot_order" id="rrShotOrder" value="${htmlEscape(String(rerunnableShots[0]?.shot_order || ''))}" />
          <input type="hidden" name="cost_confirmed" value="1" />
          <select name="shot_id" class="input" style="width:auto;min-width:130px;padding:10px 12px;" onchange="var o=document.getElementById('rrShotOrder');if(o)o.value=this.selectedOptions[0]?.dataset.order||'';">
            ${rerunnableShots.map((shot) => `<option value="${htmlEscape(String(shot.shot_id || ''))}" data-order="${htmlEscape(String(shot.shot_order || ''))}">${htmlEscape(String(shot.shot_id || '镜头'))} · ${htmlEscape(shotStatusLabels[String(shot.status || '')] || String(shot.status || ''))}</option>`).join('')}
          </select>
          <button class="btn btn-secondary" type="submit" onclick="if(!confirm('⚠️ 重做此镜头只会重新生成该段视频，首帧/分镜图不会改变。失败镜头为重做、已成功镜头为质量重抽：重新生成会消耗一次视频额度。\n\n确认继续？')) return false; this.disabled=true; this.textContent='已提交，生成中…'; this.form.submit(); return false;">重做此镜头视频</button>
        </form>` : ''}
        <form method="POST" action="/review-pause-project" style="display:contents;">
          <input type="hidden" name="review_context_path" value="${htmlEscape(contextPath)}" />
          <input type="hidden" name="project_id" value="${htmlEscape(projectId)}" />
          <button class="btn btn-secondary" type="submit" title="暂停后不再提交后续新镜头到 Veo。已提交的单个镜头仍会继续完成。" onclick="return confirm('暂停后，系统不再提交后续新镜头到视频生成队列。\n已提交的镜头仍会继续自然完成，无法立即取消。\n\n确认暂停？');">⏸ 暂停后续提交</button>
        </form>
      </div>
      <details style="margin-top:10px;">
        <summary style="font-size:12px;color:var(--muted);cursor:pointer;padding:4px 0;">执行详情 / 高级信息</summary>
        <div style="margin-top:10px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 18px;font-size:12px;" class="muted">
          <p style="margin:0;">执行编号：<code>${htmlEscape(execution?.id ?? '未找到')}</code></p>
          <p style="margin:0;">执行状态：<code>${htmlEscape(exStatusLabels[execution?.status] || execution?.status || '未找到')}</code></p>
          <p style="margin:0;">审核结论：<code>${htmlEscape(submitted?.review_decision ?? '')}</code></p>
          <p style="margin:0;">需重做：<code>${htmlEscape(submitted?.bad_shot_ids ?? '无')}</code></p>
          <p style="margin:0;">开始：<code>${htmlEscape(execution?.startedAt ?? '')}</code></p>
          <p style="margin:0;">结束：<code>${htmlEscape(execution?.stoppedAt ?? '')}</code></p>
        </div>
        <p style="font-size:12px;margin:8px 0 0;" class="muted">视频目录：<code>${htmlEscape(VIDEO_OUTPUT_ROOT)}</code></p>
        ${finalMergedVideoPath ? `<p style="font-size:12px;margin:4px 0 0;"><strong>最终成片：</strong><code>${htmlEscape(finalMergedVideoPath)}</code></p>` : ''}
      </details>
      <p class="muted" style="margin-top:10px;font-size:12px;">页面每 8 秒自动刷新，看到"视频生成完成"后视频文件会出现在本地目录。</p>
    </div>
    <div class="card">
      <h2>脚本检查</h2>
      <p class="muted" style="font-size:12px;margin:0 0 8px;">脚本可以是中文；Video Prompt 必须是英文。</p>
      ${renderShotScriptAndPromptCards(panelPack)}
    </div>
    <div class="card">
      <h2>分镜进度明细</h2>
      ${shotRows || '<p class="muted">无分镜数据</p>'}
    </div>
    ${failedShots.length ? `<div class="card">
      <h2>失败清单</h2>
      <ul style="margin:0;padding-left:18px;">${failedShots.map((s) => `<li style="font-size:13px;"><strong>${htmlEscape(String(s.shot_id || ''))}</strong>：${htmlEscape(String(s.error || '未知'))}</li>`).join('')}</ul>
      <p style="font-size:12px;margin-top:8px;" class="muted">汇总：<code>${htmlEscape(failureSummary || '暂无')}</code></p>
    </div>` : ''}
    ${videos.length ? `<div class="card">
      <h2>已生成视频</h2>
      <ul style="margin:0;padding-left:18px;">${videos.map((v) => `<li style="font-size:12px;"><code>${htmlEscape(v)}</code></li>`).join('')}</ul>
    </div>` : ''}
    <div class="card">
      <h2>创意变量</h2>
      ${renderRunContextSummary(runSummary, '本次使用的创意变量')}
    </div>
  </main>
</body>
</html>`;
}

async function readRequestBody(req) {
  const buffer = await readRequestBuffer(req);
  return buffer.toString('utf8');
}

async function readRequestBuffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseMultipartForm(buffer, contentType) {
  const match = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw new Error('缺少 multipart boundary');
  const boundary = `--${match[1] || match[2]}`;
  const raw = buffer.toString('binary');
  const parts = raw.split(boundary).slice(1, -1);
  const fields = [];
  for (const part of parts) {
    const clean = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const sep = clean.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    const headerText = clean.slice(0, sep);
    const bodyBinary = clean.slice(sep + 4);
    const name = headerText.match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    const filename = headerText.match(/filename="([^"]*)"/)?.[1] || '';
    const contentTypeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
    const valueBuffer = Buffer.from(bodyBinary, 'binary');
    if (filename) {
      if (valueBuffer.length === 0) continue;
      fields.push({
        type: 'file',
        name,
        filename,
        contentType: contentTypeMatch?.[1] || 'application/octet-stream',
        buffer: valueBuffer,
      });
    } else {
      fields.push({ type: 'field', name, value: valueBuffer.toString('utf8') });
    }
  }
  return fields;
}

async function submitProductToN8n(req, _preReadBody) {
  const contentType = req.headers['content-type'] || '';
  const body = _preReadBody || await readRequestBuffer(req);
  const parsed = parseMultipartForm(body, contentType);
  const formData = new FormData();
  const { productName } = validateProductSubmissionParts(parsed);
  for (const item of parsed) {
    if (item.type === 'file') {
      formData.append(item.name, new Blob([item.buffer], { type: item.contentType }), item.filename);
    } else {
      formData.append(item.name, item.value);
    }
  }
  const response = await fetch(getN8nFormUrl(), { method: 'POST', body: formData });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`n8n 表单提交失败 ${response.status}: ${text.slice(0, 300)}`);
  }
  return { productName };
}

async function forwardReviewSubmission(formBody) {
  const response = await fetch(resolveReviewSubmitWebhookUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(formBody),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`审核 webhook 返回 ${response.status}: ${text.slice(0, 300)}`);
  }
}

function resolveReviewSubmitWebhookUrl() {
  if (process.env.REVIEW_SUBMIT_WEBHOOK_URL) {
    return process.env.REVIEW_SUBMIT_WEBHOOK_URL;
  }

  const sql = `
    SELECT webhookPath
    FROM webhook_entity
    WHERE method = 'POST'
      AND node = '${REVIEW_SUBMIT_NODE_NAME.replace(/'/g, "''")}'
    ORDER BY webhookPath DESC
    LIMIT 1;
  `;

  const webhookPath = runSqlite([DB_PATH, sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .trim()
    .replace(/^\/+/, '');

  if (!webhookPath) {
    throw new Error('审核 webhook 尚未注册，请先确认工作流已发布并重新加载。');
  }

  return `${getConfiguredN8nHost()}/webhook/${webhookPath}`;
}

async function forwardConceptSelection(formBody) {
  const response = await fetch(resolveConceptSelectWebhookUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(formBody),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`创意方向选择 webhook 返回 ${response.status}: ${text.slice(0, 300)}`);
  }
}

async function forwardStoryboardGeneration(formBody) {
  const response = await fetch(resolveStoryboardGenerateWebhookUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(formBody),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`分镜图生成 webhook 返回 ${response.status}: ${text.slice(0, 300)}`);
  }
}

function resolveWebhookUrl(workflowId, nodeName, label) {
  const safeId = workflowId.replace(/'/g, "''");
  const safeNode = nodeName.replace(/'/g, "''");
  const sql = `
    SELECT webhookPath FROM webhook_entity
    WHERE method='POST' AND workflowId='${safeId}' AND node='${safeNode}'
    ORDER BY webhookPath DESC LIMIT 1;
  `;
  const webhookPath = runSqlite([DB_PATH, sql], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().replace(/^\/+/, '');
  if (!webhookPath) throw new Error(`${label} webhook 尚未注册，请先同步并重启 n8n。`);
  return `${getConfiguredN8nHost()}/webhook/${webhookPath}`;
}

function resolveConceptSelectWebhookUrl() {
  return resolveWebhookUrl(CONCEPT_SELECT_WORKFLOW_ID, 'concept_select_resume', '创意方向选择 (WF02A)');
}

function resolveStoryboardGenerateWebhookUrl() {
  return resolveWebhookUrl(STORYBOARD_GENERATE_WORKFLOW_ID, 'storyboard_generate_resume', '分镜图生成 (WF02B)');
}

function resolveDirectorRerunWebhookUrl() {
  if (process.env.DIRECTOR_RERUN_WEBHOOK_URL) {
    return process.env.DIRECTOR_RERUN_WEBHOOK_URL;
  }
  return `${getConfiguredN8nHost()}/webhook/director-rerun`;
}

async function forwardDirectorRerunWebhook(payload) {
  const response = await fetch(resolveDirectorRerunWebhookUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`导演重跑 webhook 返回 ${response.status}: ${text.slice(0, 300)}`);
  }
}

function renderConceptListPage() {
  const result = readPendingConcepts();
  const recentProjects = listRecentProjectStates(6);
  const latestProjectId = recentProjects[0]?.projectId || '';

  const pendingCards = result.items.length
    ? result.items.map((item) => `<div class="card" style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;">
        <div>
          <div style="font-weight:600;margin-bottom:4px;">${htmlEscape(item.projectId)}</div>
          <div>产品：${htmlEscape(item.productName || '未填写')}</div>
          <div class="muted" style="font-size:13px;">${htmlEscape(item.targetMarket)} · ${htmlEscape(item.targetLanguage)} · ${htmlEscape(taskTypeLabel(item.creativeTaskType))}</div>
          <div class="muted" style="font-size:13px;">待选方向数量：${htmlEscape(String(item.conceptCount || 0))}</div>
        </div>
        <a class="btn btn-primary" href="${htmlEscape(item.openUrl)}">打开选择页</a>
      </div>`).join('')
    : null;  // will be replaced after conceptFiles is known

  // Build history section from concept context files
  const conceptFiles = fs.existsSync(CONCEPT_CONTEXT_ROOT)
    ? fs.readdirSync(CONCEPT_CONTEXT_ROOT)
        .filter((f) => f.endsWith('.json') && f.startsWith('concept_context_'))
        .sort().reverse().slice(0, 6)
    : [];

  const historyCards = conceptFiles.map((f) => {
    let ctx = {};
    try { ctx = JSON.parse(fs.readFileSync(path.join(CONCEPT_CONTEXT_ROOT, f), 'utf8')); } catch (_) {}
    const pid = ctx.project_id || f.replace('concept_context_', '').replace('.json', '');
    const conceptCount = Array.isArray(ctx.creative_concepts) ? ctx.creative_concepts.length : 0;
    const url = `/concepts/item?context=${encodeURIComponent(f)}`;
    return `<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 16px;">
      <div>
        <div style="font-weight:600;font-size:13px;">${htmlEscape(pid)}</div>
        <div class="muted" style="font-size:12px;">${htmlEscape(ctx.product_name || '未填写产品名称')} · ${htmlEscape(taskTypeLabel(ctx.creative_task_type || ''))} · ${conceptCount} 个方向</div>
      </div>
      <a class="btn btn-secondary" href="${url}" style="white-space:nowrap;font-size:13px;">查看创意方向</a>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="8" />
  <title>创意方向列表</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('concept')}
  <main>
    <div class="btn-row" style="margin-bottom:14px;">
      <a class="btn btn-secondary" href="/">工作台</a>
      ${latestProjectId ? `<a class="btn btn-secondary" href="/active?project_id=${encodeURIComponent(latestProjectId)}">继续当前项目</a>` : ''}
    </div>
    <h1>创意方向</h1>
    ${result.items.length
      ? `<h2 style="font-size:14px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;">待选择</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13px;">选择一个方向后，系统继续进入脚本、分镜审核阶段。</p>
    ${result.items.map((item) => `<div class="card" style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;">
        <div>
          <div style="font-weight:600;margin-bottom:4px;">${htmlEscape(item.projectId)}</div>
          <div>产品：${htmlEscape(item.productName || '未填写')}</div>
          <div class="muted" style="font-size:13px;">${htmlEscape(item.targetMarket)} · ${htmlEscape(item.targetLanguage)} · ${htmlEscape(taskTypeLabel(item.creativeTaskType))}</div>
          <div class="muted" style="font-size:13px;">待选方向数量：${htmlEscape(String(item.conceptCount || 0))}</div>
        </div>
        <a class="btn btn-primary" href="${htmlEscape(item.openUrl)}">打开选择页</a>
      </div>`).join('')}`
      : `<p class="muted" style="margin:0 0 16px;font-size:13px;">${conceptFiles.length ? '当前没有待选择的新创意方向，下面是最近项目，可回看/继续。' : '主表单提交后，导演层完成创意方向生成，这里才会出现项目。'}</p>`
    }
    ${conceptFiles.length ? `<h2 style="font-size:14px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin:${result.items.length ? '20' : '0'}px 0 8px;">历史项目</h2>${historyCards}` : ''}
  </main>
</body>
</html>`;
}

// ── Config page ───────────────────────────────────────────────────────────────

function renderConfigPage(saved = false, error = '') {
  const cfg = normalizeAiConfig(loadConfig());
  const gemini = cfg.gemini || {};
  const kie = cfg.kie || {};
  const apis = cfg.apis || {};
  const providers = cfg.providers || {};
  const tasks = cfg.tasks || {};
  const output = cfg.output || {};
  const services = cfg.services || {};
  const adapters = cfg.adapters || {};

  const kieProvider = providers.kie || {};
  const googleProvider = providers.google || {};
  const kieKey = kieProvider.api_key || kie.api_key || '';
  const kieBase = kieProvider.base_url || kie.base_url || KIE_CONSTANTS.base_url;
  const kieTextBase = kieProvider.text_base_url || kie.text_base_url || '';
  const kieTextModel = tasks.creative_direction?.model || kie.text_model || KIE_CONSTANTS.text_model;
  const kieImageModel = tasks.storyboard_image?.model || kie.image_model || KIE_CONSTANTS.image_model;
  const kieVideoModel = tasks.image_to_video?.model || kie.video_model || KIE_CONSTANTS.video_model;

  // Gemini fallback fields
  const geminiKey = googleProvider.api_key || gemini.api_key || apis.creative_direction?.api_key || '';
  const geminiBase = googleProvider.base_url || gemini.base_url || '';
  const geminiTextModel = googleProvider.text_model || gemini.text_model || '';
  const geminiImageModel = googleProvider.image_model || gemini.image_model || '';

  const textAdapter = adapters.text || 'kie_openai_chat';
  const imageAdapter = adapters.image || 'kie_market_image';
  const videoAdapter = adapters.video || 'kie_veo31';
  const textRouteLabel = `Kie Chat · ${kieTextModel}`;
  const imageRouteLabel = `Kie Image · ${kieImageModel}`;
  const videoRouteLabel = 'Veo 3.1 · Lite';

  const hasKieKey = !!kieKey.trim();
  const hasGeminiKey = !!geminiKey.trim();
  const textOk = textAdapter === 'gemini_native' ? hasGeminiKey : hasKieKey;
  const imageOk = imageAdapter === 'gemini_native' ? hasGeminiKey : hasKieKey;

  const kieBadge = `<span class="badge ${hasKieKey ? 'badge-done' : 'badge-failed'}" style="margin-left:8px;">${hasKieKey ? '已配置' : '未填写'}</span>`;
  const geminiBadge = `<span class="badge ${hasGeminiKey ? 'badge-done' : 'badge-failed'}" style="margin-left:8px;">${hasGeminiKey ? '已配置' : '未填写'}</span>`;
  const dot = (ok) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ok ? '#22c55e' : '#ef4444'};margin-right:6px;flex-shrink:0;"></span>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>系统配置</title>
  ${commonCSS()}
  <style>
    .section-header{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border);}
    input[type=password]{font-family:Menlo,Monaco,Consolas,monospace;letter-spacing:.05em;}
    #save-feedback{display:none;margin-bottom:12px;}
    .confirmed-tag{display:inline-block;background:rgba(34,197,94,0.15);color:#16a34a;border:1px solid rgba(34,197,94,0.3);border-radius:4px;padding:1px 7px;font-size:11px;font-weight:600;margin-left:8px;vertical-align:middle;}
    .pending-tag{display:inline-block;background:rgba(234,179,8,0.12);color:#b45309;border:1px solid rgba(234,179,8,0.3);border-radius:4px;padding:1px 7px;font-size:11px;font-weight:600;margin-left:8px;vertical-align:middle;}
    .route-row{display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px;gap:12px;}
    .route-row:last-child{border-bottom:none;padding-bottom:0;}
    .route-label{color:var(--muted);flex-shrink:0;}
    .route-val{font-family:Menlo,Monaco,monospace;font-size:12px;display:flex;align-items:center;}
    .model-select{width:100%;min-height:42px;border:1px solid var(--border);border-radius:8px;background:var(--card);color:var(--fg);padding:0 12px;font-size:14px;}
    .model-help{font-size:12px;color:var(--muted);margin-top:6px;line-height:1.6;}
    .fixed-model{border:1px solid rgba(79,142,247,.25);background:rgba(79,142,247,.06);border-radius:8px;padding:11px 12px;font-weight:650;}
  </style>
</head>
<body>
  ${renderStageNav('')}
  <main style="max-width:720px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h1 style="margin:0;">系统配置</h1>
      <a class="btn btn-secondary" href="/" style="font-size:12px;">← 工作台</a>
    </div>
    <div id="save-feedback" class="alert-ok">✓ 配置已保存</div>
    ${saved ? '<div class="alert-ok">✓ 配置已保存</div>' : ''}
    ${error ? `<div class="alert-err">${htmlEscape(error)}</div>` : ''}

    <div class="card" style="margin-bottom:20px;border-color:rgba(79,142,247,0.2);background:rgba(79,142,247,0.05);">
      <p style="margin:0;font-size:13px;color:var(--muted);line-height:1.7;">
        前往 <strong>kie.ai</strong> 获取 API Key，填写下方即可启用全部功能。<br>
        <span style="font-size:12px;opacity:.75;">模型和路由由工程端锁定，无需手动配置。</span>
      </p>
    </div>

    <div class="section-header">系统授权</div>
    <div class="card" style="margin-bottom:14px;">
      <div style="display:flex;align-items:center;margin-bottom:10px;">
        <h3 style="margin:0;">Kie API Key</h3>${kieBadge}
      </div>
      <p class="muted" style="margin:0 0 14px;font-size:13px;">填写 API Key 即可启用全部功能。前往 <strong>kie.ai</strong> 获取你的 Key。</p>
      <div class="form-row" style="margin-bottom:0;">
        <label class="form-label">API Key</label>
        <input type="password" data-testid="kie-api-key-input" data-path="providers.kie.api_key" value="" placeholder="${hasKieKey ? '已配置（粘贴新 Key 可更新，留空则不变）' : '粘贴你的 Kie API Key'}" autocomplete="off" />
      </div>
      <!-- Hidden locked model values — always submitted with save -->
      <input type="hidden" data-path="providers.kie.base_url" value="${htmlEscape(KIE_CONSTANTS.base_url)}" />
      <input type="hidden" data-path="tasks.creative_direction.model" value="${htmlEscape(KIE_CONSTANTS.text_model)}" />
      <input type="hidden" data-path="tasks.script_framework.model" value="${htmlEscape(KIE_CONSTANTS.text_model)}" />
      <input type="hidden" data-path="tasks.storyboard_prompt.model" value="${htmlEscape(KIE_CONSTANTS.text_model)}" />
      <input type="hidden" data-path="tasks.storyboard_image.model" value="${htmlEscape(KIE_CONSTANTS.image_model)}" />
      <input type="hidden" data-path="tasks.image_to_video.model" value="${htmlEscape(KIE_CONSTANTS.video_model)}" />
      <input type="hidden" data-path="tasks.creative_direction.provider" value="kie" />
      <input type="hidden" data-path="tasks.script_framework.provider" value="kie" />
      <input type="hidden" data-path="tasks.storyboard_prompt.provider" value="kie" />
      <input type="hidden" data-path="tasks.storyboard_image.provider" value="kie" />
      <input type="hidden" data-path="tasks.image_to_video.provider" value="kie" />
      <!-- Read-only model info -->
      <div style="background:rgba(79,142,247,.05);border:1px solid rgba(79,142,247,.2);border-radius:8px;padding:12px 14px;margin-top:14px;">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px;">当前模型配置（工程锁定）</div>
        <div style="display:grid;gap:6px;font-size:13px;">
          <div style="display:flex;justify-content:space-between;align-items:center;"><span style="color:var(--muted);">文本</span><code style="font-size:12px;">${htmlEscape(KIE_CONSTANTS.text_model)} · Kie 中转</code></div>
          <div style="display:flex;justify-content:space-between;align-items:center;"><span style="color:var(--muted);">图片</span><code style="font-size:12px;">${htmlEscape(KIE_CONSTANTS.image_model)} · 4K · 六宫格</code></div>
          <div style="display:flex;justify-content:space-between;align-items:center;"><span style="color:var(--muted);">视频</span><code style="font-size:12px;">${htmlEscape(KIE_CONSTANTS.video_model)} · Kie Veo</code></div>
        </div>
      </div>
    </div>

    <!-- Google 官方 API 备用（内部开发用，普通用户不可见） -->

    <div class="card" style="margin-bottom:20px;padding:12px 16px;">
      <div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px;">当前接口路由</div>
      <div class="route-row">
        <span class="route-label">创意方向 · 脚本框架 · 失败修复</span>
        <span class="route-val">${dot(textOk)}${htmlEscape(textRouteLabel)}${textAdapter === 'kie_openai_chat' ? ' <span class="confirmed-tag">已配置</span>' : ''}</span>
      </div>
      <div class="route-row">
        <span class="route-label">分镜图生成</span>
        <span class="route-val">${dot(imageOk)}${htmlEscape(imageRouteLabel)}${imageAdapter === 'kie_market_image' ? ' <span class="confirmed-tag">已配置</span>' : ''}</span>
      </div>
      <div class="route-row">
        <span class="route-label">图生视频</span>
        <span class="route-val">${dot(hasKieKey)}${htmlEscape(videoRouteLabel)} <span class="confirmed-tag">已配置</span></span>
      </div>
    </div>

    <div class="section-header">本地输出文件夹</div>
    <div class="card" style="margin-bottom:14px;">
      <p style="margin:0 0 12px;font-size:13px;color:var(--muted);line-height:1.6;">
        生成的分镜图、视频等文件将保存到此文件夹。首次启动会自动创建默认位置，无需手动配置。
      </p>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding:10px 12px;background:rgba(79,142,247,.06);border:1px solid rgba(79,142,247,.2);border-radius:8px;">
        <span style="font-size:18px;">📁</span>
        <code id="output-base-display" style="flex:1;font-size:12px;word-break:break-all;color:#93c5fd;">${htmlEscape(output.base_dir || DEFAULT_OUTPUT_BASE)}</code>
      </div>
      <div style="margin-bottom:10px;">
        <input type="text" id="output-base-input" placeholder="粘贴或输入保存文件夹完整路径，例如 D:\\AI Video Outputs" style="width:100%;box-sizing:border-box;font-size:12px;" />
        <p style="margin:6px 0 0;font-size:11px;color:var(--muted);">在“文件资源管理器”地址栏复制路径粘贴到此处，再点“更改保存位置”。留空且在 macOS 上会弹出系统选择框。</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-primary" type="button" onclick="outputFolderAction('open')" style="font-size:13px;">打开输出文件夹</button>
        <button class="btn btn-secondary" type="button" onclick="outputFolderAction('choose')" style="font-size:13px;">更改保存位置</button>
        <button class="btn btn-secondary" type="button" onclick="outputFolderAction('reset')" style="font-size:13px;">恢复默认位置</button>
      </div>
      <div id="output-folder-msg" style="display:none;margin-top:10px;font-size:13px;padding:8px 12px;border-radius:6px;"></div>
      <details style="margin-top:14px;">
        <summary style="font-size:12px;color:var(--muted);cursor:pointer;">高级：单独配置各子目录</summary>
        <div style="margin-top:10px;display:grid;gap:10px;">
          <div class="form-row" style="margin-bottom:0;">
            <label class="form-label" style="font-size:12px;">分镜图子目录</label>
            <div style="display:flex;gap:8px;align-items:center;">
              <input type="text" data-path="output.storyboard_dir" value="${htmlEscape(output.storyboard_dir || cfg.storyboard_output_dir || '')}" placeholder="${htmlEscape(DEFAULT_OUTPUT_DIRS.storyboard_dir)}" style="font-size:12px;" />
              <button class="btn btn-secondary" type="button" onclick="chooseDir('output.storyboard_dir')" style="white-space:nowrap;font-size:12px;">选择</button>
            </div>
          </div>
          <div class="form-row" style="margin-bottom:0;">
            <label class="form-label" style="font-size:12px;">视频子目录</label>
            <div style="display:flex;gap:8px;align-items:center;">
              <input type="text" data-path="output.video_dir" value="${htmlEscape(output.video_dir || cfg.video_output_dir || '')}" placeholder="${htmlEscape(DEFAULT_OUTPUT_DIRS.video_dir)}" style="font-size:12px;" />
              <button class="btn btn-secondary" type="button" onclick="chooseDir('output.video_dir')" style="white-space:nowrap;font-size:12px;">选择</button>
            </div>
          </div>
        </div>
      </details>
    </div>

    <details style="margin-bottom:14px;">
      <summary style="font-size:13px;color:var(--muted);cursor:pointer;padding:10px 0;">高级设置（服务地址）</summary>
      <div class="card" style="margin-top:8px;">
        <p class="muted" style="font-size:12px;margin:0 0 12px;">通常无需修改，保持默认即可。</p>
        <div class="form-row">
          <label class="form-label">n8n 服务地址</label>
          <input type="text" data-path="services.n8n_host" value="${htmlEscape(services.n8n_host || cfg.n8n_host || getConfiguredN8nHost())}" placeholder="${htmlEscape(N8N_HOST)}" />
        </div>
        <div class="form-row" style="margin-bottom:0;">
          <label class="form-label">工作台地址</label>
          <input type="text" data-path="services.workspace_host" value="${htmlEscape(services.workspace_host || getConfiguredWorkspaceHost())}" placeholder="${htmlEscape(getConfiguredWorkspaceHost())}" />
        </div>
      </div>
    </details>

    <div class="section-header">当前实际生效配置</div>
    <div class="card" style="margin-bottom:20px;font-size:13px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;">
        <div>
          <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;">API Key</div>
          <div>${hasKieKey ? '<span style="color:#16a34a;font-weight:600;">已配置 ✓</span>' : '<span style="color:#ef4444;">未填写</span>'}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;">Base URL</div>
          <div style="font-family:monospace;font-size:12px;word-break:break-all;">${htmlEscape(kieBase)}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;">文本模型实际端点</div>
          <div style="font-family:monospace;font-size:11px;word-break:break-all;line-height:1.5;">${htmlEscape(textAdapter === 'kie_openai_chat' ? kieBase.replace(/\/api\/?$/, '') + '/' + kieTextModel + '/v1/chat/completions' : 'gemini_native fallback')}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;">图像模型实际路由</div>
          <div style="font-family:monospace;font-size:11px;word-break:break-all;line-height:1.5;">${htmlEscape(imageAdapter === 'kie_market_image' ? kieBase.replace(/\/$/, '') + '/v1/jobs/createTask (' + kieImageModel + ')' : 'gemini_native fallback')}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;">视频模型实际路由</div>
          <div style="font-family:monospace;font-size:11px;word-break:break-all;line-height:1.5;">${htmlEscape(kieBase.replace(/\/$/, '') + '/v1/veo/generate (' + kieVideoModel + ')')}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px;">适配器</div>
          <div style="font-family:monospace;font-size:11px;line-height:1.7;">text: ${htmlEscape(textAdapter)}<br>image: ${htmlEscape(imageAdapter)}<br>video: ${htmlEscape(videoAdapter)}</div>
        </div>
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:12px;">
        <button class="btn btn-secondary" type="button" onclick="testConnection()" id="test-btn" style="font-size:13px;">验证 Kie API Key</button>
        <span id="test-result" style="font-size:13px;"></span>
      </div>
    </div>

    <div class="btn-row" style="margin-top:20px;">
      <button class="btn btn-primary" id="save-btn" data-testid="save-config-button" style="padding:9px 24px;">保存配置</button>
      <a class="btn btn-secondary" href="/">取消</a>
    </div>
  </main>
  <script>
  function syncTextModel(val) {
    const s = document.getElementById('text-model-script');
    const b = document.getElementById('text-model-storyboard');
    if (s) s.value = val;
    if (b) b.value = val;
    const fb = document.getElementById('save-feedback');
    if (fb) {
      fb.textContent = '已选择文本模型，点击「保存配置」后生效。';
      fb.style.display = 'block';
    }
  }
  async function testConnection() {
    const btn = document.getElementById('test-btn');
    const result = document.getElementById('test-result');
    btn.disabled = true; btn.textContent = '保存并测试中…';
    result.innerHTML = '';
    result.style.color = '';
    try {
      const saveResp = await fetch('/config-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collectConfigBody())
      });
      const saveData = await saveResp.json().catch(() => ({}));
      if (!saveResp.ok || !saveData.ok) {
        throw new Error(saveData.error || '配置保存失败');
      }
      const r = await fetch('/test-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'runtime' }) });
      const data = await r.json();
      if (data.ok) {
        const checks = (data.checks || []).map(c => (c.ok ? '✓ ' : '✗ ') + c.label + (c.message ? '：' + c.message : '')).join('<br>');
        result.innerHTML = '✓ 检查通过，配置已保存。页面将刷新状态（' + (data.latency_ms || 0) + 'ms）' + (checks ? '<br>' + checks : '');
        result.style.color = '#16a34a';
        setTimeout(() => { window.location.href = '/config'; }, 1200);
      } else {
        const checks = (data.checks || []).map(c => (c.ok ? '✓ ' : '✗ ') + c.label + (c.message ? '：' + c.message : '')).join('<br>');
        result.innerHTML = '✗ ' + (data.message || '检查失败') + '<br><span style="font-size:12px;">当前输入已保存，请检查 Key、额度、网络或代理。</span>' + (checks ? '<br>' + checks : '');
        result.style.color = '#ef4444';
      }
    } catch (err) {
      result.textContent = '✗ 网络错误: ' + err.message;
      result.style.color = '#ef4444';
    }
    btn.disabled = false; btn.textContent = '验证 Kie API Key';
  }
  // onImageModelChange: removed — model select no longer exposed in v1 UI
  function collectConfigBody() {
    const body = { apis: {}, output: {}, services: {} };
    document.querySelectorAll('[data-path]').forEach(el => {
      const parts = el.dataset.path.split('.');
      let ref = body;
      for (let i = 0; i < parts.length - 1; i++) { ref[parts[i]] = ref[parts[i]] || {}; ref = ref[parts[i]]; }
      ref[parts[parts.length - 1]] = el.value;
    });
    if (body.tasks && body.tasks.creative_direction && body.tasks.creative_direction.model) {
      body.tasks.script_framework = body.tasks.script_framework || {};
      body.tasks.storyboard_prompt = body.tasks.storyboard_prompt || {};
      body.tasks.script_framework.model = body.tasks.creative_direction.model;
      body.tasks.storyboard_prompt.model = body.tasks.creative_direction.model;
    }
    return body;
  }
  async function saveConfig(e) {
    e.preventDefault();
    const btn = document.getElementById('save-btn');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await fetch('/config-save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectConfigBody()) });
      if (r.ok) {
        const fb = document.getElementById('save-feedback');
        fb.textContent = '✓ 配置已保存，页面将刷新状态。';
        fb.style.display = 'block';
        setTimeout(() => { window.location.href = '/config'; }, 700);
      } else { alert('保存失败，请重试'); }
    } catch (err) { alert('网络错误: ' + err.message); }
    btn.disabled = false; btn.textContent = '保存配置';
  }
  async function chooseDir(pathKey) {
    try {
      const r = await fetch('/choose-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pathKey })
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || '选择失败');
      const input = document.querySelector('[data-path="' + pathKey + '"]');
      if (input) input.value = data.path;
    } catch (err) {
      alert('选择文件夹失败：' + err.message);
    }
  }
  async function outputFolderAction(action) {
    const msgEl = document.getElementById('output-folder-msg');
    const showMsg = (text, ok) => {
      msgEl.textContent = text;
      msgEl.style.display = 'block';
      msgEl.style.background = ok ? 'rgba(34,197,94,.1)' : 'rgba(239,68,68,.1)';
      msgEl.style.color = ok ? '#16a34a' : '#ef4444';
      msgEl.style.border = ok ? '1px solid rgba(34,197,94,.3)' : '1px solid rgba(239,68,68,.3)';
    };
    try {
      let body = { action };
      if (action === 'choose') {
        const inputEl = document.getElementById('output-base-input');
        const inputVal = inputEl ? inputEl.value.trim() : '';
        if (inputVal) {
          body.base_dir = inputVal;
        } else {
          const display = document.getElementById('output-base-display');
          const current = display ? display.textContent.trim() : '';
          const pathText = prompt('请输入新的保存位置路径（可直接粘贴 Windows 路径）。\n例如：C:\\Users\\你的用户名\\Videos\\AI Video Outputs', current);
          if (pathText == null || !pathText.trim()) {
            showMsg('已取消更改保存位置。', true);
            return;
          }
          body.base_dir = pathText.trim();
        }
      }
      const r = await fetch('/api/output-folder-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || data.message || '操作失败');
      if (action === 'open') {
        showMsg('已打开输出文件夹', true);
      } else if (action === 'choose' || action === 'reset') {
        const display = document.getElementById('output-base-display');
        if (display && data.base_dir) display.textContent = data.base_dir;
        showMsg((action === 'reset' ? '已恢复默认位置：' : '已更改保存位置：') + (data.base_dir || ''), true);
        setTimeout(() => { window.location.href = '/config'; }, 900);
      }
    } catch (err) {
      if (action === 'open') {
        showMsg('输出文件夹打开失败，请检查目录权限，或点击恢复默认位置。', false);
      } else {
        showMsg('操作失败：' + err.message, false);
      }
    }
  }
  // P14-B8Q: bind the save button via addEventListener (closure reference — no
  // global lookup), and explicitly expose the handlers on window. The packaged
  // Windows Electron renderer did not promote these inline-script function
  // declarations to window globals, so the old inline onclick="saveConfig(event)"
  // could not resolve saveConfig and the click silently no-op'd (B8P:
  // save_handler_present=false, no POST /config-save). addEventListener does not
  // depend on a window global, and the explicit exposure keeps the remaining
  // inline onclicks (test/choose/output) working and makes the handler detectable.
  window.saveConfig = saveConfig;
  window.testConnection = testConnection;
  window.chooseDir = chooseDir;
  window.outputFolderAction = outputFolderAction;
  window.syncTextModel = syncTextModel;
  (function bindConfigSaveHandler() {
    const bind = () => {
      if (window.AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND) return; // already bound (e.g. desktop-shell injection on Windows)
      const sb = document.querySelector('[data-testid="save-config-button"]') || document.getElementById('save-btn');
      if (sb && !sb.dataset.boundSave) {
        sb.dataset.boundSave = '1';
        sb.addEventListener('click', (e) => saveConfig(e));
        window.AI_VIDEO_CONFIG_SAVE_HANDLER_BOUND = true;
        try { if (document.body) document.body.dataset.configSaveHandlerBound = 'true'; } catch (_) {}
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
  })();
  </script>
</body>
</html>`;
}

// ── Prompt center page ────────────────────────────────────────────────────────

const PROMPT_MODULE_LABELS = {
  director: {
    label: '创意方向生成',
    fields: {
      system_instruction: { label: '系统指令（工程默认，只读）', editable: false },
      user_template: { label: '用户提示词模板（只读参照）', editable: false },
    },
  },
  script: {
    label: '脚本生成',
    fields: {
      system_instruction: { label: '系统指令（工程默认，只读）', editable: false },
      user_template: { label: '用户提示词模板（只读参照）', editable: false },
    },
  },
  storyboard: {
    label: '分镜生成',
    fields: {
      system_instruction: { label: '系统指令（工程默认，只读）', editable: false },
      user_template: { label: '用户提示词模板（只读参照）', editable: false },
    },
  },
  nanobanana_image: {
    label: '分镜图生成提示词',
    fields: {
      english_storyboard_wrapper: { label: '英文提示词模板（只读参照）', editable: false },
    },
  },
  veo_repair: {
    label: '图生视频提示词',
    fields: {
      system_instruction: { label: '系统指令（工程默认，只读）', editable: false },
      user_template: { label: '用户提示词模板（只读参照）', editable: false },
    },
  },
  gemini_models: {
    label: '备用 Gemini 模型配置（调试）',
    fields: {
      text_pro: { label: '文本模型 ID', editable: false },
      image_flash: { label: '图像模型 ID', editable: false },
    },
  },
};

function renderPromptCenterPage(savedModule = '', error = '') {
  const center = loadPromptCenter();
  const moduleCards = Object.entries(PROMPT_MODULE_LABELS).map(([mod, meta]) => {
    const modData = center[mod] || {};
    let hasEditableField = false;
    const fieldRows = Object.entries(meta.fields).map(([field, fieldMeta]) => {
      const normalizedMeta = typeof fieldMeta === 'string' ? { label: fieldMeta, editable: true } : fieldMeta;
      const editable = normalizedMeta.editable !== false;
      if (editable) hasEditableField = true;
      const val = typeof modData[field] === 'string' ? modData[field] : JSON.stringify(modData[field] || '', null, 2);
      const isLong = val.length > 120;
      return `<div class="form-row">
        <label class="form-label">${htmlEscape(normalizedMeta.label || field)}</label>
        ${editable && isLong
          ? `<textarea name="${htmlEscape(field)}" rows="7" style="font-family:monospace;font-size:13px;">${htmlEscape(val)}</textarea>`
          : editable
            ? `<input type="text" name="${htmlEscape(field)}" value="${htmlEscape(val)}" />`
            : `<pre style="max-height:280px;overflow:auto;">${htmlEscape(val)}</pre><p class="muted" style="font-size:12px;margin:4px 0 0;">变量模板参照，运行时自动填充，不建议直接修改。</p>`
        }
      </div>`;
    }).join('');
    return `<div class="card" id="mod-${htmlEscape(mod)}">
      <h3 style="margin-bottom:10px;">${htmlEscape(meta.label)}${savedModule === mod ? ' <span class="badge badge-done">已保存</span>' : ''}</h3>
      <form method="POST" action="/prompt-center-save">
        <input type="hidden" name="module" value="${htmlEscape(mod)}" />
        ${fieldRows}
        <div class="btn-row">
          ${hasEditableField ? '<button class="btn btn-primary" type="submit">保存可调项</button>' : '<span class="badge badge-todo">工程默认已锁定</span>'}
          <a class="btn btn-secondary" href="/prompt-center-reset?module=${encodeURIComponent(mod)}" onclick="return confirm('确定恢复「${htmlEscape(meta.label)}」为默认提示词？')">恢复默认</a>
        </div>
      </form>
    </div>`;
  }).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>提示词中心</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('')}
  <main style="max-width:860px;">
    <div class="btn-row" style="margin-bottom:14px;"><a class="btn btn-secondary" href="/">工作台</a></div>
    <h1>提示词中心</h1>
    ${error ? `<div class="alert-err">${htmlEscape(error)}</div>` : ''}
    <div class="card" style="background:var(--warning-dim);border-color:rgba(245,158,11,0.25);">
      <p class="muted" style="margin:0;font-size:13px;">当前商业默认版为稳定优先：系统指令和结构模板锁定只读，普通用户通过表单变量、创意类型、脚本编辑和分镜反馈微调内容。后续可在高级版开放白名单字段。</p>
    </div>
    ${moduleCards}
    <div class="card">
      <p class="muted" style="font-size:12px;margin:0;">提示词文件：<code>${htmlEscape(PROMPT_CENTER_PATH)}</code></p>
      <p class="muted" style="font-size:12px;margin:4px 0 0;">默认备份：<code>${htmlEscape(PROMPT_CENTER_EXAMPLE_PATH)}</code></p>
    </div>
  </main>
</body>
</html>`;
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input) {
  return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

function getDeviceId() {
  const candidates = [];
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 3000,
      });
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) candidates.push(match[1]);
    } catch {}
  }
  try { candidates.push(os.hostname()); } catch {}
  candidates.push(os.homedir(), process.platform, process.arch);
  const raw = candidates.filter(Boolean).join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24).toUpperCase();
}

function readLicenseRecord() {
  try {
    if (fs.existsSync(LICENSE_FILE_PATH)) {
      return JSON.parse(fs.readFileSync(LICENSE_FILE_PATH, 'utf8'));
    }
  } catch {}
  return null;
}

function verifySignedLicenseCode(licenseCode, expectedDeviceId) {
  const code = String(licenseCode || '').trim();
  const parts = code.split('.');
  if (parts.length !== 3 || parts[0] !== 'AIV1') {
    throw new Error('激活码格式不正确');
  }
  const payloadText = base64UrlDecode(parts[1]);
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error('激活码内容无法解析');
  }
  const cfg = normalizeAiConfig(loadConfig());
  // P14-C1: AI_VIDEO_LICENSE_PUBLIC_KEY lets CI verify against a test keypair without the
  // real signing-authority key. Production never sets it → the embedded public key is used.
  const publicKey = String(process.env.AI_VIDEO_LICENSE_PUBLIC_KEY || cfg.license?.public_key || LICENSE_PUBLIC_KEY).trim();
  const ok = crypto.verify(
    null,
    Buffer.from(parts[1]),
    publicKey,
    Buffer.from(parts[2], 'base64url'),
  );
  if (!ok) throw new Error('激活码签名无效');

  const appId = String(payload.app_id || '');
  const expectedAppId = String(cfg.license?.app_id || 'ai-video-mvp');
  if (appId !== expectedAppId) throw new Error('激活码不适用于当前应用版本');

  const codeDeviceId = String(payload.device_id || '').toUpperCase();
  if (codeDeviceId !== String(expectedDeviceId || '').toUpperCase()) {
    throw new Error('激活码与当前设备不匹配');
  }
  if (payload.expires_at) {
    const expiresAt = new Date(payload.expires_at).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
      throw new Error('激活码已过期');
    }
  }
  return payload;
}

function getLicenseStatus() {
  const cfg = normalizeAiConfig(loadConfig());
  // P14-C1: the packaged build forces the gate ON via AI_VIDEO_LICENSE_REQUIRED=1 (set by
  // the launcher in dist mode); dev/config can also opt in. AI_VIDEO_LICENSE_BYPASS=1 (dev /
  // image-video smoke) skips it. The gate at the request handler blocks every protected
  // route when ok===false, so this single source of truth governs the whole workbench.
  const required = process.env.AI_VIDEO_LICENSE_REQUIRED === '1' || Boolean(cfg.license?.required);
  const deviceId = getDeviceId();
  if (process.env.AI_VIDEO_LICENSE_BYPASS === '1') {
    return { required, ok: true, bypass: true, deviceId, message: '开发模式已跳过激活' };
  }
  if (!required) {
    return { required, ok: true, deviceId, message: '当前版本未启用激活门禁' };
  }
  const record = readLicenseRecord();
  if (!record?.license_code) {
    return { required, ok: false, deviceId, message: '尚未激活' };
  }
  try {
    const payload = verifySignedLicenseCode(record.license_code, deviceId);
    return { required, ok: true, deviceId, payload, activatedAt: record.activated_at || '', message: '已激活' };
  } catch (error) {
    return { required, ok: false, deviceId, message: error.message || String(error) };
  }
}

function saveLicenseRecord(licenseCode, payload) {
  fs.mkdirSync(LICENSE_APP_SUPPORT_DIR, { recursive: true });
  const record = {
    license_code: String(licenseCode || '').trim(),
    payload,
    activated_at: new Date().toISOString(),
    device_id: getDeviceId(),
  };
  fs.writeFileSync(LICENSE_FILE_PATH, JSON.stringify(record, null, 2) + '\n', 'utf8');
  try { fs.chmodSync(LICENSE_FILE_PATH, 0o600); } catch {}
  return record;
}

function renderActivationPage(status = getLicenseStatus(), error = '') {
  const payload = status.payload || {};
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>激活 AI Video</title>
  ${commonCSS()}
</head>
<body>
  <main style="max-width:720px;">
    <div class="card" style="margin-top:48px;">
      <h1 style="margin-bottom:8px;">激活 AI Video</h1>
      <p class="muted" style="font-size:13px;line-height:1.8;margin:0 0 16px;">此客户端需要绑定当前设备后使用。把下面的设备 ID 发给客服/销售方，获取激活码后粘贴到这里。</p>
      ${error ? `<div class="alert-err">${htmlEscape(error)}</div>` : ''}
      ${status.ok ? `<div class="alert-ok">已激活${payload.expires_at ? `，有效期至 ${htmlEscape(payload.expires_at)}` : ''}</div>` : ''}
      <div class="form-row">
        <label class="form-label">当前设备 ID</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <input readonly value="${htmlEscape(status.deviceId || getDeviceId())}" style="font-family:Menlo,Monaco,monospace;" />
          <button class="btn btn-secondary" type="button" onclick="navigator.clipboard.writeText('${htmlEscape(status.deviceId || getDeviceId())}');this.textContent='已复制';">复制</button>
        </div>
      </div>
      <form method="POST" action="/activate">
        <label class="form-label">激活码</label>
        <textarea name="license_code" rows="6" placeholder="粘贴 AIV1 开头的激活码" style="font-family:Menlo,Monaco,monospace;font-size:12px;"></textarea>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">激活</button>
          ${status.ok ? '<a class="btn btn-secondary" href="/">进入工作台</a>' : ''}
        </div>
      </form>
    </div>
  </main>
</body>
</html>`;
}

function renderDocsPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>使用说明</title>
  ${commonCSS()}
  <style>
    .step-item{display:flex;gap:16px;margin-bottom:24px;align-items:flex-start;}
    .step-num{flex-shrink:0;width:32px;height:32px;border-radius:50%;background:var(--accent-dim);border:1px solid rgba(79,142,247,0.35);color:var(--accent);font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;}
    .step-body{flex:1;padding-top:4px;}
    .step-title{font-weight:700;font-size:15px;margin-bottom:4px;color:var(--text);}
    .step-desc{color:var(--muted);font-size:13px;line-height:1.7;}
    .step-time{display:inline-flex;align-items:center;gap:4px;margin-top:6px;font-size:11px;color:var(--muted);background:var(--surface-2);border:1px solid var(--border);border-radius:20px;padding:2px 9px;}
    .faq-item{border-top:1px solid var(--border);padding:14px 0;}
    .faq-item:first-child{border-top:none;padding-top:0;}
    .faq-q{font-weight:600;font-size:14px;margin-bottom:6px;color:var(--text);}
    .faq-a{color:var(--muted);font-size:13px;line-height:1.7;}
    .flow-connector{width:1px;height:20px;background:var(--border);margin:0 0 0 15px;}
  </style>
</head>
<body>
  ${renderStageNav('')}
  <main style="max-width:760px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <h1 style="margin:0;">使用说明</h1>
      <a class="btn btn-secondary" href="/" style="font-size:12px;">← 工作台</a>
    </div>

    <div class="card" style="margin-bottom:14px;">
      <h2 style="margin-bottom:20px;font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);">完整使用流程</h2>

      <div class="step-item">
        <div class="step-num">1</div>
        <div class="step-body">
          <div class="step-title">配置 API Key</div>
          <div class="step-desc">进入「系统配置」，填写创意方向、脚本框架、分镜图生成这三个阶段的 API Key。可以填同一个 Key，也可以分开填写。</div>
          <div class="step-time">⏱ 一次配置，永久生效</div>
        </div>
      </div>
      <div class="flow-connector"></div>

      <div class="step-item">
        <div class="step-num">2</div>
        <div class="step-body">
          <div class="step-title">填写产品信息</div>
          <div class="step-desc">点击「填写产品信息」，输入产品名称、目标市场、内容类型，上传至少 1 张产品图片（最多 5 张）。提交后 AI 自动开始处理。产品图片是创意方向的必要输入。</div>
          <div class="step-time">⏱ 提交即开始，无需等待</div>
        </div>
      </div>
      <div class="flow-connector"></div>

      <div class="step-item">
        <div class="step-num">3</div>
        <div class="step-body">
          <div class="step-title">选择创意方向</div>
          <div class="step-desc">AI 会生成 2–3 个创意方向。你可以直接选择，也可以先调整目标用户、内容风格等参数后重新生成，直到满意为止。</div>
          <div class="step-time">⏱ 约 1–2 分钟</div>
        </div>
      </div>
      <div class="flow-connector"></div>

      <div class="step-item">
        <div class="step-num">4</div>
        <div class="step-body">
          <div class="step-title">确认脚本框架</div>
          <div class="step-desc">选定创意方向后，AI 生成 6 镜头脚本结构。查看每个镜头的画面描述和台词，确认无误后进入下一步。</div>
          <div class="step-time">⏱ 约 1–2 分钟</div>
        </div>
      </div>
      <div class="flow-connector"></div>

      <div class="step-item">
        <div class="step-num">5</div>
        <div class="step-body">
          <div class="step-title">查看分镜图</div>
          <div class="step-desc">系统根据脚本自动生成每个镜头的参考图。生成完成后可在分镜图页面查看，图片会自动保存到本地设置的文件夹。</div>
          <div class="step-time">⏱ 约 2–3 分钟</div>
        </div>
      </div>
      <div class="flow-connector"></div>

      <div class="step-item" style="margin-bottom:0;">
        <div class="step-num" style="opacity:.6;">6</div>
        <div class="step-body">
          <div class="step-title" style="opacity:.75;">视频生成 <span style="font-size:12px;font-weight:400;color:var(--muted);">（需配置视频 API）</span></div>
          <div class="step-desc">在「系统配置 → 视频生成 API」填写视频接口信息后，可将分镜图转化为视频片段。</div>
          <div class="step-time">⏱ 取决于视频服务响应速度</div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-bottom:16px;font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);">常见问题</h2>
      <div class="faq-item">
        <div class="faq-q">创意方向页面显示"暂无内容"？</div>
        <div class="faq-a">AI 还在生成中，通常 1–2 分钟后刷新即可看到。若超过 5 分钟仍无内容，请回到「系统配置」确认 API Key 是否正确填写并已保存。</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">产品图片是必须上传的吗？</div>
        <div class="faq-a">是的，至少需要上传 1 张产品图片（jpg/png）。AI 创意方向需要真实产品图片作为视觉输入，不支持纯文字生成。建议上传 1–2 张清晰产品图以获得最佳效果。</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">对生成的创意方向不满意，怎么办？</div>
        <div class="faq-a">在创意方向页修改目标用户、内容风格等参数后，点击「重新生成」，AI 会按新参数重新生成。可以多试几次，不满意就继续调整。</div>
      </div>
      <div class="faq-item">
        <div class="faq-q">如何清除历史数据，重新开始？</div>
        <div class="faq-a">进入「运行环境」，点击「清空项目缓存」。系统只清除项目过程数据，配置和 API Key 不受影响。</div>
      </div>
    </div>

    <div class="btn-row" style="margin-top:4px;"><a class="btn btn-secondary" href="/">返回工作台</a></div>
  </main>
</body>
</html>`;
}

function renderHubPage() {
  const concepts = readPendingConcepts().items;
  const reviews = readPendingReviews().items;
  const latestConcept = concepts[0] || null;
  const latestReview = reviews[0] || null;
  const recentProjects = listRecentProjectStates(3);
  const latestProjectId = recentProjects[0]?.projectId || '';
  const dashboard = latestProjectId ? buildProjectDashboard(latestProjectId) : null;
  const stageLabels = { done:'已完成', running:'进行中', failed:'失败' };
  const stageBadgeCls = { done:'badge-done', running:'badge-running', failed:'badge-failed', todo:'badge-todo' };

  const stageRows = dashboard ? dashboard.stages.map((s) => {
    const cls = stageBadgeCls[s.status] || 'badge-todo';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:13px;">${htmlEscape(s.label)}</span>
      <span class="badge ${cls}">${stageLabels[s.status] || '未开始'}</span>
    </div>`;
  }).join('') : '';

  const projectCards = recentProjects.map((item) => `<div class="card">
    <div style="font-weight:600;margin-bottom:4px;">${htmlEscape(item.projectId)}</div>
    <div>${htmlEscape(item.productName || '未填写产品名称')}</div>
    <div class="muted" style="font-size:12px;margin:4px 0;">${htmlEscape(item.status || '')} · ${htmlEscape(item.updatedAt || '')}</div>
    <div class="btn-row">
      <a class="btn btn-secondary" href="${htmlEscape(item.openUrl)}">打开项目</a>
      ${item.conceptUrl ? `<a class="btn btn-secondary" href="${htmlEscape(item.conceptUrl)}">创意方向</a>` : ''}
      ${item.reviewUrl ? `<a class="btn btn-secondary" href="${htmlEscape(item.reviewUrl)}">脚本分镜</a>` : ''}
    </div>
  </div>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Video 工作台</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('form')}
  <main>
    <div class="grid-2">
      <div>
        <div class="card">
          <h1 style="margin-bottom:16px;">AI Video 工作台</h1>
          <h2 style="margin-bottom:10px;font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);">开始新项目</h2>
          <p class="muted" style="font-size:13px;margin:0 0 14px;line-height:1.6;">输入产品信息，AI 自动生成 2–3 个创意方向供选择，然后生成脚本框架和分镜图。</p>
          <div class="btn-row" style="margin-bottom:10px;">
            <a class="btn btn-primary" href="/new-project" style="font-size:15px;padding:12px 28px;">开始新项目</a>
          </div>
          <p class="muted" style="font-size:12px;margin:8px 0 0;">通常 5–10 分钟内完成前半段生成，具体取决于 API 响应速度。</p>
        </div>
        <div class="card">
          <h2>快捷入口</h2>
          <div class="btn-row">
            ${latestProjectId ? `<a class="btn btn-primary" href="/active?project_id=${encodeURIComponent(latestProjectId)}">当前项目</a>` : ''}
            <a class="btn btn-secondary" href="/concepts">创意方向</a>
            ${latestProjectId ? `<a class="btn btn-secondary" href="/script-review?project_id=${encodeURIComponent(latestProjectId)}">脚本框架</a>` : ''}
            <a class="btn btn-secondary" href="/reviews">分镜审核</a>
            <a class="btn btn-secondary" href="/config">系统配置</a>
            <a class="btn btn-secondary" href="/system">运行环境</a>
            <a class="btn btn-secondary" href="/docs">操作文档</a>
          </div>
        </div>
        ${latestConcept ? `<div class="card">
          <h2>最新创意方向</h2>
          <div style="font-weight:600;">${htmlEscape(latestConcept.projectId)}</div>
          <div class="muted" style="font-size:13px;margin:4px 0;">${htmlEscape(latestConcept.productName || '未填写')}</div>
          <div class="btn-row"><a class="btn btn-secondary" href="${htmlEscape(latestConcept.openUrl)}">打开选择页</a></div>
        </div>` : ''}
        ${latestReview ? `<div class="card">
          <h2>最新分镜审核</h2>
          <div style="font-weight:600;">${htmlEscape(latestReview.projectId || '')}</div>
          <div class="muted" style="font-size:12px;margin:4px 0;"><code>${htmlEscape(latestReview.reviewContextPath)}</code></div>
          <div class="btn-row">
            <a class="btn btn-secondary" href="/script-review?project_id=${encodeURIComponent(latestReview.projectId || '')}">脚本框架</a>
            <a class="btn btn-secondary" href="${htmlEscape(latestReview.openUrl)}">分镜审核</a>
            <a class="btn btn-secondary" href="${htmlEscape(latestReview.statusUrl)}">视频状态</a>
          </div>
        </div>` : ''}
      </div>
      <div>
        <div class="card">
          <h2 style="display:flex;align-items:center;gap:8px;">当前项目${dashboard ? `<span class="badge badge-running" style="font-size:11px;">活跃</span>` : ''}</h2>
          <p class="muted" style="font-size:12px;margin:0 0 8px;">最近一次提交表单的项目状态。</p>
          ${dashboard ? `<div style="font-weight:600;margin-bottom:4px;">${htmlEscape(latestProjectId)}</div>
          <div class="muted" style="font-size:13px;margin-bottom:8px;">${htmlEscape(dashboard.state.product_name || '')}</div>
          ${stageRows}
          <p class="muted" style="font-size:12px;margin-top:8px;">完成：${htmlEscape(String(dashboard.progress.completed_count || 0))} · 进行中：${htmlEscape(String(dashboard.progress.running_count || 0))} · 失败：${htmlEscape(String(dashboard.progress.failed_count || 0))}</p>
          <div class="btn-row"><a class="btn btn-primary" href="/active?project_id=${encodeURIComponent(latestProjectId)}">打开项目管理页</a><button type="button" class="btn btn-secondary" data-project-id="${htmlEscape(latestProjectId)}" onclick="!function(b){if(b.dataset.s)return;b.dataset.s=1;var t=b.textContent,p=b.dataset.projectId;b.disabled=true;b.textContent='同步中…';fetch('/api/reconcile-project',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:p})}).then(function(r){return r.json()}).then(function(d){if(!d.ok){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包';return}if(d.activeRoute&&d.activeRoute!==window.location.pathname+window.location.search){b.textContent='已同步当前项目状态';setTimeout(function(){window.location.href=d.activeRoute},600);return}b.textContent=(d.patched&&d.patched.length)?'已同步当前项目状态':'未发现新的生成结果';setTimeout(function(){b.disabled=false;delete b.dataset.s;b.textContent=t},3000)}).catch(function(){b.disabled=false;delete b.dataset.s;b.textContent='同步失败，请导出诊断包'})}(this)">同步当前项目状态</button></div>`
          : '<p class="muted" style="font-size:13px;">还没有可恢复的项目。提交表单后会在这里显示进度。</p>'}
        </div>
        ${recentProjects.length > 1 ? `<div class="card">
          <h2>历史项目</h2>
          <p class="muted" style="font-size:12px;margin:0 0 10px;">最近 3 个项目（24 小时内）。仅供回看，不代表当前活跃状态。</p>
          ${projectCards}
        </div>` : ''}
        <div class="card">
          <h2>使用说明</h2>
          <ol class="muted" style="font-size:13px;margin:0;padding-left:16px;line-height:2;">
            <li>填表单 → 选创意方向 → 生成脚本框架 → 确认脚本 → 生成分镜图 → 确认审核 → 生成视频</li>
            <li>前半段生成通常 5–10 分钟，具体取决于 API 响应速度</li>
            <li>回到这个工作台即可查看当前项目进度</li>
          </ol>
        </div>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function renderSubmittedPage(sinceMs = 0, options = {}) {
  const waitSince = Number(sinceMs || 0) > 0 ? Number(sinceMs) : Date.now() - 15000;
  const activeUrl = `/active?since=${encodeURIComponent(String(waitSince))}`;

  // Find concept_context file created after waitSince to avoid showing stale activeProject in nav
  let _sinceConceptFile = '';
  try {
    if (fs.existsSync(CONCEPT_CONTEXT_ROOT)) {
      const _newFiles = fs.readdirSync(CONCEPT_CONTEXT_ROOT)
        .filter(f => f.startsWith('concept_context_') && f.endsWith('.json'))
        .filter(f => { try { return fs.statSync(path.join(CONCEPT_CONTEXT_ROOT, f)).mtimeMs >= waitSince; } catch { return false; } })
        .sort();
      if (_newFiles.length > 0) _sinceConceptFile = _newFiles.at(-1);
    }
  } catch {}

  // After 8 s give n8n time to start; then check if WF01 already failed.
  const elapsed = Date.now() - waitSince;
  let wf01Failure = null;
  if (elapsed > 8000) {
    try {
      const exec = findLatestWF01Execution(waitSince);
      if (exec && (exec.status === 'error' || exec.status === 'crashed')) {
        const errSummary = readExecutionErrorSummary(exec.id);
        wf01Failure = { exec, errSummary, classification: classifyWF01Error(errSummary) };
      }
    } catch {}
  }

  if (wf01Failure) {
    const { exec, errSummary, classification } = wf01Failure;
    // Redact any credentials that might have leaked into the error message before displaying in UI.
    const safeErrSummary = String(errSummary || '')
      .replace(/Authorization:[^\n\r]+/gi, 'Authorization: [REDACTED]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/"api_key"\s*:\s*"[^"]+"/gi, '"api_key": "[REDACTED]"')
      .replace(/AIzaSy[A-Za-z0-9_-]{30,}/g, '[REDACTED-AIZA]')
      .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED-SK]')
      .replace(/Kie[A-Za-z0-9_-]{10,}/g, '[REDACTED-KIE]')
      .replace(/\b[a-f0-9]{32}\b/gi, '[REDACTED-HEX32]');
    const errDisplay = safeErrSummary.trim() ? htmlEscape(safeErrSummary.slice(0, 200)) : '（详情见诊断包）';
    const isUpstream = ['connection_closed', 'kie_server_error', 'maintenance', 'timeout'].includes(classification.type);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>创意方向生成失败</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('form', _sinceConceptFile)}
  <main style="max-width:680px;">
    <div class="card" style="margin-top:40px;">
      <div class="alert-err" style="margin-bottom:16px;">
        <strong>创意方向生成失败</strong><br>
        <span style="font-size:13px;">WF01 执行报错 · 执行 ID：<code>${htmlEscape(String(exec.id || '?'))}</code></span>
      </div>
      <div style="font-size:13px;color:#e2e8f0;margin-bottom:12px;line-height:1.8;">
        <div><strong>错误类型：</strong>${htmlEscape(classification.label)}</div>
        <div><strong>错误摘要：</strong><code style="font-size:11px;word-break:break-all;">${errDisplay}</code></div>
      </div>
      ${isUpstream ? `<div style="background:rgba(251,191,36,.12);border:1px solid #fbbf24;border-radius:8px;padding:10px 14px;color:#fcd34d;font-size:13px;margin-bottom:12px;">
        ⚠ 这是<strong>上游中转站临时异常</strong>，不是您的图片或 API Key 问题，稍后重试通常可以解决。
      </div>` : ''}
      <div style="font-size:12px;color:#94a3b8;margin-bottom:16px;">建议等待 30 秒后重新提交表单。</div>
      <div class="btn-row">
        <a class="btn btn-primary" href="/new-project">重新提交表单</a>
        <a class="btn btn-secondary" href="/system">运行环境</a>
        <button class="btn btn-secondary" onclick="exportDiagAndAlert(this)">导出诊断包</button>
      </div>
    </div>
  </main>
  <script>
  async function exportDiagAndAlert(btn) {
    btn.disabled = true; btn.textContent = '生成中…';
    try {
      const r = await fetch('/api/export-diagnostics');
      const d = await r.json();
      if (d.ok) { btn.textContent = '✅ 已导出'; alert('诊断包已保存：\\n' + d.path + '\\n\\n可将此文件发送给技术支持。'); }
      else { btn.textContent = '导出诊断包'; alert('导出失败：' + (d.error || '未知错误')); }
    } catch(e) { btn.textContent = '导出诊断包'; alert('网络错误：' + e.message); }
  }
  </script>
</body>
</html>`;
  }

  // Waiting state — JS-polling status page (replaces meta-refresh)
  const _dedupBanner = options.isDedup
    ? `<div class="alert-err" style="margin-bottom:14px;background:rgba(220,38,38,.08);border:1px solid #dc2626;border-radius:8px;padding:10px 14px;color:#dc2626;font-size:13px;">⚠ 检测到相同项目正在生成中，请勿重复提交。已为您显示当前生成进度。</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>创意方向生成中</title>
  ${commonCSS()}
  <style>
    .spinner{display:inline-block;width:18px;height:18px;border:3px solid #334155;border-top-color:#6366f1;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;}
    @keyframes spin{to{transform:rotate(360deg)}}
    .status-row{display:flex;align-items:center;gap:10px;margin:14px 0;}
    .info-grid{font-size:13px;color:#94a3b8;line-height:2;}
    .info-grid span{color:#e2e8f0;}
  </style>
</head>
<body>
  ${renderStageNav('form', _sinceConceptFile)}
  <main style="max-width:680px;">
    <div class="card" style="margin-top:40px;">
      ${_dedupBanner}
      <h1 id="status-title" style="font-size:20px;margin-bottom:4px;">创意方向生成中…</h1>
      <div class="status-row">
        <div class="spinner" id="spin"></div>
        <span id="status-text" style="color:#94a3b8;font-size:14px;">正在调用 AI 模型，请稍候…</span>
      </div>
      <div class="info-grid" style="margin-bottom:14px;">
        <div>当前阶段：<span>创意方向生成（WF01）</span></div>
        <div>最近 Execution ID：<span id="exec-id">—</span></div>
        <div>当前节点：<span id="last-node">—</span></div>
        <div>已等待：<span id="elapsed-str">—</span></div>
      </div>
      <div id="slow-hint" style="display:none;background:rgba(251,191,36,.12);border:1px solid #fbbf24;border-radius:8px;padding:10px 14px;color:#fcd34d;font-size:13px;margin-bottom:12px;">
        ⏱ 上游响应较慢，可能正在排队或等待中转站响应，请继续等待。
      </div>
      <div id="error-panel" style="display:none;">
        <div class="alert-err" style="margin-bottom:12px;">
          <strong>创意方向生成失败</strong><br>
          <span style="font-size:13px;">WF01 执行报错 · 执行 ID：<code id="err-exec-id">?</code></span>
        </div>
        <div style="font-size:13px;color:#e2e8f0;margin-bottom:12px;line-height:1.8;">
          <div><strong>错误类型：</strong><span id="err-type-label">—</span></div>
          <div><strong>错误摘要：</strong><code id="err-summary" style="font-size:11px;word-break:break-all;">—</code></div>
        </div>
        <div id="upstream-hint" style="display:none;background:rgba(251,191,36,.12);border:1px solid #fbbf24;border-radius:8px;padding:10px 14px;color:#fcd34d;font-size:13px;margin-bottom:12px;">
          ⚠ 这是<strong>上游中转站临时异常</strong>，稍后重试通常可以解决。
        </div>
        <div style="font-size:12px;color:#94a3b8;margin-bottom:14px;">建议等待 30 秒后重新提交表单。</div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" id="retry-btn" onclick="confirmRetry()" style="display:none;">重新提交表单</button>
        <button class="btn btn-secondary" id="diag-btn" onclick="exportDiagAndAlert(this)" style="display:none;">导出诊断包</button>
        <a class="btn btn-secondary" href="/system" id="sys-btn" style="display:none;">运行环境</a>
      </div>
    </div>
  </main>
  <script>
  const SINCE = ${waitSince};
  const UPSTREAM_TYPES = ['connection_closed','kie_server_error','maintenance','timeout','non_json_response','NON_JSON_MODEL_RESPONSE'];
  const ERROR_LABELS = {
    maintenance:'中转站维护中，请稍后重试',
    kie_server_error:'中转站服务器 5xx 错误',
    connection_closed:'连接被断开（中转站或网络中断）',
    connection_refused:'连接被拒绝（检查网络/代理）',
    timeout:'请求超时（中转站响应过慢）',
    non_json_response:'模型返回了非 JSON 结构（可能拒绝回答或返回了说明文字）',
    NON_JSON_MODEL_RESPONSE:'模型返回了非 JSON 结构（可能拒绝回答或返回了说明文字）',
    auth_error:'API Key 无效或未配置',
    quota_error:'账户余额不足或权限不足',
    unknown:'执行报错（详见诊断包）',
  };
  function fmtMs(ms){const s=Math.floor(ms/1000);return s<60?s+' 秒':Math.floor(s/60)+' 分 '+(s%60)+' 秒';}
  function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  let polling=true;
  function setFailed(d){
    polling=false;
    document.getElementById('spin').style.display='none';
    document.getElementById('status-title').textContent='创意方向生成失败';
    document.getElementById('slow-hint').style.display='none';
    document.getElementById('error-panel').style.display='block';
    document.getElementById('err-exec-id').textContent=d.execId||'?';
    document.getElementById('err-type-label').textContent=ERROR_LABELS[d.errorType]||ERROR_LABELS.unknown;
    document.getElementById('err-summary').innerHTML=esc((d.errorSummary||'').slice(0,200)||'（详情见诊断包）');
    if(UPSTREAM_TYPES.includes(d.errorType))document.getElementById('upstream-hint').style.display='block';
    document.getElementById('status-text').textContent='执行报错，请查看下方详情。';
    document.getElementById('retry-btn').style.display='';
    document.getElementById('diag-btn').style.display='';
    document.getElementById('sys-btn').style.display='';
  }
  async function poll(){
    if(!polling)return;
    try{
      const r=await fetch('/api/wf01-status?since='+SINCE);
      const d=await r.json();
      const ms=d.elapsedMs||(Date.now()-SINCE);
      document.getElementById('elapsed-str').textContent=fmtMs(ms);
      if(d.execId)document.getElementById('exec-id').textContent=d.execId;
      if(d.lastNode)document.getElementById('last-node').textContent=d.lastNode;
      if(ms>120000&&d.status!=='failed')document.getElementById('slow-hint').style.display='block';
      if(d.status==='success'&&d.activeRoute){
        polling=false;
        document.getElementById('status-title').textContent='✅ 创意方向已生成，正在跳转…';
        document.getElementById('status-text').textContent='正在进入创意方向选择页面…';
        document.getElementById('spin').style.animationDuration='0.3s';
        setTimeout(()=>{window.location.href=d.activeRoute;},600);
        return;
      }
      if(d.status==='failed'){setFailed(d);return;}
      if(d.status==='running')document.getElementById('status-text').textContent='模型正在处理您的请求…';
    }catch(e){/* network error, keep polling */}
    setTimeout(poll,3000);
  }
  function confirmRetry(){
    if(confirm('重新提交表单将开始新的创意方向生成。\\n\\n确认重新提交？')){window.location.href='/new-project';}
  }
  async function exportDiagAndAlert(btn){
    btn.disabled=true;btn.textContent='生成中…';
    try{
      const r=await fetch('/api/export-diagnostics');
      const d=await r.json();
      if(d.ok){btn.textContent='✅ 已导出';alert('诊断包已保存：\\n'+d.path+'\\n\\n可将此文件发送给技术支持。');}
      else{btn.textContent='导出诊断包';alert('导出失败：'+(d.error||'未知错误'));}
    }catch(e){btn.textContent='导出诊断包';alert('网络错误：'+e.message);}
  }
  setInterval(()=>{document.getElementById('elapsed-str').textContent=fmtMs(Date.now()-SINCE);},1000);
  setTimeout(poll,1000);
  </script>
</body>
</html>`;
}

function renderTemplate(template, vars) {
  let out = String(template || '');
  for (const [key, value] of Object.entries(vars || {})) {
    out = out.split(`{{${key}}}`).join(value == null ? '' : String(value));
  }
  return out;
}

function renderConceptField(label, value) {
  return `<div class="field-row">
    <span class="field-label">${htmlEscape(label)}</span>
    <span class="field-value">${htmlEscape(value || '未填写')}</span>
  </div>`;
}

function renderEditableConceptInput(label, name, value, hint = '', textarea = false) {
  const control = textarea
    ? `<textarea name="${htmlEscape(name)}" class="concept-input">${htmlEscape(value || '')}</textarea>`
    : `<input type="text" name="${htmlEscape(name)}" class="concept-input" value="${htmlEscape(value || '')}" />`;
  return `<label class="edit-row">
    <span class="edit-label">${htmlEscape(label)}</span>
    ${control}
    ${hint ? `<span class="edit-hint">${htmlEscape(hint)}</span>` : ''}
  </label>`;
}

function renderConceptResultItem(label, value) {
  return `<div class="result-row">
    <span class="result-label">${htmlEscape(label)}</span>
    <span class="result-value">${htmlEscape(value || '未填写')}</span>
  </div>`;
}

function renderConceptSourceModule(concept) {
  const source = concept?.original_payload || {};
  const originalDirection = String(source.concept_name || source.direction_name || source.direction || concept.concept_name || '').trim();
  const sourceFields = [
    ['原始方向名称', originalDirection],
    ['视觉 Hook', source.visual_hook || source.hook_visual || concept.core_selling_angle || concept.hook_strategy || ''],
    ['人物状态', source.character_status || source.character_and_scene || source.persona_and_scene || concept.target_user || ''],
    ['场景氛围', source.scene_atmosphere || source.scene_vibe || source.persona_and_scene || concept.usage_scene || ''],
    ['镜头运动', source.camera_movement || source.wearing_and_mood || concept.visual_expression || ''],
    ['卖点切入', source.selling_point_focus || source.voiceover_focus || concept.core_selling_angle || ''],
    ['本地化语气', source.voiceover_tone || source.voiceover_focus || concept.why_it_fits_tiktok || ''],
  ];
  return `<div class="summary-block">
    <p style="margin-top:0;"><strong>原始方向素材</strong></p>
    <div class="structured-grid">
      ${sourceFields.map(([label, value]) => renderConceptField(label, value)).join('')}
    </div>
  </div>`;
}

function renderConceptDetailPage(contextPath, options = {}) {
  const context = readContextFile(contextPath);
  const promptCenter = loadPromptCenter();
  const directorPrompt = promptCenter.director || {};
  const projectId = context.project_id || path.basename(contextPath);
  const revisionState = readConceptRevisionState(projectId);
  const feedbackItems = readProjectFeedback(projectId).filter((item) => item.stage === 'director').slice(0, 5);
  const directorVars = {
    project_id: context.project_id || '',
    product_name: context.product_name || '',
    product_desc: context.product_desc || context.product_selling_points || '',
    product_selling_points: context.product_selling_points || context.product_desc || '',
    target_market: context.target_market || '',
    target_language: context.target_language || '',
    creative_task_type: context.creative_task_type || '',
    reference_case_url: context.reference_case_url || context.reference_video_url || '',
    reference_video_url: context.reference_video_url || context.reference_case_url || '',
    creative_task_type_rules: context.creative_task_type_rules_json || '{}',
    product_images_json: JSON.stringify(context.product_images_meta || context.product_image_local_paths || [], null, 2),
  };
  const renderedDirectorUserPrompt = renderTemplate(directorPrompt.user_template || '', directorVars);
  const concepts = Array.isArray(context.creative_concepts) ? context.creative_concepts : [];

  const conceptCards = concepts.length
    ? concepts.map((concept, index) => {
        const savedRevision = revisionState.revisions?.[concept.concept_id] || {};
        const isSaved = Boolean(savedRevision?.updated_at);
        const resultFields = [
          ['创意方向名称', concept.concept_name || `创意方向 ${index + 1}`],
          ['内容目标', concept.content_goal || concept.core_selling_angle || concept.hook_strategy || ''],
          ['核心卖点切入', concept.core_selling_angle || concept.original_payload?.selling_point_focus || concept.original_payload?.voiceover_focus || ''],
          ['目标用户', concept.target_user || concept.original_payload?.character_status || concept.original_payload?.persona_and_scene || ''],
          ['使用场景', concept.usage_scene || concept.original_payload?.scene_atmosphere || concept.original_payload?.persona_and_scene || ''],
          ['视觉 Hook', concept.visual_hook || concept.hook_strategy || concept.original_payload?.hook_visual || ''],
          ['内容风格', concept.visual_expression || concept.creative_form || concept.original_payload?.wearing_and_mood || ''],
          ['人物/模特设定', concept.model_profile || ''],
          ['视频类型', taskTypeLabel(concept.video_type || concept.creative_form || '')],
          ['为什么适合 TikTok', concept.why_it_fits_tiktok || ''],
          ['建议宫格', '6_grid（当前版本固定）'],
          ['风险提示', concept.risk_notes || ''],
        ];
        return `<div class="card" style="border-top:3px solid ${isSaved ? 'var(--success)' : 'var(--border)'};">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">
            <h2 style="margin:0;">${htmlEscape(concept.concept_name || `创意方向 ${index + 1}`)}</h2>
            ${isSaved ? '<span class="badge badge-done">已保存修改</span>' : '<span class="badge badge-todo">未修改</span>'}
          </div>
          <div style="display:grid;grid-template-columns:60fr 40fr;gap:16px;">
            <div>
              <h3>模型生成值</h3>
              <div class="structured-grid">
                ${resultFields.map(([label, value]) => renderConceptResultItem(label, value)).join('')}
              </div>
              ${renderConceptSourceModule(concept)}
            </div>
            <div>
              <h3>可调变量</h3>
              <form method="POST" action="/concept-revision-save">
                <input type="hidden" name="project_id" value="${htmlEscape(projectId)}" />
                <input type="hidden" name="concept_context_path" value="${htmlEscape(path.basename(contextPath))}" />
                <input type="hidden" name="concept_id" value="${htmlEscape(concept.concept_id || '')}" />
                ${renderEditableConceptInput('目标用户', 'target_user', conceptEditFieldValue(concept, savedRevision, 'target_user'), '例如：本地年轻女性、上班族', true)}
                ${renderEditableConceptInput('使用场景', 'usage_scene', conceptEditFieldValue(concept, savedRevision, 'usage_scene'), '例如：卧室、通勤、厨房', true)}
                ${renderEditableConceptInput('内容风格', 'visual_expression', conceptEditFieldValue(concept, savedRevision, 'visual_expression'), '例如：UGC、真实分享、对比感', true)}
                ${renderEditableConceptInput('视觉 Hook', 'hook_strategy', conceptEditFieldValue(concept, savedRevision, 'hook_strategy'), '例如：前3秒对焦、反差开场', true)}
                ${renderEditableConceptInput('人物/模特设定', 'model_profile', conceptEditFieldValue(concept, savedRevision, 'model_profile'), '例如：真人出镜、不出镜、30岁女性', true)}
                ${(() => {
                  const vt = conceptEditFieldValue(concept, savedRevision, 'video_type') || '';
                  const vtOpts = [
                    ['local_voiceover', '本地口播型'],
                    ['pure_display', '纯展示型'],
                    ['mixed', '混合型：产品展示 + 轻口播/字幕'],
                    ['pure_display_or_light_voiceover', '纯展示/轻口播'],
                  ];
                  const options = vtOpts.map(([val, label]) =>
                    `<option value="${htmlEscape(val)}"${vt === val ? ' selected' : ''}>${htmlEscape(label)}</option>`
                  ).join('');
                  const hasMatch = vtOpts.some(([val]) => val === vt);
                  const fallback = hasMatch ? '' : `<option value="${htmlEscape(vt)}" selected>${htmlEscape(vt || '（未设置）')}</option>`;
                  return `<label class="edit-row">
                    <span class="edit-label">视频类型</span>
                    <select name="video_type" class="concept-input">${fallback}${options}</select>
                  </label>`;
                })()}
                ${renderEditableConceptInput('核心卖点切入', 'core_selling_angle', conceptEditFieldValue(concept, savedRevision, 'core_selling_angle'), '例如：轻便、显瘦、质感', true)}
                ${renderEditableConceptInput('为什么适合 TikTok', 'why_it_fits_tiktok', conceptEditFieldValue(concept, savedRevision, 'why_it_fits_tiktok'), '', true)}
                <label class="edit-row">
                  <span class="edit-label">建议宫格</span>
                  <span class="concept-input" style="background:#f5f5f5;color:var(--muted);cursor:default;user-select:none;">6_grid（当前版本固定）</span>
                  <input type="hidden" name="recommended_grid" value="6_grid" />
                </label>
                ${renderEditableConceptInput('风险提示', 'risk_notes', conceptEditFieldValue(concept, savedRevision, 'risk_notes'), '', true)}
                <div class="btn-row" style="margin-top:12px;">
                  <button class="btn btn-secondary" type="submit" title="保存变量，不进入下一步。之后可点击下方「按修改重新生成创意方向」。">保存修改</button>
                  <button class="btn btn-primary" type="submit" formaction="/concept-select-with-edit" onclick="return confirm('确认选择此创意方向，系统将开始生成脚本框架。');">选择此创意方向，继续生成脚本框架</button>
                </div>
              </form>
              ${savedRevision?.updated_at ? `<p class="muted" style="font-size:12px;margin-top:8px;">最近修改：<code>${htmlEscape(savedRevision.updated_at)}</code></p>` : ''}
            </div>
          </div>
        </div>`;
      }).join('')
    : '<div class="card"><p class="muted">没有可选创意方向，请回到主流程重新生成导演层结果。</p></div>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>创意方向选择 — ${htmlEscape(projectId)}</title>
  ${commonCSS()}
  <style>
    .concept-input{width:100%;box-sizing:border-box;border:1px solid var(--border-strong);border-radius:var(--r);padding:7px 10px;font:inherit;font-size:13px;background:var(--surface);color:var(--text);}
    .concept-input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim);}
    .edit-row textarea.concept-input{min-height:60px;resize:vertical;}
    .edit-hint{display:block;color:var(--muted);font-size:12px;margin-top:3px;}
    .edit-label{display:block;font-size:12px;font-weight:600;color:#334155;margin-bottom:3px;}
    .edit-row{margin-bottom:10px;}
    .result-row{border:1px solid var(--border);border-radius:var(--r);padding:6px 8px;background:var(--surface-2);}
    .result-label{display:block;font-size:11px;font-weight:600;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.04em;}
    .result-value{display:block;font-size:13px;color:var(--text);line-height:1.4;white-space:pre-wrap;word-break:break-word;}
    .summary-block{margin-top:14px;padding-top:12px;border-top:1px solid var(--border);}
    @media(max-width:860px){[style*="60fr 40fr"]{grid-template-columns:1fr!important;}}
  </style>
</head>
<body>
  ${renderStageNav('concept')}
  <main>
    ${options.feedbackSaved ? '<div class="alert-ok" style="margin-bottom:12px;">✅ AI 模型已按变量约束重新生成创意方向，下面是本轮新结果。满意后请选择一个方向继续生成脚本框架。</div>' : ''}
    ${options.revisionSavedConceptId ? '<div class="alert-ok" style="margin-bottom:12px;">✅ 已保存可调变量，将在下次「按修改重新生成创意方向」时作为约束发给 AI 模型。</div>' : ''}
    ${options.selectedSaved ? '<div class="alert-ok" style="margin-bottom:12px;">已选择此创意方向，系统会继续进入下一阶段。</div>' : ''}
    <div class="card">
      <h1 style="margin-bottom:4px;">${htmlEscape(projectId)}</h1>
      <p style="margin:0 0 4px;">产品：<strong>${htmlEscape(context.product_name || '未填写')}</strong></p>
      <p class="muted" style="margin:0 0 10px;font-size:13px;">${htmlEscape(context.target_market || '')} · ${htmlEscape(context.target_language || '')} · ${htmlEscape(taskTypeLabel(context.creative_task_type || ''))}</p>
      <p class="muted" style="font-size:12px;margin:0 0 10px;">选定后 selected_concept 会成为后续脚本、分镜、视频 Prompt 的硬约束。</p>
      <div class="btn-row">
        <a class="btn btn-secondary" href="/concepts">返回列表</a>
        <a class="btn btn-secondary" href="/">工作台</a>
      </div>
    </div>
    <details class="card" style="margin-bottom:12px;">
      <summary style="cursor:pointer;font-weight:600;">本阶段 Prompt（点击展开）</summary>
      <div style="margin-top:12px;">
        <div class="grid-2" style="margin-bottom:10px;">
          <div><h3>System Prompt</h3><pre>${htmlEscape(directorPrompt.system_instruction || '未配置')}</pre></div>
          <div><h3>User Prompt Template</h3><pre>${htmlEscape(directorPrompt.user_template || '未配置')}</pre></div>
        </div>
        <h3>本次填充后 User Prompt</h3><pre>${htmlEscape(renderedDirectorUserPrompt || '未生成预览')}</pre>
        <!-- prompt-center link hidden: internal maintenance only -->
      </div>
    </details>
    ${conceptCards}
    <div class="card" style="margin-bottom:12px;border-top:3px solid var(--accent);">
      <h2 style="margin-bottom:4px;">按修改重新生成创意方向</h2>
      <p class="muted" style="font-size:13px;margin:0 0 12px;">系统会读取以下内容重新调用<strong>文本模型</strong>，生成 2–3 个新创意方向：① 右侧「可调变量」中所有已保存字段（目标用户、视觉风格等）；② 下方「自由创作要求」（选填）；③ 产品图片；④ 原始产品信息（产品名称、卖点）；⑤ 目标市场与语言。生成后停留在本页，不进入脚本阶段。<br/><strong style="color:#dc2626;">⚠ 此操作会使旧脚本、旧分镜、旧视频和旧最终成片失效。</strong></p>
      ${(() => {
        // Build saved-variables summary from all revised concepts
        const mergedFields = {};
        for (const rev of Object.values(revisionState.revisions || {})) {
          for (const [k, v] of Object.entries(rev.fields || {})) {
            if (v && String(v).trim()) mergedFields[k] = String(v).trim();
          }
        }
        const varLabels = [
          ['target_user', '目标用户'],
          ['model_profile', '人物/模特设定'],
          ['usage_scene', '使用场景'],
          ['visual_expression', '内容风格'],
          ['hook_strategy', '视觉 Hook'],
          ['core_selling_angle', '核心卖点切入'],
          ['video_type', '视频类型'],
        ];
        const activeVars = varLabels.filter(([k]) => mergedFields[k]);
        if (!activeVars.length) return '<p class="muted" style="font-size:12px;margin:0 0 10px;">暂无已保存变量 — 先在上方创意方向卡片的「可调变量」中填写并点击「保存修改」。</p>';
        return `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:10px 12px;margin-bottom:12px;">
          <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:#1d4ed8;">当前已保存变量（将随本次重生成一起发送给 AI 模型）</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px 16px;">
            ${activeVars.map(([k, label]) => `<div style="font-size:12px;"><span style="color:#475569;">${htmlEscape(label)}：</span><strong style="color:#0f172a;">${htmlEscape(mergedFields[k])}</strong></div>`).join('')}
          </div>
        </div>`;
      })()}
      <form method="POST" action="/concept-feedback">
        <input type="hidden" name="project_id" value="${htmlEscape(projectId)}" />
        <input type="hidden" name="context" value="${htmlEscape(path.basename(contextPath))}" />
        <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px;">自由创作要求（选填）</label>
        <div class="form-row"><textarea name="free_form_requirement" rows="3" placeholder="例如：更像 TikTok UGC，不要像广告；前 3 秒更强 Hook；要前后对比；人物不要网红脸；节奏快一点。" style="width:100%;"></textarea></div>
        <button class="btn btn-primary" type="submit" onclick="this.disabled=true;this.textContent='正在调用 AI 模型重新生成，请稍候…';this.form.submit();">按修改重新生成创意方向</button>
      </form>
      ${feedbackItems.length ? `<div style="margin-top:10px;"><h3 style="font-size:13px;margin:0 0 6px;">近期自由创作要求记录</h3><ul style="margin:0;padding-left:16px;">${feedbackItems.map((item) => `<li style="font-size:12px;" class="muted"><code>${htmlEscape(item.created_at || '')}</code> ${htmlEscape(item.feedback || '')}</li>`).join('')}</ul></div>` : ''}
    </div>
  </main>
</body>
</html>`;
}

function renderConceptSubmitPage({ ok, message, contextPath = '', executionId = '' }) {
  const title = ok ? '创意方向已提交' : '创意方向提交失败';
  const projectId = contextPath ? readContextFile(contextPath).project_id || '' : '';
  const scriptStatusUrl = contextPath ? `/concept-status?context=${encodeURIComponent(path.basename(contextPath))}` : (projectId ? `/script-review?project_id=${encodeURIComponent(projectId)}` : '/active');
  const refresh = ok ? `<meta http-equiv="refresh" content="1; url=${scriptStatusUrl}" />` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${refresh}<title>${htmlEscape(title)}</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('concept')}
  <main style="max-width:680px;">
    <div class="card" style="margin-top:40px;">
      <h1>${htmlEscape(title)}</h1>
      <p>${htmlEscape(ok ? '系统已开始基于所选创意方向生成脚本框架，正在进入脚本生成状态页。' : (message || ''))}</p>
      ${executionId ? `<p class="muted" style="font-size:12px;">续跑执行 ID：<code>${htmlEscape(String(executionId))}</code></p>` : ''}
      <div class="btn-row">
        ${ok ? `<a class="btn btn-primary" href="${htmlEscape(scriptStatusUrl)}">查看脚本生成状态</a>` : ''}
        <a class="btn btn-secondary" href="/concepts">返回列表</a>
      </div>
    </div>
  </main>
</body>
</html>`;
}

function renderConceptStatusPage(contextPath) {
  const context = readContextFile(contextPath);
  const projectId = context.project_id || path.basename(contextPath);
  const selectedPath = selectedConceptSidecarPath(projectId);
  const selected = fs.existsSync(selectedPath) ? readContextFile(selectedPath) : {};
  const execution = findLatestExecutionForProject(projectId, CONCEPT_SELECT_WORKFLOW_ID);

  // Check pipeline stage: script_context → review_context
  const scriptCtxFile = scriptContextPath(projectId);
  const scriptReady = fs.existsSync(scriptCtxFile);
  const scriptLink = scriptReady ? `/script-review?project_id=${encodeURIComponent(projectId)}` : '';

  const reviewItems = fs.existsSync(REVIEW_CONTEXT_ROOT)
    ? fs.readdirSync(REVIEW_CONTEXT_ROOT).filter((name) => name.startsWith(`review_context_${projectId}`) && name.endsWith('.json') && !name.includes('.stale') && !name.endsWith('.submitted.json'))
    : [];
  const reviewLink = reviewItems.length ? `/reviews/item?context=${encodeURIComponent(reviewItems.sort().at(-1))}` : '';
  const scriptReadyRefresh = scriptReady && !reviewLink && scriptLink ? `<meta http-equiv="refresh" content="0; url=${scriptLink}" />` : '';

  const isScriptError = !reviewLink && !scriptReady && (execution?.status === 'error' || execution?.status === 'crashed');

  const statusText = reviewLink
    ? '分镜图已生成，等待分镜审核'
    : scriptReady
      ? '脚本框架已生成，等待确认'
      : (isScriptError ? '脚本框架生成失败，请稍后重试' : '脚本框架生成中，请稍等...');

  const primaryBtn = reviewLink
    ? `<a class="btn btn-primary" href="${htmlEscape(reviewLink)}">打开分镜审核页</a>`
    : scriptReady
      ? `<a class="btn btn-primary" href="${htmlEscape(scriptLink)}">审核 / 编辑脚本框架</a>`
      : isScriptError
        ? `<p class="muted" style="color:#c0392b;margin-bottom:12px;">脚本框架生成失败，请稍后重试。如连续失败，请导出诊断包。</p>
<form method="POST" action="/concept-select" style="display:inline">
  <input type="hidden" name="project_id" value="${htmlEscape(String(projectId))}">
  <input type="hidden" name="selected_concept_id" value="${htmlEscape(String(selected.selected_concept_id || ''))}">
  <input type="hidden" name="concept_context_path" value="${htmlEscape(String(contextPath))}">
  <button type="submit" class="btn btn-warning">重新生成脚本框架</button>
</form>`
        : '<p class="muted">正在生成脚本框架（约 30–60 秒），请等待页面自动刷新。</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${scriptReadyRefresh}
    <title>创意方向续跑状态</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('concept')}
  <main style="max-width:720px;">
    <div class="card">
      <h1 style="margin-bottom:4px;">${htmlEscape(projectId)}</h1>
      <p>状态：<strong id="cp-status-text">${htmlEscape(statusText)}</strong></p>
      <p class="muted" style="font-size:13px;">已选：<code>${htmlEscape(selected.selected_concept_json?.concept_name || selected.selected_concept_id || '')}</code></p>
      <p class="muted" style="font-size:13px;">执行 ID：<code>${htmlEscape(execution?.id ?? '未找到')}</code> · ${htmlEscape(execution?.status ?? '')}</p>
      <div class="btn-row" id="cp-btn-row">${primaryBtn}</div>
      <div class="btn-row" style="margin-top:12px;">
        <a class="btn btn-secondary" href="/">工作台</a>
        <a class="btn btn-secondary" href="/active?project_id=${encodeURIComponent(projectId)}">当前项目</a>
        <a class="btn btn-secondary" href="/concepts">创意方向列表</a>
      </div>
    </div>
  </main>
  ${(!scriptReady && !isScriptError) ? `<script>
  const CP_PROJ = ${JSON.stringify(projectId)};
  let cpPoll = true;
  async function doCpPoll() {
    if (!cpPoll) return;
    try {
      const r = await fetch('/api/concept-poll?project_id=' + encodeURIComponent(CP_PROJ));
      const d = await r.json();
      if (d.ready && d.scriptUrl) {
        cpPoll = false;
        const st = document.getElementById('cp-status-text');
        if (st) st.textContent = '脚本框架已生成，正在跳转…';
        setTimeout(() => { window.location.href = d.scriptUrl; }, 400);
        return;
      }
      if (d.status === 'error') {
        cpPoll = false;
        const st = document.getElementById('cp-status-text');
        if (st) st.textContent = d.message || '脚本框架生成失败，请稍后重试';
        const row = document.getElementById('cp-btn-row');
        if (row) row.innerHTML = '<p class="muted" style="color:#c0392b;margin-bottom:12px;">脚本框架生成失败，请稍后重试。如连续失败，请导出诊断包。</p>';
        return;
      }
    } catch(e) { /* keep polling */ }
    setTimeout(doCpPoll, 5000);
  }
  setTimeout(doCpPoll, 3000);
  </script>` : ''}
</body>
</html>`;
}

function renderStoryboardStatusPage(projectId) {
  const pid = String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_');
  const reviewItems = fs.existsSync(REVIEW_CONTEXT_ROOT)
    ? fs.readdirSync(REVIEW_CONTEXT_ROOT).filter(
        (name) => name.startsWith(`review_context_${pid}`) && name.endsWith('.json')
          && !name.includes('.stale') && !name.endsWith('.submitted.json'),
      )
    : [];
  if (reviewItems.length) {
    const latest = reviewItems.sort().at(-1);
    reconcileStoryboardContextStateForUi(projectId, readProjectState(projectId), true);
    const reviewUrl = `/reviews/item?context=${encodeURIComponent(latest)}`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="0; url=${reviewUrl}" />
  <title>分镜图已生成</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('storyboard')}
  <main style="max-width:680px;">
    <div class="card" style="margin-top:40px;">
      <h1>分镜图已生成</h1>
      <p>正在跳转到分镜审核页…</p>
      <div class="btn-row"><a class="btn btn-primary" href="${htmlEscape(reviewUrl)}">立即查看分镜图</a></div>
    </div>
  </main>
</body>
</html>`;
  }
  const execution = findLatestExecutionForProject(projectId, STORYBOARD_GENERATE_WORKFLOW_ID);
  const isError = execution?.status === 'error' || execution?.status === 'crashed';
  const storyboardFailure = isError ? markStoryboardGenerationFailed(projectId, execution) : null;
  const errorDetail = isError
    ? (execution?.data?.resultData?.error?.message || execution?.data?.error?.message || '未知错误')
    : '';
  // P17-REGRESSION-HARDENING: detect if storyboard images already exist (stage=storyboard_generated)
  // so we can show a more accurate status message even while review_context is still being assembled
  const _sbPtok = pid.toLowerCase();
  const _sbHasImages = (() => {
    const _chk = (dir, pfx, ext) => {
      if (!fs.existsSync(dir)) return false;
      try { return fs.readdirSync(dir).some(f => f.startsWith(pfx) && f.endsWith(ext)); } catch { return false; }
    };
    return _chk(path.join(CACHE_ROOT, 'nanobanana'), `storyboard_${_sbPtok}_`, '.png') ||
           _chk(path.join(CACHE_ROOT, '分镜图裁剪', 'full'), `panel_full_${_sbPtok}_`, '.jpg') ||
           _chk(path.join(CACHE_ROOT, '分镜图裁剪', 'previews'), `panel_preview_${_sbPtok}_`, '.jpg');
  })();
  const _sbSince = Date.now();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
	  <title>${_sbHasImages ? '分镜图已生成' : '分镜图生成中'}</title>
  ${commonCSS()}
  <style>
    .spinner{display:inline-block;width:18px;height:18px;border:3px solid #334155;border-top-color:#6366f1;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;}
    @keyframes spin{to{transform:rotate(360deg)}}
    .status-row{display:flex;align-items:center;gap:10px;margin:14px 0;}
  </style>
</head>
<body>
  ${renderStageNav('storyboard')}
  <main style="max-width:680px;">
    <div class="card" style="margin-top:40px;">
	      <h1 id="sb-title">${_sbHasImages ? '分镜图已生成，正在生成审核数据…' : '分镜图生成中，请稍等...'}</h1>
      ${isError
        ? `<div class="alert-err">${htmlEscape(storyboardFailure?.user_message || STORYBOARD_FAILURE_USER_MESSAGE)}<br/><br/>技术信息：${htmlEscape(storyboardFailure?.technical_message || errorDetail)}<br/>执行 ID：${htmlEscape(String(execution?.id || ''))}</div>`
	        : `<div class="status-row"><div class="spinner" id="sb-spin"></div><span id="sb-text" style="color:#94a3b8;font-size:14px;">${_sbHasImages ? '分镜图已生成，等待审核数据就绪（通常数秒内完成）…' : '分镜图生成中，请稍等...'}</span></div>
           <div style="font-size:13px;color:#94a3b8;margin-bottom:10px;">已等待：<span id="sb-elapsed">—</span></div>
           <div id="sb-slow" style="display:none;background:rgba(251,191,36,.12);border:1px solid #fbbf24;border-radius:8px;padding:10px 14px;color:#fcd34d;font-size:13px;margin-bottom:12px;">
             ⏱ 图像模型响应较慢，可能正在排队，请继续等待。通常 90–120 秒内完成。
           </div>`}
      <div class="btn-row">
        <a class="btn btn-secondary" href="/script-review?project_id=${encodeURIComponent(projectId)}">返回脚本页</a>
        <a class="btn btn-secondary" href="/">工作台</a>
        <button type="button" class="btn btn-secondary" id="sb-sync-btn">同步状态</button>
      </div>
    </div>
  </main>
  ${isError ? `<script>
  (function(){
    var btn = document.getElementById('sb-sync-btn');
    if (!btn) return;
    btn.addEventListener('click', async function() {
      if (btn.dataset.s) return;
      btn.dataset.s = '1'; btn.disabled = true; btn.textContent = '同步中…';
      try {
        var r = await fetch('/api/reconcile-project', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: ${JSON.stringify(projectId)} }),
        });
        var d = await r.json();
        if (!d.ok) { btn.disabled = false; delete btn.dataset.s; btn.textContent = '同步失败，请导出诊断包'; return; }
        if (d.activeRoute && d.activeRoute !== window.location.pathname + window.location.search) {
          btn.textContent = '已同步当前项目状态'; setTimeout(function(){ window.location.href = d.activeRoute; }, 600); return;
        }
        btn.textContent = (d.patched && d.patched.length) ? '已同步当前项目状态' : '未发现新的生成结果';
        setTimeout(function(){ btn.disabled = false; delete btn.dataset.s; btn.textContent = '同步状态'; }, 3000);
      } catch(e) { btn.disabled = false; delete btn.dataset.s; btn.textContent = '同步失败，请导出诊断包'; }
    });
  })();
  </script>` : `<script>
  const SB_SINCE = ${_sbSince};
  const SB_PROJ = ${JSON.stringify(projectId)};
  function fmtMs(ms){const s=Math.floor(ms/1000);return s<60?s+' 秒':Math.floor(s/60)+' 分 '+(s%60)+' 秒';}
  let sbPolling = true;
  async function sbPoll() {
    if (!sbPolling) return;
    try {
      const r = await fetch('/api/storyboard-poll?project_id=' + encodeURIComponent(SB_PROJ));
      const d = await r.json();
      const ms = Date.now() - SB_SINCE;
      document.getElementById('sb-elapsed').textContent = fmtMs(ms);
      if (ms > 120000) document.getElementById('sb-slow').style.display = 'block';
      if (d.ready && d.reviewUrl) {
        sbPolling = false;
        document.getElementById('sb-title').textContent = '✅ 分镜图已生成，正在跳转…';
        document.getElementById('sb-text').textContent = '正在进入分镜审核页面…';
        document.getElementById('sb-spin').style.animationDuration = '0.3s';
        setTimeout(() => { window.location.href = d.reviewUrl; }, 500);
        return;
      }
      if (d.status === 'error') {
        sbPolling = false;
        document.getElementById('sb-title').textContent = '分镜图生成失败';
        document.getElementById('sb-text').textContent = d.userMessage || '分镜图生成失败，请稍后重试。';
        document.getElementById('sb-spin').style.display = 'none';
        return;
      }
      if (d.status === 'review_context_missing') {
        sbPolling = false;
        document.getElementById('sb-title').textContent = '分镜审核数据丢失';
        document.getElementById('sb-text').innerHTML = (d.userMessage || '分镜已生成但审核数据丢失。') +
          '<br><br><a href="/active?project_id=' + encodeURIComponent(SB_PROJ) + '" style="color:#2563eb;">← 返回项目页，点击「重新生成分镜图」</a>';
        document.getElementById('sb-spin').style.display = 'none';
        return;
      }
    } catch(e) { /* keep polling on network error */ }
    setTimeout(sbPoll, 4000);
  }
  setInterval(() => { document.getElementById('sb-elapsed').textContent = fmtMs(Date.now() - SB_SINCE); }, 1000);
  setTimeout(sbPoll, 2000);
  async function sbSync() {
    const btn = document.getElementById('sb-sync-btn');
    if (!btn || btn.dataset.s) return;
    btn.dataset.s = '1'; btn.disabled = true; btn.textContent = '同步中…';
    try {
      const r = await fetch('/api/reconcile-project', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: SB_PROJ }),
      });
      const d = await r.json();
      if (!d.ok) { btn.disabled = false; delete btn.dataset.s; btn.textContent = '同步失败，请导出诊断包'; return; }
      if (d.ok && d.activeRoute && !d.activeRoute.startsWith('/storyboard-status')) {
        btn.textContent = '已同步当前项目状态'; setTimeout(() => { window.location.href = d.activeRoute; }, 600); return;
      }
      btn.textContent = (d.patched && d.patched.length) ? '已同步当前项目状态' : '未发现新的生成结果';
      sbPolling = true; sbPoll();
      setTimeout(() => { btn.disabled = false; delete btn.dataset.s; btn.textContent = '同步状态'; }, 3000);
    } catch(e) { btn.disabled = false; delete btn.dataset.s; btn.textContent = '同步失败，请导出诊断包'; }
  }
  document.getElementById('sb-sync-btn').addEventListener('click', sbSync);
  </script>`}
</body>
</html>`;
}

function renderReviewListPage() {
  const result = readPendingReviews();
  const recentProjects = listRecentProjectStates(1);
  const latestProjectId = recentProjects[0]?.projectId || '';

  const cards = result.items.map((item) => {
    const title = item.projectId || `execution_${item.executionId}`;
    const meta = [
      item.productName ? `产品：${item.productName}` : '',
      `轮次：${item.reviewRound}`,
      item.panelCount ? `分镜数：${item.panelCount}` : '',
      item.startedAt ? `开始：${item.startedAt}` : '',
    ].filter(Boolean).join(' · ');
    const thumbs = item.previews.length
      ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;margin-top:12px;">${item.previews.map((url) => `<img src="${htmlEscape(normalizeAssetUrl(url))}" loading="lazy" style="width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:var(--r);border:1px solid var(--border);display:block;" />`).join('')}</div>`
      : '<p class="muted" style="font-size:13px;margin-top:8px;">预览图还没准备好，稍后自动刷新。</p>';
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;">
        <div>
          <div style="font-weight:600;margin-bottom:4px;">${htmlEscape(title)}</div>
          <div class="muted" style="font-size:13px;">${htmlEscape(meta)}</div>
          <div class="muted" style="font-size:12px;margin-top:4px;"><code>${htmlEscape(item.reviewContextPath)}</code></div>
        </div>
        <a class="btn btn-primary" href="${htmlEscape(item.reviewOpenUrl)}" target="_blank" rel="noopener noreferrer" style="flex:none;">打开审核表单</a>
      </div>
      ${thumbs}
    </div>`;
  }).join('');

  // Scan REVIEW_CONTEXT_ROOT for any project with a submitted sidecar + existing panel images
  // (handles case where stale/submitted context exists but no valid review context remains)
  const _rlStalePid = (() => {
    try {
      if (!fs.existsSync(REVIEW_CONTEXT_ROOT)) return null;
      const _chkPanel = (pid) => {
        const ptok = pid.toLowerCase();
        const _c = (dir, pfx, ext) => {
          try { return fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.startsWith(pfx) && f.endsWith(ext)); }
          catch { return false; }
        };
        return _c(path.join(CACHE_ROOT, 'nanobanana'), `storyboard_${ptok}_`, '.png') ||
               _c(path.join(CACHE_ROOT, '分镜图裁剪', 'full'), `panel_full_${ptok}_`, '.jpg') ||
               _c(path.join(CACHE_ROOT, '分镜图裁剪', 'previews'), `panel_preview_${ptok}_`, '.jpg');
      };
      for (const n of fs.readdirSync(REVIEW_CONTEXT_ROOT)) {
        if (!n.startsWith('review_context_') || !n.endsWith('.submitted.json')) continue;
        const m = n.match(/^review_context_(proj_[a-zA-Z0-9]+)/);
        if (!m) continue;
        const pid = m[1];
        if (!getLatestReviewContextFileForProject(pid) && _chkPanel(pid)) return pid;
      }
      return null;
    } catch { return null; }
  })();
  // Also check the active project itself (Level-5: panels + no valid context)
  const _rlStage = latestProjectId ? (() => { try { return deriveProjectStage(latestProjectId); } catch { return null; } })() : null;
  const _rlActiveMissing = _rlStage?.stage === 'storyboard_generated' && !getLatestReviewContextFileForProject(latestProjectId);
  const _rlMissingPid = _rlStalePid || ((_rlActiveMissing && latestProjectId) ? latestProjectId : null);
  const _emptyMsg = _rlMissingPid
    ? `<div class="card"><div style="background:rgba(220,38,38,.08);border:1px solid #dc2626;border-radius:8px;padding:12px 16px;color:#dc2626;font-size:13px;margin-bottom:10px;">⚠ 当前分镜审核数据无效，请重新生成分镜图或同步项目状态。</div><div class="btn-row" style="margin-top:8px;"><a class="btn btn-primary" href="/active?project_id=${encodeURIComponent(_rlMissingPid)}">返回项目页重新生成</a></div></div>`
    : '<div class="card"><p class="muted">分镜仍在后台生成，页面每 8 秒自动刷新。工作流进入审核阶段后，入口会出现在这里。</p></div>';
  const body = result.ok
    ? result.items.length ? cards : _emptyMsg
    : `<div class="card"><p class="muted">待审核列表读取失败：${htmlEscape(result.error)}</p></div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="refresh" content="8" />
  <title>待审核分镜</title>
  ${commonCSS()}
</head>
<body>
  ${renderStageNav('storyboard')}
  <main>
    <div class="btn-row" style="margin-bottom:14px;">
      <a class="btn btn-secondary" href="/">工作台</a>
      ${latestProjectId ? `<a class="btn btn-secondary" href="/active?project_id=${encodeURIComponent(latestProjectId)}">继续当前项目</a>` : ''}
    </div>
    <h1>待审核分镜</h1>
    <p class="muted" style="margin-bottom:16px;">初始表单提交后会立刻返回到这里，主流程继续在后台跑。工作流进入审核阶段后，"打开审核表单"入口会出现在这里。</p>
    ${body}
  </main>
</body>
</html>`;
}

const _recentSubmits = new Map(); // dedup: key → {since, ts}
const PRODUCT_IMAGE_MAX_COUNT = 5;
const PRODUCT_IMAGE_MAX_TOTAL_BYTES = 80 * 1024 * 1024;

function getProductImageFiles(parsed) {
  return parsed.filter((f) => f.type === 'file' && f.name === 'field-5' && f.buffer.length > 0);
}

function validateProductSubmissionParts(parsed) {
  const productName = (parsed.find((f) => f.name === 'field-0')?.value || '').trim();
  const targetMarket = (parsed.find((f) => f.name === 'field-2')?.value || '').trim();
  const targetLanguage = (parsed.find((f) => f.name === 'field-3')?.value || '').trim();
  const imageFiles = getProductImageFiles(parsed);
  const totalImageBytes = imageFiles.reduce((sum, file) => sum + file.buffer.length, 0);
  if (!productName) throw new Error('请填写产品名称');
  if (imageFiles.length === 0) throw new Error('请至少上传 1 张产品图片（jpg/png）。AI 创意方向需要真实产品图片作为输入，不支持纯文字生成。');
  if (imageFiles.length > PRODUCT_IMAGE_MAX_COUNT) throw new Error(`最多上传 ${PRODUCT_IMAGE_MAX_COUNT} 张产品图片，请减少图片数量后重试。`);
  if (totalImageBytes > PRODUCT_IMAGE_MAX_TOTAL_BYTES) throw new Error('图片过大，请压缩后重试。');
  return { productName, targetMarket, targetLanguage, imageFiles, totalImageBytes };
}

function buildSubmitDedupKey(name, market, lang, imageFiles) {
  const imageHash = crypto.createHash('sha1');
  for (const file of imageFiles) {
    imageHash.update(String(file.filename || ''));
    imageHash.update('\0');
    imageHash.update(String(file.buffer.length));
    imageHash.update('\0');
    imageHash.update(file.buffer);
    imageHash.update('\0');
  }
  return crypto.createHash('sha1').update([
    name.trim().toLowerCase(),
    market.trim().toLowerCase(),
    lang.trim().toLowerCase(),
    imageHash.digest('hex'),
  ].join('|')).digest('hex');
}

function noPaidSmokeEnabled() {
  return process.env.AI_VIDEO_NO_PAID_SMOKE === '1';
}

function productField(parsed, name) {
  return String((parsed.find((f) => f.name === name && f.type === 'field')?.value || '')).trim();
}

function noPaidSmokeProjectId(startedAt) {
  return `proj_smoke_${Number(startedAt || Date.now())}`;
}

function noPaidSmokeSelectedConcept(productName) {
  return {
    concept_id: 'concept_smoke_1',
    concept_name: 'Fast UGC problem-solution demo',
    content_goal: 'Use a fast TikTok-native hook to show the product solving one clear everyday pain point.',
    core_selling_angle: 'White-background product reference controls product shape/color; lifestyle panels only add usage context.',
    target_user: 'TikTok shoppers who need a practical, easy-to-understand product demo.',
    usage_scene: 'Everyday home or outdoor use based on the submitted product.',
    visual_hook: 'Start with an obvious problem in the first 1-2 seconds, then reveal the product entering the frame.',
    visual_expression: 'Handheld smartphone UGC, short actions, natural light, imperfect but readable framing.',
    model_profile: 'Local creator style; natural expression, quick reaction, no over-polished commercial acting.',
    video_type: 'pure_display_or_light_voiceover',
    why_it_fits_tiktok: 'Clear hook, simple product payoff, fast pacing, and stable first-frame references make it usable for viral testing.',
    recommended_grid: '6_grid',
    risk_notes: `Keep ${productName || 'the product'} visually identical to the uploaded white-background reference image.`,
  };
}

function noPaidSmokeShots(productName, targetLanguage) {
  const p = productName || 'the product';
  const lang = targetLanguage || 'English';
  return [
    ['shot_1', 1, 'Hook', '0-3s', 'Close handheld shot of the pain point before the product appears.', 'A hand pauses above the messy or inconvenient scene, showing urgency.', `${p} is not yet centered; product reference must stay identical once it enters.`, 'Fixed handheld close-up with a tiny push-in.', `Quick worried expression or tense hand gesture. Voiceover (${lang}, local creator tone): "Wait, this is exactly the problem."`, 'Keep the same product color, shape, material, and scale from the reference image.'],
    ['shot_2', 2, 'Product Reveal', '3-6s', 'The product enters frame clearly from the side.', 'Hand places the product in the center and briefly tilts it toward camera.', `${p} fills the center; all visible details match the uploaded reference image.`, 'Slow handheld follow, no zoom jump.', `Relieved, confident tone. Voiceover (${lang}): "This little thing fixes it fast."`, 'Do not morph the product; no extra parts or color changes.'],
    ['shot_3', 3, 'Demo', '6-10s', 'One simple use action demonstrates the main benefit.', 'The creator performs one clean, easy-to-generate product action.', `Product remains fully visible during the action; use is logical for ${p}.`, 'Static close shot with slight hand movement.', `Focused expression, quick pace. Voiceover (${lang}): "Just one simple move."`, 'Hands must stay natural; product should not drift or resize.'],
    ['shot_4', 4, 'Proof', '10-14s', 'Show the before/after or immediate result.', 'Hand points to the solved area or the clear result.', `${p} stays in frame as proof, same silhouette and material.`, 'Small pan from product to result.', `Small satisfied reaction. Voiceover (${lang}): "That is way cleaner."`, 'Result must follow from the previous action, no scene jump.'],
    ['shot_5', 5, 'Lifestyle Fit', '14-19s', 'Show the product fitting naturally into daily life.', 'Creator picks up or stores the product in a realistic location.', `${p} remains the same size and color; no alternate version appears.`, 'Handheld medium close-up.', `Casual, friendly tone. Voiceover (${lang}): "I would actually keep this around."`, 'Keep the same person/hand styling and product orientation.'],
    ['shot_6', 6, 'Soft Convert', '19-24s', 'Final payoff with the product and solved result visible.', 'Creator gives a small approving gesture or places product beside result.', `${p} is the final hero object, matching the reference image exactly.`, 'Stable close-up, natural light.', `Satisfied but not salesy. Voiceover (${lang}): "Tiny upgrade, real difference."`, 'No text, subtitles, logos, UI, or watermark.'],
  ].map(([shot_id, shot_order, stage, duration, scene_setting, visual_action, product_state, camera_movement, optional_voiceover_local, continuity_requirements]) => ({
    shot_id,
    shot_order,
    stage,
    duration,
    scene_setting,
    visual_action,
    product_state,
    camera_movement,
    optional_voiceover_local,
    expression_focus: 'Fast TikTok UGC pacing, clear facial/hand emotion, natural creator energy.',
    continuity_requirements,
    video_prompt: [
      'Duration: 8 seconds.',
      'Use the corresponding storyboard panel as the first frame.',
      `Main Action: ${visual_action}`,
      `Camera: ${camera_movement}`,
      `Product Focus: ${product_state}`,
      `Continuity: ${continuity_requirements}`,
      'Style: handheld smartphone TikTok UGC, natural light, quick readable action, authentic local creator feeling.',
      'Avoid: text, subtitles, UI, watermark, logo, product morphing, face change, distorted hands, extra fingers, cinematic commercial look.',
    ].join('\n'),
    video_prompt_original_zh: [
      `场景：${scene_setting}`,
      `动作：${visual_action}`,
      `产品状态：${product_state}`,
      `运镜：${camera_movement}`,
      `情绪：${optional_voiceover_local}`,
      `连续性：${continuity_requirements}`,
    ].join('\n'),
  }));
}

function writeNoPaidSmokeIntakeArtifacts(parsed, meta, startedAt) {
  const projectId = noPaidSmokeProjectId(startedAt);
  const pid = projectId.replace(/[^a-zA-Z0-9_-]+/g, '_');
  const now = new Date().toISOString();
  const productName = meta.productName;
  const productDesc = productField(parsed, 'field-1');
  const targetMarket = meta.targetMarket || productField(parsed, 'field-2') || '用户填写目标市场';
  const targetLanguage = meta.targetLanguage || productField(parsed, 'field-3') || '用户填写目标语言';
  const imageDir = path.join(CACHE_ROOT, 'product-images', pid);
  fs.mkdirSync(imageDir, { recursive: true });
  const productImages = meta.imageFiles.map((file, index) => {
    const ext = path.extname(file.filename || '').toLowerCase() || '.jpg';
    const safeName = `product_${String(index + 1).padStart(2, '0')}${ext}`;
    const localPath = path.join(imageDir, safeName);
    fs.writeFileSync(localPath, file.buffer);
    return {
      index: index + 1,
      original_filename: file.filename || safeName,
      content_type: file.contentType || 'application/octet-stream',
      byte_size: file.buffer.length,
      local_path: localPath,
      consistency_role: index === 0 ? 'primary_product_reference' : 'supporting_detail_reference',
    };
  });
  const concept = noPaidSmokeSelectedConcept(productName);
  const contextPath = path.join(CONCEPT_CONTEXT_ROOT, `concept_context_${pid}.json`);
  const conceptContext = {
    project_id: projectId,
    product_name: productName,
    product_desc: productDesc,
    product_selling_points: productDesc,
    target_market: targetMarket,
    target_language: targetLanguage,
    creative_task_type: 'no_paid_smoke',
    product_image_count: productImages.length,
    product_image_local_paths: productImages.map((img) => img.local_path),
    product_images_meta: productImages,
    product_consistency_rule: 'Use the uploaded white-background/product reference image as the primary source of truth for product shape, color, size, material, and visible parts. Supporting scene images may inform context only.',
    concept_count: 1,
    creative_concepts: [concept],
    smoke_fixture: true,
    created_at: now,
  };
  fs.writeFileSync(contextPath, JSON.stringify(conceptContext, null, 2));
  updateProjectState(projectId, {
    product_name: productName,
    product_desc: productDesc,
    target_market: targetMarket,
    target_language: targetLanguage,
    creative_task_type: 'no_paid_smoke',
    product_image_count: productImages.length,
    concept_context_path: contextPath,
    stage: 'creative_generated',
    status: 'waiting_for_concept_selection',
    smoke_fixture: true,
    created_at: now,
  });
  return { projectId, contextPath, conceptContext };
}

function writeNoPaidSmokeScriptArtifacts(projectId, selectedConcept = {}) {
  const state = readProjectState(projectId);
  const productName = state.product_name || selectedConcept.product_name || 'Smoke Test Product';
  const targetLanguage = state.target_language || 'English';
  const conceptFile = getLatestConceptContextFileForProject(projectId);
  const conceptPath = conceptFile ? path.join(CONCEPT_CONTEXT_ROOT, conceptFile) : '';
  const shots = noPaidSmokeShots(productName, targetLanguage);
  const scriptContext = {
    project_id: projectId,
    product_name: productName,
    product_desc: state.product_desc || '',
    target_market: state.target_market || '',
    target_language: targetLanguage,
    creative_task_type: 'no_paid_smoke',
    selected_concept_id: selectedConcept.concept_id || selectedConcept.selected_concept_id || 'concept_smoke_1',
    selected_concept_name: selectedConcept.concept_name || 'Fast UGC problem-solution demo',
    selected_concept_json: selectedConcept,
    concept_context_path: conceptPath,
    structure: {
      hook: '0-3s: clear visual problem and emotional stop point.',
      educate: '3-19s: reveal product, show one simple action, prove the result.',
      convert: '19-24s: soft payoff, creator-level recommendation without hard ad tone.',
    },
    shots,
    smoke_fixture: true,
    created_at: new Date().toISOString(),
  };
  fs.mkdirSync(SCRIPT_CONTEXT_ROOT, { recursive: true });
  fs.writeFileSync(scriptContextPath(projectId), JSON.stringify(scriptContext, null, 2));
  updateProjectState(projectId, {
    stage: 'script_generated',
    status: 'script_generated',
    script_context_path: scriptContextPath(projectId),
    selected_concept_id: scriptContext.selected_concept_id,
  });
  return scriptContext;
}

function writeNoPaidSmokeStoryboardArtifacts(projectId) {
  const pid = String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_');
  const scriptContext = fs.existsSync(scriptContextPath(projectId)) ? readContextFile(scriptContextPath(projectId)) : writeNoPaidSmokeScriptArtifacts(projectId, {});
  const shots = Array.isArray(scriptContext.shots) ? scriptContext.shots : noPaidSmokeShots(scriptContext.product_name || '', scriptContext.target_language || '');
  const conceptFile = getLatestConceptContextFileForProject(projectId);
  const conceptContext = conceptFile ? readContextFile(path.join(CONCEPT_CONTEXT_ROOT, conceptFile)) : {};
  const productPaths = Array.isArray(conceptContext.product_image_local_paths) ? conceptContext.product_image_local_paths : [];
  const sourceImage = productPaths.find((p) => p && fs.existsSync(p)) || path.join(PROJECT_ROOT, 'tests', 'fixtures', 'ui-smoke-product.jpg');
  const previewDir = path.join(CACHE_ROOT, '分镜图裁剪', 'previews');
  const fullDir = path.join(CACHE_ROOT, '分镜图裁剪', 'full');
  fs.mkdirSync(previewDir, { recursive: true });
  fs.mkdirSync(fullDir, { recursive: true });
  const panels = shots.map((shot, index) => {
    const order = Number(shot.shot_order || index + 1);
    const previewPath = path.join(previewDir, `panel_preview_${pid}_${String(order).padStart(2, '0')}.jpg`);
    const fullPath = path.join(fullDir, `panel_full_${pid}_${String(order).padStart(2, '0')}.jpg`);
    try {
      fs.copyFileSync(sourceImage, previewPath);
      fs.copyFileSync(sourceImage, fullPath);
    } catch {
      fs.writeFileSync(previewPath, '');
      fs.writeFileSync(fullPath, '');
    }
    return {
      ...shot,
      panel_preview_path: previewPath,
      panel_full_path: fullPath,
      panel_preview_url: '',
      product_reference_image_path: sourceImage,
    };
  });
  const reviewContextPath = path.join(REVIEW_CONTEXT_ROOT, `review_context_${pid}_round1.json`);
  const reviewContext = {
    project_id: projectId,
    product_name: scriptContext.product_name || '',
    target_market: scriptContext.target_market || '',
    target_language: scriptContext.target_language || '',
    selected_concept_name: scriptContext.selected_concept_name || '',
    creative_task_type: 'no_paid_smoke',
    review_round: 1,
    panel_count: panels.length,
    panel_review_pack: panels,
    product_consistency_rule: 'Each panel uses the uploaded product reference image as the authoritative product identity source.',
    smoke_fixture: true,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(reviewContextPath, JSON.stringify(reviewContext, null, 2));
  updateProjectState(projectId, {
    stage: 'storyboard_ready_for_review',
    status: 'storyboard_ready_for_review',
    review_context_path: reviewContextPath,
    panel_count: panels.length,
  });
  return { reviewContextPath, reviewContext };
}

function writeNoPaidSmokeVideoArtifacts(formBody, reviewContext) {
  const projectId = formBody.project_id || reviewContext.project_id || '';
  const pid = String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_');
  const panels = Array.isArray(reviewContext.panel_review_pack) ? reviewContext.panel_review_pack : [];
  const now = new Date().toISOString();
  fs.mkdirSync(VIDEO_OUTPUT_ROOT, { recursive: true });
  const shots = panels.map((panel, index) => {
    const order = Number(panel.shot_order || index + 1);
    const videoPath = path.join(VIDEO_OUTPUT_ROOT, `kie_veo31_${pid}_${String(order).padStart(2, '0')}_no_paid_smoke.mp4`);
    if (!fs.existsSync(videoPath)) fs.writeFileSync(videoPath, 'NO_PAID_SMOKE_PLACEHOLDER_MP4');
    return {
      shot_id: panel.shot_id || `shot_${order}`,
      shot_order: order,
      status: 'completed',
      video_path: videoPath,
      operation_name: `no_paid_smoke_${order}`,
      started_at: now,
      completed_at: now,
      error: '',
    };
  });
  const finalDir = path.join(CACHE_ROOT, 'final-video');
  fs.mkdirSync(finalDir, { recursive: true });
  const finalPath = path.join(finalDir, `final_${pid}_no_paid_smoke.mp4`);
  if (!fs.existsSync(finalPath)) fs.writeFileSync(finalPath, 'NO_PAID_SMOKE_FINAL_PLACEHOLDER_MP4');
  const progress = {
    project_id: projectId,
    review_context_path: formBody.review_context_path,
    status: 'success',
    total_panels: shots.length,
    completed_count: shots.length,
    running_count: 0,
    failed_count: 0,
    shots,
    final_merged_video_path: finalPath,
    smoke_fixture: true,
    updated_at: now,
  };
  fs.writeFileSync(progressSidecarPath(projectId), JSON.stringify(progress, null, 2));
  updateProjectState(projectId, {
    stage: 'final_generated',
    status: 'success',
    video_clip_count: shots.length,
    final_merged_video_path: finalPath,
  });
  return progress;
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    return res.end('Bad Request');
  }

  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ status: 'ok' }));
  }

  if (req.url === '/health/meta') {
    const _metaCfg = normalizeAiConfig(loadConfig());
    const _kieKey = (_metaCfg.providers?.kie?.api_key || _metaCfg.kie?.api_key || '').trim();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      status: 'ok',
      app_mode: APP_MODE,
      ui_port: PORT,
      project_root: PROJECT_ROOT,
      workflow_data_root: WORKFLOW_DATA_ROOT,
      config_path: CONFIG_PATH,
      server_pid: SERVER_PID,
      server_started_at: SERVER_STARTED_AT,
      kie_api_key_configured: !!_kieKey,
      license: (() => {
        const st = getLicenseStatus();
        return { required: st.required, ok: st.ok, device_id: st.deviceId, message: st.message };
      })(),
    }));
  }

  if (req.url === '/license/status') {
    const st = getLicenseStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      required: st.required,
      ok: st.ok,
      device_id: st.deviceId,
      message: st.message,
      activated_at: st.activatedAt || '',
      license_id: st.payload?.license_id || '',
      customer: st.payload?.customer || '',
      expires_at: st.payload?.expires_at || '',
    }));
  }

  if (req.method === 'GET' && (req.url === '/activate' || req.url === '/activate/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderActivationPage());
  }

  if (req.method === 'POST' && req.url === '/activate') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const licenseCode = String(params.get('license_code') || '').trim();
      const deviceId = getDeviceId();
      const payload = verifySignedLicenseCode(licenseCode, deviceId);
      saveLicenseRecord(licenseCode, payload);
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      return res.end();
    } catch (error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderActivationPage(getLicenseStatus(), error.message || String(error)));
    }
  }

  const licenseStatus = getLicenseStatus();
  if (!licenseStatus.ok) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderActivationPage(licenseStatus));
  }

  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderHubPage());
  }

  if (req.url === '/form' || req.url.startsWith('/form?')) {
    res.writeHead(302, { Location: '/new-project', 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (req.url.startsWith('/new-project')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderProductFormPage());
  }

  if (req.method === 'POST' && req.url === '/submit-product') {
    try {
      // Auto-init default output dirs if not yet configured, then validate
      ensureDefaultOutputDirs();
      const _cfg = loadConfig();
      const _sbDir = String(_cfg?.output?.storyboard_dir || _cfg?.storyboard_output_dir || '').trim();
      const _vDir = String(_cfg?.output?.video_dir || _cfg?.video_output_dir || '').trim();
      const _checkDir = (p) => {
        if (!p) return { ok: false, reason: '路径未配置' };
        const safe = isOutputPathSafe(p);
        if (!safe.ok) return { ok: false, reason: safe.reason };
        const exp = safe.normalized;
        try { fs.mkdirSync(exp, { recursive: true }); } catch {}
        if (!fs.existsSync(exp)) return { ok: false, reason: `路径不存在且无法创建：${exp}` };
        try { const t = path.join(exp, '.write_test_' + Date.now()); fs.writeFileSync(t, ''); fs.unlinkSync(t); return { ok: true }; }
        catch { return { ok: false, reason: `路径不可写：${exp}` }; }
      };
      const _sbCheck = _checkDir(_sbDir);
      const _vCheck = _checkDir(_vDir);
      if (!_sbCheck.ok || !_vCheck.ok) {
        const _msg = [
          !_sbCheck.ok ? `分镜保存目录：${_sbCheck.reason}` : null,
          !_vCheck.ok ? `视频保存目录：${_vCheck.reason}` : null,
        ].filter(Boolean).join('；');
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderProductFormPage(`保存路径异常，无法提交表单：${_msg}。请先到"系统配置"页面配置正确的保存路径，或点击"恢复默认位置"。`));
      }
      // Buffer body once for dedup check and forwarding
      const _submitContentType = req.headers['content-type'] || '';
      const _submitBody = await readRequestBuffer(req);
      const _submitParsed = parseMultipartForm(_submitBody, _submitContentType);
      const _submitMeta = validateProductSubmissionParts(_submitParsed);
      const _spDedupKey = buildSubmitDedupKey(
        _submitMeta.productName,
        _submitMeta.targetMarket,
        _submitMeta.targetLanguage,
        _submitMeta.imageFiles,
      );
      // Expire stale dedup entries (>30s)
      const _spNow = Date.now();
      for (const [k, v] of _recentSubmits) { if (_spNow - v.ts > 30000) _recentSubmits.delete(k); }
      if (_recentSubmits.has(_spDedupKey)) {
        const _prior = _recentSubmits.get(_spDedupKey);
        res.writeHead(302, { Location: `/submitted?since=${_prior.since}&dedup=1`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      const submitStartedAt = Date.now();
      _recentSubmits.set(_spDedupKey, { since: submitStartedAt, ts: submitStartedAt });
      if (noPaidSmokeEnabled()) {
        writeNoPaidSmokeIntakeArtifacts(_submitParsed, _submitMeta, submitStartedAt);
        res.writeHead(302, { Location: `/submitted?since=${submitStartedAt}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      await submitProductToN8n(req, _submitBody);
      // Use pre-submit timestamp so getLatestProjectState can find files written during execution.
      // If we used Date.now() here (post-return), the file mtime would be < since and never found.
      res.writeHead(302, { Location: `/submitted?since=${submitStartedAt}`, 'Cache-Control': 'no-store' });
      return res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderProductFormPage(err.message || String(err)));
    }
  }

  if (req.url.startsWith('/submitted')) {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const sinceMs = Number(url.searchParams.get('since') || 0);
    const isDedup = url.searchParams.get('dedup') === '1';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderSubmittedPage(sinceMs, { isDedup }));
  }

  if (req.url.startsWith('/active')) {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const projectId = String(url.searchParams.get('project_id') || '').trim();
    const sinceMs = Number(url.searchParams.get('since') || 0);
    if (projectId) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderCurrentProjectPage(projectId, { notesSaved: url.searchParams.get('saved_notes') === '1' }));
    }
    const activeRoute = getActiveRoute(projectId, sinceMs);
    if (activeRoute === '/' && sinceMs > 0) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderSubmittedPage(sinceMs));
    }
    res.writeHead(302, { Location: activeRoute, 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (req.url === '/concepts' || req.url === '/concepts/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderConceptListPage());
  }

  if (req.url.startsWith('/concepts/item')) {
    const contextPath = getConceptContextPathFromRequestUrl(req.url);
    if (!contextPath || !fs.existsSync(contextPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Concept context not found');
    }
    const pageUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(
      renderConceptDetailPage(contextPath, {
        feedbackSaved: pageUrl.searchParams.get('feedback_saved') === '1',
        revisionSavedConceptId: pageUrl.searchParams.get('saved_concept_id') || '',
        selectedSaved: pageUrl.searchParams.get('selected_saved') === '1',
      }),
    );
  }

  if (req.url.startsWith('/concept-status')) {
    const contextPath = getConceptContextPathFromRequestUrl(req.url);
    if (!contextPath || !fs.existsSync(contextPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Concept context not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderConceptStatusPage(contextPath));
  }

  if (req.method === 'POST' && req.url === '/concept-select') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const formBody = {
        project_id: String(params.get('project_id') || '').trim(),
        selected_concept_id: String(params.get('selected_concept_id') || '').trim(),
        concept_context_path: String(params.get('concept_context_path') || '').trim(),
      };
      if (!formBody.concept_context_path || !fs.existsSync(formBody.concept_context_path)) {
        throw new Error('创意方向上下文不存在，无法继续提交。');
      }
      const context = readContextFile(formBody.concept_context_path);
      const selectedConcept = Array.isArray(context.creative_concepts)
        ? context.creative_concepts.find((item) => String(item.concept_id || '') === formBody.selected_concept_id)
        : null;
      if (selectedConcept) {
        const revisionState = readConceptRevisionState(formBody.project_id);
        const revision = revisionState.revisions?.[formBody.selected_concept_id] || {};
        markDownstreamStale(formBody.project_id, 'concept_reselected');
        updateSelectedConceptSidecar(formBody.project_id, {
          selected_concept_id: formBody.selected_concept_id,
          selected_concept_json: {
            ...selectedConcept,
            ...(revision.fields || {}),
            concept_id: formBody.selected_concept_id,
          },
          concept_context_path: formBody.concept_context_path,
          revision_source: revision.updated_at ? 'manual_edit' : 'model_output',
          revision_state_path: conceptRevisionPath(formBody.project_id),
        });
      }
      if (noPaidSmokeEnabled()) {
        writeNoPaidSmokeScriptArtifacts(formBody.project_id, selectedConcept || {});
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(
          renderConceptSubmitPage({
            ok: true,
            message: '',
            contextPath: formBody.concept_context_path,
            executionId: 'no_paid_smoke',
          }),
        );
      }
      await forwardConceptSelection(formBody);
      const execution = findLatestExecutionForProject(formBody.project_id, CONCEPT_SELECT_WORKFLOW_ID);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderConceptSubmitPage({
          ok: true,
          message: '',
          contextPath: formBody.concept_context_path,
          executionId: execution?.id || '',
        }),
      );
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderConceptSubmitPage({
          ok: false,
          message: error.message || String(error),
        }),
      );
    }
  }

  if (req.method === 'POST' && req.url === '/concept-revision-save') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const projectId = String(params.get('project_id') || '').trim();
      const contextName = String(params.get('concept_context_path') || '').trim();
      const conceptId = String(params.get('concept_id') || '').trim();
      if (!projectId) throw new Error('缺少 project_id');
      if (!contextName || contextName.includes('/') || contextName.includes('\\')) throw new Error('缺少有效 concept_context_path');
      if (!conceptId) throw new Error('缺少 concept_id');
      const contextPath = path.join(CONCEPT_CONTEXT_ROOT, contextName);
      if (!fs.existsSync(contextPath)) throw new Error('创意方向上下文不存在，无法保存修改。');
      saveConceptRevisionState(projectId, conceptId, {
        fields: {
          target_user: String(params.get('target_user') || '').trim(),
          usage_scene: String(params.get('usage_scene') || '').trim(),
          visual_expression: String(params.get('visual_expression') || '').trim(),
          hook_strategy: String(params.get('hook_strategy') || '').trim(),
          video_type: String(params.get('video_type') || '').trim(),
          core_selling_angle: String(params.get('core_selling_angle') || '').trim(),
          why_it_fits_tiktok: String(params.get('why_it_fits_tiktok') || '').trim(),
          recommended_grid: String(params.get('recommended_grid') || '').trim(),
          risk_notes: String(params.get('risk_notes') || '').trim(),
          model_profile: String(params.get('model_profile') || '').trim(),
        },
        source_context: contextName,
      });
      // Note: sidecar is only updated on explicit concept selection, not on revision-save alone.
      res.writeHead(302, {
        Location: `/concepts/item?context=${encodeURIComponent(contextName)}&saved_concept_id=${encodeURIComponent(conceptId)}`,
        'Cache-Control': 'no-store',
      });
      return res.end();
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(error.message || String(error));
    }
  }

  if (req.method === 'POST' && req.url === '/concept-select-with-edit') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const projectId = String(params.get('project_id') || '').trim();
      const contextName = String(params.get('concept_context_path') || '').trim();
      const conceptId = String(params.get('concept_id') || '').trim();
      if (!projectId) throw new Error('缺少 project_id');
      if (!contextName || contextName.includes('/') || contextName.includes('\\')) throw new Error('缺少有效 concept_context_path');
      if (!conceptId) throw new Error('缺少 concept_id');
      const contextPath = path.join(CONCEPT_CONTEXT_ROOT, contextName);
      if (!fs.existsSync(contextPath)) throw new Error('创意方向上下文不存在，无法继续提交。');
      const revision = saveConceptRevisionState(projectId, conceptId, {
        fields: {
          target_user: String(params.get('target_user') || '').trim(),
          usage_scene: String(params.get('usage_scene') || '').trim(),
          visual_expression: String(params.get('visual_expression') || '').trim(),
          hook_strategy: String(params.get('hook_strategy') || '').trim(),
          video_type: String(params.get('video_type') || '').trim(),
          core_selling_angle: String(params.get('core_selling_angle') || '').trim(),
          why_it_fits_tiktok: String(params.get('why_it_fits_tiktok') || '').trim(),
          recommended_grid: String(params.get('recommended_grid') || '').trim(),
          risk_notes: String(params.get('risk_notes') || '').trim(),
          model_profile: String(params.get('model_profile') || '').trim(),
        },
        source_context: contextName,
      });
      const nextContext = readContextFile(contextPath);
      const nextConcept = Array.isArray(nextContext.creative_concepts)
        ? nextContext.creative_concepts.find((item) => String(item.concept_id || '') === conceptId)
        : null;
      if (!nextConcept) {
        throw new Error('找不到对应创意方向，无法继续提交。');
      }
      markDownstreamStale(projectId, 'concept_reselected');
      updateSelectedConceptSidecar(projectId, {
        selected_concept_id: conceptId,
        selected_concept_json: {
          ...nextConcept,
          ...revision.fields,
          concept_id: conceptId,
        },
        concept_context_path: contextPath,
        revision_source: 'manual_edit',
        revision_state_path: conceptRevisionPath(projectId),
      });
      if (noPaidSmokeEnabled()) {
        writeNoPaidSmokeScriptArtifacts(projectId, { ...nextConcept, ...revision.fields, concept_id: conceptId });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(
          renderConceptSubmitPage({
            ok: true,
            message: '',
            contextPath,
            executionId: 'no_paid_smoke',
          }),
        );
      }
      await forwardConceptSelection({
        project_id: projectId,
        selected_concept_id: conceptId,
        concept_context_path: contextPath,
        selected_concept_json: {
          ...nextConcept,
          ...revision.fields,
          concept_id: conceptId,
        },
        selected_concept_revision: revision,
        concept_revision_state: readConceptRevisionState(projectId),
      });
      const execution = findLatestExecutionForProject(projectId, CONCEPT_SELECT_WORKFLOW_ID);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderConceptSubmitPage({
          ok: true,
          message: '',
          contextPath,
          executionId: execution?.id || '',
        }),
      );
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderConceptSubmitPage({
          ok: false,
          message: error.message || String(error),
        }),
      );
    }
  }

  if (req.method === 'POST' && req.url === '/concept-feedback') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const projectId = String(params.get('project_id') || '').trim();
      const contextName = String(params.get('context') || '').trim();
      const freeFormRequirement = String(params.get('free_form_requirement') || params.get('feedback') || '').trim();
      if (!projectId) throw new Error('缺少 project_id');
      if (!contextName || contextName.includes('/') || contextName.includes('\\')) throw new Error('缺少有效 context');
      const contextPath = path.join(CONCEPT_CONTEXT_ROOT, contextName);
      if (!fs.existsSync(contextPath)) throw new Error('创意方向上下文不存在，无法重跑。');
      if (freeFormRequirement) {
        appendProjectFeedback(projectId, {
          stage: 'director',
          feedback: freeFormRequirement,
          context: contextName,
          mode: 'director_rerun',
        });
      }
      // Call text model directly — no n8n webhook needed for concept regeneration
      rerunDirectorConcepts(contextPath, freeFormRequirement);
      res.writeHead(302, { Location: `/concepts/item?context=${encodeURIComponent(contextName)}&feedback_saved=1`, 'Cache-Control': 'no-store' });
      return res.end();
    } catch (error) {
      const errMsg = htmlEscape(error.message || String(error));
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>错误</title></head><body style="font-family:sans-serif;padding:32px;max-width:600px"><h2 style="color:#dc2626">创意方向重新生成失败</h2><p style="color:#374151">${errMsg}</p><a href="/concepts" style="color:#2563eb">← 返回创意方向列表</a></body></html>`);
    }
  }

  if (req.method === 'POST' && req.url === '/project-notes-save') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const projectId = String(params.get('project_id') || '').trim();
      const projectNotes = String(params.get('project_notes') || '').trim();
      if (!projectId) throw new Error('缺少 project_id');
      saveProjectNotes(projectId, projectNotes);
      res.writeHead(302, { Location: `/active?project_id=${encodeURIComponent(projectId)}&saved_notes=1`, 'Cache-Control': 'no-store' });
      return res.end();
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(error.message || String(error));
    }
  }

  if (req.url === '/reviews' || req.url === '/reviews/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderReviewListPage());
  }

  if (req.url === '/reviews.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(readPendingReviews(), null, 2));
  }

  if (req.url.startsWith('/reviews/context')) {
    const contextPath = getContextPathFromRequestUrl(req.url);
    if (!contextPath || !fs.existsSync(contextPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Review context not found');
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(contextPath, 'utf8'));
  }

  if (req.url.startsWith('/reviews/item')) {
    const contextPath = getContextPathFromRequestUrl(req.url);
    if (!contextPath || !fs.existsSync(contextPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Review context not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderReviewDetailPage(contextPath));
  }

  if (req.url.startsWith('/review-status')) {
    const contextPath = getContextPathFromRequestUrl(req.url);
    if (!contextPath || !fs.existsSync(contextPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Review context not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderReviewStatusPage(contextPath));
  }

  if (req.method === 'POST' && req.url === '/review-submit') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const rawDecision = String(params.get('review_decision') || '').trim();
      const normalizedBadShotIds = normalizeShotIdList(String(params.get('bad_shot_ids') || '').trim());
      const formBody = {
        review_decision: rawDecision,
        bad_shot_ids: normalizedBadShotIds.join(','),
        review_feedback: String(params.get('review_feedback') || '').trim(),
        review_context_path: normalizeReviewContextPath(String(params.get('review_context_path') || '').trim()),
        review_round: Number(params.get('review_round') || 1),
        project_id: String(params.get('project_id') || '').trim(),
        product_name: String(params.get('product_name') || '').trim(),
      };
      if (!formBody.review_context_path || !fs.existsSync(formBody.review_context_path)) {
        throw new Error('审核上下文不存在，无法继续提交。');
      }
      const reviewContext = readContextFile(formBody.review_context_path);
      const submittedShotCount = Number(
        reviewContext.panel_count ||
        (Array.isArray(reviewContext.panel_review_pack) ? reviewContext.panel_review_pack.length : 0) ||
        6,
      );
      const needsRedo = /重做|redo|reject|revise/i.test(rawDecision);

      if (noPaidSmokeEnabled()) {
        if (needsRedo) {
          if (!formBody.project_id) throw new Error('缺少 project_id，无法重新生成分镜。');
          markDownstreamStale(formBody.project_id, 'storyboard_regenerated', 'storyboard');
          const { reviewContextPath } = writeNoPaidSmokeStoryboardArtifacts(formBody.project_id);
          fs.writeFileSync(
            submittedSidecarPath(reviewContextPath),
            JSON.stringify(
              {
                submittedAt: new Date().toISOString(),
                review_decision: formBody.review_decision,
                executionId: 'no_paid_smoke',
                redirected_stage: 'storyboard_regeneration',
                smoke_fixture: true,
              },
              null,
              2,
            ),
          );
          const _redoActiveUrl = `/active?project_id=${encodeURIComponent(formBody.project_id)}`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="1; url=${_redoActiveUrl}"><title>分镜重新生成中</title>${commonCSS()}</head><body>${renderStageNav('storyboard')}<main style="max-width:680px;"><div class="card" style="margin-top:40px;"><h1>分镜图重新生成中…</h1><p>无付费冒烟模式已写入新的本地分镜审核数据。</p><div class="btn-row"><a class="btn btn-primary" href="${_redoActiveUrl}">进入当前项目</a><a class="btn btn-secondary" href="/reviews">分镜列表</a></div></div></main></body></html>`);
        }

        writeNoPaidSmokeVideoArtifacts(formBody, reviewContext);
        fs.writeFileSync(
          submittedSidecarPath(formBody.review_context_path),
          JSON.stringify(
            {
              submittedAt: new Date().toISOString(),
              review_decision: formBody.review_decision,
              bad_shot_ids: formBody.bad_shot_ids,
              executionId: 'no_paid_smoke',
              executionStatus: 'success',
              redirected_stage: 'video_generation',
              project_context: buildRunContextSummary(formBody.project_id),
              selected_concept_json: readContextFile(selectedConceptSidecarPath(formBody.project_id)).selected_concept_json || {},
              prompt_center_version: loadPromptCenter()._version || '',
              smoke_fixture: true,
            },
            null,
            2,
          ),
        );
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(
          renderSubmitResultPage({
            ok: true,
            message: `无付费冒烟：已模拟 ${submittedShotCount} 个镜头的视频进度，未调用 Veo。`,
            contextPath: formBody.review_context_path,
            executionId: 'no_paid_smoke',
          }),
        );
      }

      // B1: Project-level idempotency guard — only for normal (non-redo) submissions
      if (!needsRedo && formBody.project_id) {
        // Check submitted sidecar first (fastest path)
        const _sidecarsPath = submittedSidecarPath(formBody.review_context_path);
        if (_sidecarsPath && fs.existsSync(_sidecarsPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(renderSubmitResultPage({ ok: false, message: '当前分镜已提交过，请勿重复提交。如需重做请使用重新生成按钮。' }));
        }
        // Check live progress for running/completed shots
        const _activeGeneration = isVideoGenerationActive(formBody.project_id);
        if (_activeGeneration.active) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(renderSubmitResultPage({ ok: false, message: _activeGeneration.reason }));
        }
        const _b1Prog = readProgressFile(formBody.project_id);
        const _b1Shots = Array.isArray(_b1Prog.shots) ? _b1Prog.shots : [];
        if (_b1Shots.length > 0) {
          const _running = _b1Shots.some(s => ['running', 'submitted'].includes(String(s.status || '').toLowerCase()));
          const _allDone = _b1Shots.every(s => ['success', 'completed', 'final_generated'].includes(String(s.status || '').toLowerCase()));
          if (_running) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(renderSubmitResultPage({ ok: false, message: '视频正在生成中，请勿重复提交。请等待当前视频任务完成后再操作。' }));
          }
          if (_allDone) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(renderSubmitResultPage({ ok: false, message: '当前项目已生成视频，如需重做请点击重新生成按钮，或前往状态页查看结果。' }));
          }
        }
      }

      let execution = null;
      if (needsRedo) {
        if (!formBody.project_id) throw new Error('缺少 project_id，无法重新生成分镜。');
        markDownstreamStale(formBody.project_id, 'storyboard_regenerated', 'storyboard');
        await forwardStoryboardGeneration({ project_id: formBody.project_id });
        execution = findLatestExecutionForProject(formBody.project_id, STORYBOARD_GENERATE_WORKFLOW_ID);
        // P17-C1: storyboard is regenerating → mark old videos and final stale
        updateProjectState(formBody.project_id, {
          stage: 'storyboard_generating',
          status: 'storyboard_generating',
          video_invalidated_at: new Date().toISOString(),
          final_invalidated_at: new Date().toISOString(),
          downstream_invalidated_reason: 'storyboard_regenerated',
        });
      } else {
        if (formBody.project_id) {
          markDownstreamStale(formBody.project_id, 'video_regenerated', 'final');
        }
        await forwardReviewSubmission(formBody);
        execution = findLatestExecutionForProject(formBody.project_id);
        // B2: Mark video_generating after successful forward
        // P17-C1: new video generation started → mark any prior final video stale
        if (formBody.project_id) {
          updateProjectState(formBody.project_id, {
            stage: 'video_generating',
            status: 'video_generating',
            final_invalidated_at: new Date().toISOString(),
          });
        }
      }
      fs.writeFileSync(
        submittedSidecarPath(formBody.review_context_path),
        JSON.stringify(
          {
            submittedAt: new Date().toISOString(),
            review_decision: formBody.review_decision,
            bad_shot_ids: formBody.bad_shot_ids,
            executionId: execution?.id || null,
            executionStatus: execution?.status || null,
            redirected_stage: needsRedo ? 'storyboard_regeneration' : 'video_generation',
            project_context: buildRunContextSummary(formBody.project_id),
            selected_concept_json: readContextFile(selectedConceptSidecarPath(formBody.project_id)).selected_concept_json || {},
            prompt_center_version: loadPromptCenter()._version || '',
          },
          null,
          2,
        ),
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      if (needsRedo) {
        const _redoPid = formBody.project_id;
        const _redoExecId = execution?.id || '';
        const _redoActiveUrl = _redoPid ? `/active?project_id=${encodeURIComponent(_redoPid)}` : '/active';
        return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="1; url=${_redoActiveUrl}"><title>分镜重新生成中</title>${commonCSS()}</head><body>${renderStageNav('storyboard')}<main style="max-width:680px;"><div class="card" style="margin-top:40px;"><h1>分镜图重新生成中…</h1><p>系统已向 WF02B 发送重新生成请求，请稍候，完成后会自动跳转。</p>${_redoExecId ? `<p class="muted" style="font-size:12px;">执行 ID：<code>${htmlEscape(String(_redoExecId))}</code></p>` : ''}<div class="btn-row"><a class="btn btn-primary" href="${_redoActiveUrl}">进入当前项目</a><a class="btn btn-secondary" href="/reviews">分镜列表</a></div></div></main></body></html>`);
      }
      return res.end(
        renderSubmitResultPage({
          ok: true,
          message: `视频生成已提交，正在生成 ${submittedShotCount} 个镜头，请勿重复点击。`,
          contextPath: formBody.review_context_path,
          executionId: execution?.id || '',
        }),
      );
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderSubmitResultPage({
          ok: false,
          message: error.message || String(error),
        }),
      );
    }
  }

  if (req.method === 'POST' && req.url === '/review-rerun-failed') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const formBody = {
        review_decision: '确认通过',
        bad_shot_ids: '',
        review_feedback: '',
        review_context_path: normalizeReviewContextPath(String(params.get('review_context_path') || '').trim()),
        review_round: Number(params.get('review_round') || 1),
        project_id: String(params.get('project_id') || '').trim(),
        product_name: String(params.get('product_name') || '').trim(),
        rerun_failed_only: true,
      };
      if (!formBody.review_context_path || !fs.existsSync(formBody.review_context_path)) {
        throw new Error('审核上下文不存在，无法重跑失败镜头。');
      }
      // B-fix: block if generation already active
      const _activeCheckF = isVideoGenerationActive(formBody.project_id);
      if (_activeCheckF.active) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderSubmitResultPage({ ok: false, message: _activeCheckF.reason }));
      }
      markDownstreamStale(formBody.project_id, 'video_rerun_failed_shots', 'final');
      await forwardReviewSubmission(formBody);
      const execution = findLatestExecutionForProject(formBody.project_id);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderSubmitResultPage({
          ok: true,
          message: '',
          contextPath: formBody.review_context_path,
          executionId: execution?.id || '',
        }),
      );
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderSubmitResultPage({
          ok: false,
          message: error.message || String(error),
        }),
      );
    }
  }

  if (req.method === 'POST' && req.url === '/review-rerun-shot') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const reviewContextPath = normalizeReviewContextPath(String(params.get('review_context_path') || '').trim());
      const projectId = String(params.get('project_id') || '').trim();
      const shotId = normalizeShotIdList(String(params.get('shot_id') || '').trim())[0] || '';
      const shotOrderParam = String(params.get('shot_order') || '').trim().replace(/^shot[_-]?/i, '');
      // P12-H1e: a quality reroll of an already-successful shot only proceeds with explicit cost confirmation.
      const costConfirmed = ['1', 'true', 'yes', 'on'].includes(
        String(params.get('cost_confirmed') || params.get('quality_reroll_confirmed') || '').trim().toLowerCase());
      if (!reviewContextPath || !fs.existsSync(reviewContextPath)) {
        throw new Error('审核上下文不存在，无法重做单个镜头。');
      }
      if (!projectId || !shotId) {
        throw new Error('缺少项目或镜头编号，无法重做单个镜头。');
      }
      const progressPath = progressSidecarPath(projectId);
      if (!fs.existsSync(progressPath)) {
        throw new Error('当前项目还没有视频进度记录，无法重做单个镜头。');
      }
      const progress = readContextFile(progressPath);
      const previousProgressJson = JSON.stringify(progress, null, 2);
      const activeLock = readActiveRerunShotLock(projectId, shotId);
      if (activeLock) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(
          renderSubmitResultPage({
            ok: true,
            message: '该镜头刚刚已经提交过重做请求，系统已拦截重复提交，不会再次消耗 credits。请等待当前视频任务完成。',
            contextPath: reviewContextPath,
          }),
        );
      }
      let found = false;
      let blockedRunning = false;
      let blockedNonFailed = false;
      let needsCostConfirm = false;
      let isQualityReroll = false;
      const nowIso = new Date().toISOString();
      const pendingShots = Array.isArray(progress.shots) ? progress.shots.map((shot) => {
        const sameShot = String(shot.shot_id || '') === shotId ||
                         String(shot.shot_order || '') === shotId.replace(/^shot_/, '') ||
                         (shotOrderParam && String(shot.shot_order || '') === shotOrderParam);
        if (!sameShot) return shot;
        found = true;
        const shotStatus = String(shot.status || '').toLowerCase();
        // P12-H1d: a shot already in flight (running/submitted/waiting/processing) must
        // never be re-submitted — block here before any submission / Veo call.
        if (['running', 'submitted', 'waiting', 'processing'].includes(shotStatus)) {
          blockedRunning = true;
          return shot;
        }
        // P12-H1e: a successful shot (completed/done/success) may be quality-rerolled,
        // but ONLY with explicit cost confirmation. Without confirmation we do not mutate
        // or forward — the user is asked to confirm the credit cost first. The existing
        // canonical video is preserved in previous_video_path so a failed reroll can roll back.
        if (['completed', 'done', 'success'].includes(shotStatus)) {
          if (!costConfirmed) { needsCostConfirm = true; return shot; }
          isQualityReroll = true;
          // P12-H1e (Codex): the canonical video must NOT be overwritten before the reroll
          // succeeds. Keep status/video_path/operation_name intact; mark the reroll with
          // metadata only. The canonical is replaced ONLY after success, and kept on failure.
          return {
            ...shot,
            quality_reroll_pending: true,
            quality_reroll_active: true,
            quality_reroll_started_at: nowIso,
            pending_reroll_started_at: nowIso,
            reroll_reason: 'quality_reroll',
            previous_video_path: shot.video_path || shot.previous_video_path || '',
            previous_operation_name: shot.operation_name || shot.previous_operation_name || '',
            last_reroll_error: '',
          };
        }
        // P12-H1d (failed): a failed shot goes through the normal failure retry path
        // (no cost confirmation required).
        if (shotStatus === 'failed') {
          return {
            ...shot,
            status: 'submitted',
            quality_reroll: false,
            previous_video_path: shot.video_path || shot.previous_video_path || '',
            video_path: '',
            operation_name: '',
            // H1-fix-D: preserve failure history before clearing error field
            previous_error: shot.error || shot.previous_error || '',
            previous_failure_type: shot.failure_type || shot.previous_failure_type || '',
            error: '用户已提交重做，等待视频任务创建',
            last_started_at: nowIso,
          };
        }
        // pending / unknown: nothing generated yet — not rerollable here.
        blockedNonFailed = true;
        return shot;
      }) : [];
      if (!found) {
        throw new Error(`没有找到 ${shotId}，无法重做单个镜头。`);
      }
      if (blockedRunning) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(
          renderSubmitResultPage({
            ok: true,
            message: '该镜头正在生成中，请勿重复提交，请稍后刷新状态。',
            contextPath: reviewContextPath,
          }),
        );
      }
      if (needsCostConfirm) {
        // P12-H1e: success shot reroll requires explicit cost confirmation; do not submit yet.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(
          renderSubmitResultPage({
            ok: true,
            message: '该镜头已生成成功。重新生成会再次创建视频任务并消耗 credits；如失败将自动保留原视频。请确认成本后再提交（需勾选成本确认）。',
            contextPath: reviewContextPath,
          }),
        );
      }
      if (blockedNonFailed) {
        // Pending / unknown shot: nothing generated yet — no rerun, no forward, no Veo.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(
          renderSubmitResultPage({
            ok: true,
            message: '该镜头尚未生成完成，暂不可重做；仅失败镜头可重试、已成功镜头可在确认成本后质量重做。',
            contextPath: reviewContextPath,
          }),
        );
      }
      const activeProjectGeneration = isVideoGenerationActive(projectId);
      if (activeProjectGeneration.active) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(
          renderSubmitResultPage({
            ok: false,
            message: activeProjectGeneration.reason,
            contextPath: reviewContextPath,
          }),
        );
      }
      // P12-H1e: a quality reroll must NOT invalidate the existing canonical final/export —
      // it is preserved until the reroll SUCCEEDS (then Veo结果汇总 re-merges via signature change),
      // or restored on failure. Only the failure-retry path invalidates downstream final.
      if (!isQualityReroll) {
        markDownstreamStale(projectId, 'video_rerun_single_shot', 'final');
      }
      writeRerunShotLock(projectId, shotId, reviewContextPath);

      // Persist the submitted/quality_reroll state (incl. previous_video_path) BEFORE forwarding so
      // the workflow's 审核进度初始化 reads the quality_reroll flag + preserved canonical path.
      // The catch restores the previous progress snapshot if the forward fails.
      const rerolledProgress = {
        ...progress,
        shots: pendingShots,
        rerun_failed_only: true,
        rerun_pending_only: false,
        paused: false,
        status: 'running',
        quality_reroll_in_progress: isQualityReroll,
      };
      // P12-H1e: canonical completed_count is unchanged (a quality-reroll shot stays completed);
      // an active reroll is reflected only in running_count via quality_reroll_active.
      rerolledProgress.completed_count = pendingShots.filter((s) => ['completed', 'done', 'success'].includes(String(s.status || '').toLowerCase())).length;
      rerolledProgress.running_count = pendingShots.filter((s) => ['running', 'submitted', 'processing'].includes(String(s.status || '').toLowerCase()) || s.quality_reroll_active).length;
      rerolledProgress.failed_count = pendingShots.filter((s) => String(s.status || '').toLowerCase() === 'failed').length;
      rerolledProgress.failure_reasons_summary = pendingShots
        .filter((s) => s.status === 'failed')
        .map((s) => `${s.shot_id}: ${s.error || '需要重做'}`)
        .join(' | ');
      rerolledProgress.updated_at = new Date().toISOString();
      fs.writeFileSync(progressPath, JSON.stringify(rerolledProgress, null, 2));

      const formBody = {
        review_decision: '确认通过',
        bad_shot_ids: shotId,
        review_feedback: isQualityReroll ? '用户确认成本后质量重做单个镜头。' : '用户手动选择重做单个镜头。',
        review_context_path: reviewContextPath,
        review_round: Number(params.get('review_round') || 1),
        project_id: projectId,
        product_name: String(params.get('product_name') || '').trim(),
        rerun_failed_only: true,
        quality_reroll: isQualityReroll ? '1' : '',
      };
      try {
        await forwardReviewSubmission(formBody);
      } catch (error) {
        try { fs.writeFileSync(progressPath, previousProgressJson); } catch {}
        clearRerunShotLock(projectId, shotId);
        throw error;
      }
      const execution = findLatestExecutionForProject(projectId);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderSubmitResultPage({
          ok: true,
          message: '',
          contextPath: reviewContextPath,
          executionId: execution?.id || '',
        }),
      );
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderSubmitResultPage({
          ok: false,
          message: error.message || String(error),
        }),
      );
    }
  }

  if (req.method === 'POST' && req.url === '/review-rerun-pending') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const reviewContextPath = normalizeReviewContextPath(String(params.get('review_context_path') || '').trim());
      const projectId = String(params.get('project_id') || '').trim();
      const formBody = {
        review_decision: '确认通过',
        bad_shot_ids: '',
        review_feedback: '',
        review_context_path: reviewContextPath,
        review_round: Number(params.get('review_round') || 1),
        project_id: projectId,
        product_name: String(params.get('product_name') || '').trim(),
        rerun_pending_only: true,
      };
      if (!formBody.review_context_path || !fs.existsSync(formBody.review_context_path)) {
        throw new Error('审核上下文不存在，无法继续生成剩余镜头。');
      }
      // B-fix: verify real pending shots exist before forwarding
      const _progChk = readProgressFile(projectId);
      const _pendingShots = Array.isArray(_progChk.shots) ? _progChk.shots.filter(s => {
        const st = String(s.status || 'pending').toLowerCase();
        return st === 'pending' || st === '';
      }) : [];
      const _activeShots = Array.isArray(_progChk.shots) ? _progChk.shots.filter(s => {
        const st = String(s.status || '').toLowerCase();
        return st === 'running' || st === 'submitted' || st === 'processing';
      }) : [];
      // B-fix: block duplicate paid submissions, but allow a paused project to resume
      // pending shots after the old execution stopped submitting new work.
      const _activeCheck = isVideoGenerationActive(projectId);
      const _pausedResumeSafe = Boolean(_progChk.paused) && _pendingShots.length > 0 && _activeShots.length === 0;
      if (_activeCheck.active && !_pausedResumeSafe) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderSubmitResultPage({ ok: false, message: _activeCheck.reason }));
      }
      if (!Array.isArray(_progChk.shots) || _progChk.shots.length === 0 || _pendingShots.length === 0) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderSubmitResultPage({ ok: false, message: '所有镜头已完成，无需继续生成。如有问题请导出诊断包。' }));
      }
      markDownstreamStale(projectId, 'video_rerun_pending_shots', 'final');
      const progressPath = progressSidecarPath(projectId);
      if (fs.existsSync(progressPath)) {
        const progress = readContextFile(progressPath);
        progress.rerun_failed_only = false;
        progress.rerun_pending_only = true;
        progress.paused = false;
        progress.status = 'running';
        progress.updated_at = new Date().toISOString();
        fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
      }
      await forwardReviewSubmission(formBody);
      const execution = findLatestExecutionForProject(formBody.project_id);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderSubmitResultPage({
          ok: true,
          message: '',
          contextPath: formBody.review_context_path,
          executionId: execution?.id || '',
        }),
      );
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderSubmitResultPage({
          ok: false,
          message: error.message || String(error),
        }),
      );
    }
  }

  if (req.method === 'POST' && req.url === '/review-redo-panel') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const reviewContextPath = normalizeReviewContextPath(String(params.get('review_context_path') || '').trim());
      const projectId = String(params.get('project_id') || '').trim();
      const shotId = String(params.get('shot_id') || '').trim();
      const redoFeedback = String(params.get('redo_feedback') || '').trim();
      // MVP: 功能占位 — 单镜头分镜首帧重做需要独立生成管线，当前版本尚未实装
      // 设计说明：
      //   1. 调取 review_context 的 panel_review_pack[panel_index] 获取当前 shot 的 video_prompt / 产品图
      //   2. 携带 redo_feedback 对 storyboard prompt 做一次单镜头调整
      //   3. 调用 nano-banana-pro 生成单张 9:16 首帧替换 panel_image_path / panel_preview_path
      //   4. 更新 review_context 对应 panel 字段
      // 当前版本提示用户稍后再试
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>重做分镜首帧</title>${commonCSS()}</head><body><main>
        <div class="card">
          <h1>单镜头分镜首帧重做</h1>
          <p>项目：<code>${htmlEscape(projectId)}</code> · 镜头：<code>${htmlEscape(shotId)}</code></p>
          ${redoFeedback ? `<p>你的反馈：${htmlEscape(redoFeedback)}</p>` : ''}
          <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:16px;margin:16px 0;">
            <strong>⚠️ 功能准备中</strong>
            <p style="margin:8px 0 0;">单镜头分镜首帧重做（不重跑整张 6 宫格）正在开发中，当前版本尚未实装。</p>
            <p style="margin:8px 0 0;font-size:13px;color:var(--muted);">
              当前可用替代方案：<br>
              • <strong>首帧/分镜图不满意</strong> → 当前版本已隐藏分镜重做入口，建议重新开始一个项目<br>
              • <strong>视频穿模但首帧没问题</strong> → 返回视频状态页，使用"重做此镜头视频"（只重新生成该段视频，首帧不变）
            </p>
          </div>
          <div class="btn-row">
            <a class="btn btn-secondary" href="/review?context=${encodeURIComponent(path.basename(reviewContextPath))}">返回分镜审核</a>
            <a class="btn btn-secondary" href="/">工作台</a>
          </div>
        </div>
      </main></body></html>`);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderSubmitResultPage({ ok: false, message: error.message || String(error) }));
    }
  }

  if (req.method === 'POST' && req.url === '/review-pause-project') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const reviewContextPath = normalizeReviewContextPath(String(params.get('review_context_path') || '').trim());
      const projectId = String(params.get('project_id') || '').trim();
      if (!reviewContextPath || !fs.existsSync(reviewContextPath)) {
        throw new Error('审核上下文不存在，无法暂停项目。');
      }
      const progressPath = progressSidecarPath(projectId);
      if (fs.existsSync(progressPath)) {
        const progress = readContextFile(progressPath);
        progress.paused = true;
        progress.status = 'paused';
        progress.running_count = 0;
        progress.updated_at = new Date().toISOString();
        fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
      }
      res.writeHead(303, { Location: `/review-status?context=${encodeURIComponent(path.basename(reviewContextPath))}` });
      return res.end();
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(
        renderSubmitResultPage({
          ok: false,
          message: error.message || String(error),
        }),
      );
    }
  }

  // ── Config routes ─────────────────────────────────────────────────────────

  if (req.url === '/config' || req.url === '/config/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderConfigPage());
  }

  if (req.method === 'POST' && req.url === '/config-save') {
    try {
      const raw = await readRequestBody(req);
      const ct = req.headers['content-type'] || '';
      let updates = {};
      if (ct.includes('application/json')) {
        updates = JSON.parse(raw);
      } else {
        const params = new URLSearchParams(raw);
        for (const [k, v] of params.entries()) updates[k] = v;
      }
      // Validate output paths before saving — safety check, auto-create, verify writable
      if (updates.output && typeof updates.output === 'object') {
        for (const k of ['base_dir', 'storyboard_dir', 'video_dir', 'voiceover_dir', 'final_dir']) {
          const v = String(updates.output[k] || '').trim();
          if (!v) continue;
          const safe = isOutputPathSafe(v);
          if (!safe.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: `output.${k}：${safe.reason}` }));
          }
          const norm = safe.normalized;
          try { fs.mkdirSync(norm, { recursive: true }); } catch {}
          const csSt = (() => { try { return fs.statSync(norm); } catch { return null; } })();
          if (!csSt || !csSt.isDirectory()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: `output.${k}：目录不存在且无法创建，请选择其他位置。` }));
          }
          try { const csT = path.join(norm, '.write_test_' + Date.now()); fs.writeFileSync(csT, ''); fs.unlinkSync(csT); } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: `output.${k}：目录不可写，请检查权限。` }));
          }
        }
      }
      saveConfig(updates);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
    }
  }

  if (req.method === 'POST' && req.url === '/test-connection') {
    const t0 = Date.now();
    try {
      const cfg = normalizeAiConfig(loadConfig());
      const checks = [];
      const n8nHost = getConfiguredN8nHost();
      try {
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(`${n8nHost}/healthz`, { signal: controller.signal });
        clearTimeout(tid);
        checks.push({ label: 'n8n 服务', ok: resp.status < 500, message: `${n8nHost} HTTP ${resp.status}` });
      } catch (e) {
        checks.push({ label: 'n8n 服务', ok: false, message: String(e.message || e).slice(0, 120) });
      }

      try {
        const raw = runSqlite(['-json', DB_PATH,
          "SELECT count(*) AS c FROM workflow_entity WHERE id IN ('rKHHjD2QBlL6EhaM','scriptGenerateV1','storyboardGenerateV1','reviewSubmitVeoV2');",
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
        const count = JSON.parse(raw || '[]')?.[0]?.c || 0;
        checks.push({ label: '工作流 DB', ok: count >= 4, message: `已找到 ${count}/4 个关键工作流` });
      } catch (e) {
        checks.push({ label: '工作流 DB', ok: false, message: String(e.message || e).slice(0, 120) });
      }

      const kieKey = ((cfg.providers?.kie || {}).api_key || (cfg.kie || {}).api_key || '').trim();
      if (!kieKey) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: '缺少 Kie API Key。请在「系统配置」填写 Kie API Key 并保存。', checks }));
      }

      const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '';
      const baseUrl = String(cfg.providers?.kie?.base_url || cfg.kie?.base_url || KIE_CONSTANTS.base_url).replace(/\/+$/, '');
      const statusUrl = `${baseUrl}/v1/jobs/recordInfo?taskId=test-ping`;
      const rawOut = execFileSync('/usr/bin/curl', [
        '-sS', '--connect-timeout', '10', '-m', '15',
        ...(proxy ? ['-x', proxy] : []),
        '-H', `Authorization: Bearer ${kieKey}`,
        statusUrl,
      ], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 20000 });
      const parsed = JSON.parse(rawOut || '{}');
      if (parsed.code === 401 || parsed.code === 403) {
        checks.push({ label: 'Kie API Key', ok: false, message: `Kie code ${parsed.code} ${parsed.msg || ''}` });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, message: `API Key 无效（Kie code ${parsed.code}）：${parsed.msg || ''}`, checks }));
      }
      checks.push({ label: 'Kie API Key', ok: true, message: `接口已响应 code=${parsed.code ?? 'ok'}` });
      checks.push({ label: '模型配置', ok: true, message: `文本 ${cfg.tasks?.creative_direction?.model || ''} / 图片 ${cfg.tasks?.storyboard_image?.model || ''} / 视频 ${cfg.tasks?.image_to_video?.model || ''}` });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: checks.every(c => c.ok), latency_ms: Date.now() - t0, note: '运行环境检查完成（未调用生图/视频生成）', checks }));
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, message: err.message || String(err) }));
    }
  }

  if (req.method === 'POST' && req.url === '/choose-directory') {
    try {
      await readRequestBody(req);
      const selectedPath = chooseDirectoryWithSystemDialog();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, path: selectedPath }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
    }
  }

  if (req.method === 'POST' && req.url === '/api/output-folder-action') {
    const _hdr = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    try {
      const _rawBody = await readRequestBody(req);
      let _body; try { _body = JSON.parse(_rawBody); } catch { _body = {}; }
      const _action = String(_body.action || '').trim();

      if (_action === 'open') {
        const _cfg = loadConfig();
        const _base = String(_cfg?.output?.base_dir || '').trim() || DEFAULT_OUTPUT_BASE;
        const _target = String(_body.target || '').trim().toLowerCase();
        const _requested = _target === 'final'
          ? (String(_cfg?.output?.final_dir || '').trim() || path.join(_base, 'Final'))
          : _base;
        const _safeCheck = isOutputPathSafe(_requested);
        if (!_safeCheck.ok) {
          res.writeHead(400, _hdr);
          return res.end(JSON.stringify({ ok: false, error: `输出目录不安全，无法打开：${_safeCheck.reason}`, path: expandPath(_requested) }));
        }
        const _expanded = _safeCheck.normalized;
        try { fs.mkdirSync(_expanded, { recursive: true }); } catch {}
        const _openSt = (() => { try { return fs.statSync(_expanded); } catch { return null; } })();
        if (!_openSt || !_openSt.isDirectory()) {
          res.writeHead(500, _hdr);
          return res.end(JSON.stringify({ ok: false, error: `无法创建输出目录，请更改保存位置后重试。`, path: _expanded }));
        }
        try { const _wt = path.join(_expanded, '.write_test_' + Date.now()); fs.writeFileSync(_wt, ''); fs.unlinkSync(_wt); } catch {
          res.writeHead(500, _hdr);
          return res.end(JSON.stringify({ ok: false, error: `输出目录不可写，请检查权限或更改保存位置。`, path: _expanded }));
        }
        try {
          execFileSync('/usr/bin/open', [_expanded], { timeout: 5000 });
        } catch {
          res.writeHead(500, _hdr);
          return res.end(JSON.stringify({ ok: false, error: `打开输出文件夹失败。`, path: _expanded }));
        }
        res.writeHead(200, _hdr);
        return res.end(JSON.stringify({ ok: true, path: _expanded }));

      } else if (_action === 'choose') {
        // A manually pasted/typed base_dir (the browser Web UI flow, all platforms)
        // takes priority. The macOS native dialog is only a fallback when no
        // base_dir is supplied; on Windows/Linux there is no native picker, so we
        // return a Chinese hint to paste a path instead of throwing a blocker.
        const _manual = normalizeManualOutputBase(_body.base_dir);
        let _norm;
        if (_manual) {
          const _safe = isOutputPathSafe(_manual);
          if (!_safe.ok) {
            res.writeHead(400, _hdr);
            return res.end(JSON.stringify({ ok: false, error: _safe.reason }));
          }
          _norm = _safe.normalized;
        } else if (process.platform === 'darwin') {
          const _chosen = chooseDirectoryWithSystemDialog();
          const _safe = isOutputPathSafe(_chosen);
          if (!_safe.ok) {
            res.writeHead(400, _hdr);
            return res.end(JSON.stringify({ ok: false, error: _safe.reason }));
          }
          _norm = _safe.normalized;
        } else {
          res.writeHead(400, _hdr);
          return res.end(JSON.stringify({ ok: false, error: '请在输入框粘贴保存路径，或点击恢复默认位置。' }));
        }
        // Create the canonical Storyboards/Videos/Voiceovers/Final layout and
        // write-probe each dir (handles Windows backslashes/spaces/Chinese paths).
        const _ensured = ensureOutputDirsWritable(_norm);
        if (!_ensured.ok) {
          res.writeHead(500, _hdr);
          return res.end(JSON.stringify({ ok: false, error: _ensured.error }));
        }
        const _newDirs = _ensured.dirs;
        const _raw = loadConfig();
        const _merged = { ..._raw, output: { ...(_raw.output || {}), ..._newDirs },
          storyboard_output_dir: _newDirs.storyboard_dir, video_output_dir: _newDirs.video_dir };
        writeConfigAtomic(_merged);
        res.writeHead(200, _hdr);
        return res.end(JSON.stringify({ ok: true, base_dir: _norm }));

      } else if (_action === 'reset') {
        for (const [_rk, _rv] of Object.entries(DEFAULT_OUTPUT_DIRS)) {
          try { fs.mkdirSync(_rv, { recursive: true }); } catch {}
          const _rst = (() => { try { return fs.statSync(_rv); } catch { return null; } })();
          if (!_rst || !_rst.isDirectory()) {
            res.writeHead(500, _hdr);
            return res.end(JSON.stringify({ ok: false, error: `无法创建默认目录 ${_rk}，请检查磁盘权限。` }));
          }
          try { const _rt = path.join(_rv, '.write_test_' + Date.now()); fs.writeFileSync(_rt, ''); fs.unlinkSync(_rt); } catch {
            res.writeHead(500, _hdr);
            return res.end(JSON.stringify({ ok: false, error: `默认目录不可写 ${_rk}，请检查权限。` }));
          }
        }
        const _raw = loadConfig();
        const _merged = { ..._raw, output: { ...(_raw.output || {}), ...DEFAULT_OUTPUT_DIRS },
          storyboard_output_dir: DEFAULT_OUTPUT_DIRS.storyboard_dir, video_output_dir: DEFAULT_OUTPUT_DIRS.video_dir };
        writeConfigAtomic(_merged);
        res.writeHead(200, _hdr);
        return res.end(JSON.stringify({ ok: true, base_dir: DEFAULT_OUTPUT_BASE }));

      } else {
        res.writeHead(400, _hdr);
        return res.end(JSON.stringify({ ok: false, error: `未知操作：${_action}` }));
      }
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, _hdr);
      return res.end(JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300) }));
    }
  }

  // ── Export project artifacts to user output directories ───────────────────

  if (req.method === 'POST' && req.url === '/api/export-project') {
    const _epHdr = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    try {
      const _epRaw = await readRequestBody(req);
      let _epJson; try { _epJson = JSON.parse(_epRaw); } catch { _epJson = {}; }
      const _epProjId = String(_epJson.project_id || '').trim();
      // project_id must be non-empty, alphanumeric + _ - only, 4–80 chars
      if (!_epProjId || !/^[a-zA-Z0-9_\-]{4,80}$/.test(_epProjId)) {
        res.writeHead(400, _epHdr);
        return res.end(JSON.stringify({ ok: false, error: 'project_id 无效或缺失（4–80 位字母/数字/_/-）' }));
      }

      const _epResult = exportProjectArtifacts(_epProjId);

      // Config-level errors (unconfigured/unsafe dirs) reported as 400
      if (!_epResult.ok && _epResult.errors.length > 0 && _epResult.errors[0].file === '') {
        res.writeHead(400, _epHdr);
        return res.end(JSON.stringify({ ok: false, error: _epResult.errors.map(e => e.error).join('；'), project_id: _epProjId }));
      }

      // H1-fix-G/H: only mark 'exported' when canonical final video exists and all 6 shots completed.
      // If final is missing (e.g. shot failed), mark 'partial_export' and include warning in response.
      const _epProgress = readProgressFile(_epProjId);
      const _epFinalPath = String(_epProgress.final_merged_video_path || '').trim();
      const _epHasFinal = Boolean(_epFinalPath) && (() => { try { return fs.statSync(_epFinalPath).isFile(); } catch { return false; } })();
      const _epShots = Array.isArray(_epProgress.shots) ? _epProgress.shots : [];
      const _epAllComplete = _epShots.length === 6 &&
        _epShots.every(s => ['completed', 'done'].includes(String(s.status || '').toLowerCase()));
      const _epIsFullExport = _epHasFinal && _epAllComplete;
      const _epExportStatus = _epIsFullExport ? 'exported' : 'partial_export';
      const _epPartialWarning = !_epIsFullExport
        ? (!_epHasFinal
            ? `最终成片尚未生成（${_epShots.filter(s => s.status === 'failed').length > 0 ? '有镜头生成失败，请先修复失败镜头再导出完整成片' : '视频仍在生成中'}）。已导出已完成的分镜图和视频片段。`
            : '部分镜头尚未完成，导出的是当前已完成的产物，不含完整成片。')
        : '';

      // Advance project status — full export gets 'exported', partial gets 'partial_export'
      if (_epResult.errors.length === 0 && (_epResult.copied.length + _epResult.skipped.length) > 0) {
        updateProjectState(_epProjId, {
          status: _epExportStatus,
          export_summary: {
            exported_at: new Date().toISOString(),
            copied: _epResult.copied,
            skipped: _epResult.skipped,
            errors: _epResult.errors,
            copied_count: _epResult.copied.length,
            skipped_count: _epResult.skipped.length,
            error_count: _epResult.errors.length,
            output_dirs: _epResult.output_dirs,
            is_partial: !_epIsFullExport,
            partial_warning: _epPartialWarning,
          },
        });
      }

      res.writeHead(200, _epHdr);
      return res.end(JSON.stringify({
        ok: _epResult.errors.length === 0,
        project_id: _epProjId,
        copied: _epResult.copied,
        skipped: _epResult.skipped,
        errors: _epResult.errors,
        output_dirs: _epResult.output_dirs,
        is_partial: !_epIsFullExport,
        partial_warning: _epPartialWarning || undefined,
      }));
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, _epHdr);
      return res.end(JSON.stringify({ ok: false, error: '导出项目失败：' + String(err.message || err).slice(0, 300) }));
    }
  }

  // ── Prompt center routes ───────────────────────────────────────────────────
  // Only accessible when AI_VIDEO_INTERNAL=1 is set in the environment.

  const _isInternalMode = process.env.AI_VIDEO_INTERNAL === '1';

  if (req.url === '/prompt-center' || req.url === '/prompt-center/') {
    if (!_isInternalMode) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><title>内部功能</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5}.box{background:#fff;border-radius:12px;padding:40px 48px;text-align:center;box-shadow:0 2px 16px rgba(0,0,0,.08)}h2{margin:0 0 12px;color:#333}p{color:#666;margin:0}</style></head><body><div class="box"><h2>内部维护功能</h2><p>提示词中心为内部维护功能，正式版已隐藏。</p></div></body></html>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderPromptCenterPage());
  }

  if (req.method === 'POST' && req.url === '/prompt-center-save') {
    if (!_isInternalMode) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: '内部维护功能，正式版已禁用' }));
    }
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const moduleName = String(params.get('module') || '').trim();
      if (!moduleName) throw new Error('缺少 module 参数');
      const meta = PROMPT_MODULE_LABELS[moduleName];
      if (!meta) throw new Error(`未知模块: ${moduleName}`);
      for (const field of Object.keys(meta.fields)) {
        if (params.has(field)) {
          savePromptModule(moduleName, field, params.get(field));
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderPromptCenterPage(moduleName));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderPromptCenterPage('', err.message || String(err)));
    }
  }

  if (req.url.startsWith('/prompt-center-reset')) {
    if (!_isInternalMode) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: '内部维护功能，正式版已禁用' }));
    }
    try {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      const moduleName = String(url.searchParams.get('module') || '').trim();
      if (!moduleName) throw new Error('缺少 module 参数');
      resetPromptModule(moduleName);
      res.writeHead(302, { Location: `/prompt-center#mod-${encodeURIComponent(moduleName)}`, 'Cache-Control': 'no-store' });
      return res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderPromptCenterPage('', err.message || String(err)));
    }
  }

  // ── Final video route ──────────────────────────────────────────────────────

  if (req.url.startsWith('/final-video')) {
    const contextPath = getContextPathFromRequestUrl(req.url);
    if (!contextPath || !fs.existsSync(contextPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Review context not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderFinalVideoPage(contextPath));
  }

  // ── Environment status API ─────────────────────────────────────────────────

  if (req.method === 'GET' && req.url === '/api/env-status') {
    try {
      const status = await collectEnvStatus();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(status));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(err.message || err) }));
    }
  }

  // ── P17-REGRESSION-HARDENING: on-demand state reconciliation ──────────────
  if (req.method === 'POST' && req.url === '/api/reconcile-project') {
    try {
      const rawBody = await readRequestBody(req);
      let body;
      try { body = JSON.parse(rawBody); } catch { body = {}; }
      const _recPid = String(body.project_id || '').trim();
      const _recHdr = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      if (!_recPid || !/^[a-zA-Z0-9_-]{4,80}$/.test(_recPid)) {
        res.writeHead(400, _recHdr);
        return res.end(JSON.stringify({ ok: false, error: 'project_id 缺失或格式无效' }));
      }
      const _recBefore = readProjectState(_recPid);
      const _recOrigStatus = String(_recBefore.status || '');
      const _recOrigStage  = String(_recBefore.stage  || '');
      // Proactively write storyboard_failed when WF02B has errored (before artifact derive)
      const _recSbExec = findLatestExecutionForProject(_recPid, STORYBOARD_GENERATE_WORKFLOW_ID);
      if (_recSbExec && (_recSbExec.status === 'error' || _recSbExec.status === 'crashed')) {
        markStoryboardGenerationFailed(_recPid, _recSbExec);
      }
      // Re-read after proactive error write (state may have changed)
      const _recCurrent = readProjectState(_recPid);
      const _recCurrentStatus = String(_recCurrent.status || _recOrigStatus);
      const _recCurrentStage  = String(_recCurrent.stage  || _recOrigStage);
      // Single artifact-first call covers all levels (no separate deriveProjectStatusFromArtifacts needed)
      const _recDerived = deriveProjectStage(_recPid);
      // Don't downgrade explicit error stages (storyboard_failed etc.) via artifact derive
      const _EXPLICIT_ERROR_STAGES = ['storyboard_failed', 'script_failed', 'video_failed'];
      const _recNoDowngrade = _EXPLICIT_ERROR_STAGES.includes(_recCurrentStage);
      const _recPatch = {};
      if (!_recNoDowngrade) {
        if (_recDerived?.status && _recDerived.status !== _recCurrentStatus) _recPatch.status = _recDerived.status;
        if (_recDerived?.stage  && _recDerived.stage  !== _recCurrentStage)  _recPatch.stage  = _recDerived.stage;
      }
      const _recOrigUserMsg = String(_recCurrent.user_message || '');
      if (_recDerived?.user_message && !_recOrigUserMsg) _recPatch.user_message = _recDerived.user_message;
      if (Object.keys(_recPatch).length > 0) updateProjectState(_recPid, _recPatch);
      const _recAfter = readProjectState(_recPid);
      const _recRoute = getActiveRoute(_recPid);
      res.writeHead(200, _recHdr);
      return res.end(JSON.stringify({
        ok: true,
        project_id: _recPid,
        before:   { status: _recOrigStatus, stage: _recOrigStage },
        after:    { status: String(_recAfter.status || ''), stage: String(_recAfter.stage || ''), user_message: String(_recAfter.user_message || '') },
        derived_stage: String(_recDerived?.stage || ''),
        user_message: String(_recAfter.user_message || ''),
        patched:  Object.keys(_recPatch),
        activeRoute: _recRoute,
        next_url: _recRoute,
      }));
    } catch (_recErr) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: String(_recErr.message || _recErr).slice(0, 200) }));
    }
  }

  if (req.method === 'GET' && (req.url === '/system' || req.url === '/system/')) {
    try {
      const status = await collectEnvStatus();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderSystemPage(status));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><body><pre>${htmlEscape(String(err.message || err))}</pre></body></html>`);
    }
  }

  if (req.method === 'POST' && req.url === '/api/env-action') {
    try {
      const rawBody = await readRequestBody(req);
      let body;
      try { body = JSON.parse(rawBody); } catch { body = {}; }
      const action = String(body.action || '').trim();

      if (action === 'runtime-check') {
        const status = await collectEnvStatus();
        const cfg = normalizeAiConfig(loadConfig());
        const messages = [];
        messages.push(`工作台: ${status.ui.ok ? '正常' : '异常'}`);
        messages.push(`n8n: ${status.n8n.ok ? '正常' : '异常'}`);
        messages.push(`工作流: ${status.workflows.ok ? '正常' : '需同步'}`);
        messages.push(`API Key: ${status.apiKey.ok ? '已配置' : '未配置'}`);
        messages.push(`模型: 文本 ${cfg.tasks?.creative_direction?.model || '-'} / 图片 ${cfg.tasks?.storyboard_image?.model || '-'} / 视频 ${cfg.tasks?.image_to_video?.model || '-'}`);
        const ok = status.ui.ok && status.n8n.ok && status.workflows.ok && status.apiKey.ok && !status.configInfo?.keysDiffer;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok, message: messages.join('；') }));

      } else if (action === 'sync-workflows') {
        const syncScript = path.join(PROJECT_ROOT, 'sync_iteration_v1_workflows_to_db.mjs');
        if (!fs.existsSync(syncScript)) {
          throw new Error(`同步脚本不存在: ${syncScript}`);
        }
        const output = execFileSync(process.execPath, [syncScript], {
          cwd: PROJECT_ROOT,
          env: { ...process.env, PROJECT_ROOT, TIKTOK_WORKFLOW_ROOT: PROJECT_ROOT },
          encoding: 'utf8',
          timeout: 60000,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, message: '工作流已同步到 n8n DB', output: output.slice(0, 1000) }));

      } else if (action === 'kill-stale-n8n') {
        // Only kill PIDs explicitly recorded by launcher — no port scanning, no generic n8n matching
        const N8N_PID_FILE = path.join(RUNTIME_ROOT, '.n8n.pid');
        if (!fs.existsSync(N8N_PID_FILE)) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, message: '无法安全确认该进程属于 AI Video，本次未执行清理' }));
        }
        let pidFromFile = 0;
        try { pidFromFile = parseInt(fs.readFileSync(N8N_PID_FILE, 'utf8').trim(), 10); } catch {}
        if (!pidFromFile || isNaN(pidFromFile)) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, message: '无法安全确认该进程属于 AI Video，本次未执行清理' }));
        }
        // Verify PID still exists and command line references this app's directories
        let psCmd = '';
        let psFound = false;
        try {
          psCmd = execFileSync('/bin/ps', ['-p', String(pidFromFile), '-o', 'command='], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
          psFound = true;
        } catch {}
        if (!psFound) {
          // Process already gone — clean up stale pidfile
          try { fs.unlinkSync(N8N_PID_FILE); } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: true, message: '记录的 n8n 进程已不存在，已清理本地记录' }));
        }
        // Ownership check: command line must contain a path belonging to this app's install root.
        // n8nBin is resolved relative to PROJECT_ROOT (launcher line: n8nBin.startsWith(PROJECT_ROOT)),
        // so its absolute path always contains PROJECT_ROOT or RUNTIME_ROOT.
        const _appPaths = [PROJECT_ROOT, RUNTIME_ROOT].filter(Boolean);
        const _owned = _appPaths.some(p => psCmd.includes(p));
        if (!_owned) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: false, message: '无法安全确认该进程属于 AI Video，本次未执行清理' }));
        }
        try { process.kill(pidFromFile, 'SIGTERM'); } catch {}
        try { fs.unlinkSync(N8N_PID_FILE); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, message: `已终止 PID ${pidFromFile} 的 n8n 进程` }));

      } else if (action === 'clear-test-data') {
        const dirsToClean = [
          CONCEPT_CONTEXT_ROOT, PROJECT_STATE_ROOT, REVIEW_CONTEXT_ROOT,
          SCRIPT_CONTEXT_ROOT, SELECTED_CONCEPT_ROOT, REVIEW_PROGRESS_ROOT,
          CONCEPT_REVISION_ROOT, PROJECT_NOTES_ROOT, PROJECT_FEEDBACK_ROOT,
          path.join(CACHE_ROOT, 'text-model-requests'),
          path.join(CACHE_ROOT, 'text-model-responses'),
          path.join(CACHE_ROOT, 'stale'),
        ];
        let cleared = 0;
        for (const dir of dirsToClean) {
          if (!fs.existsSync(dir)) continue;
          for (const f of fs.readdirSync(dir)) {
            const fp = path.join(dir, f);
            try { if (fs.statSync(fp).isFile()) { fs.unlinkSync(fp); cleared++; } } catch {}
          }
        }
        if (fs.existsSync(PROJECT_HISTORY_PATH)) {
          try { fs.unlinkSync(PROJECT_HISTORY_PATH); cleared++; } catch {}
        }
        // Clear rerun locks
        if (fs.existsSync(REVIEW_RERUN_LOCK_ROOT)) {
          for (const f of fs.readdirSync(REVIEW_RERUN_LOCK_ROOT)) {
            try { fs.unlinkSync(path.join(REVIEW_RERUN_LOCK_ROOT, f)); cleared++; } catch {}
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, message: `已清空 ${cleared} 个缓存文件（API Key 保留不变）` }));

      } else if (action === 'factory-reset') {
        // 1. Redact API key in config file (this app's config only, not user's system files)
        let keyCleared = false;
        const clearApiKeysDeep = (value) => {
          if (!value || typeof value !== 'object') return value;
          if (Array.isArray(value)) return value.map(clearApiKeysDeep);
          for (const [k, v] of Object.entries(value)) {
            const normalized = String(k).toLowerCase();
            if ((normalized === 'api_key' || normalized.endsWith('_api_key')) && typeof v === 'string') {
              if (v.trim()) keyCleared = true;
              value[k] = '';
            } else {
              value[k] = clearApiKeysDeep(v);
            }
          }
          return value;
        };
        try {
          const rawCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(clearApiKeysDeep(rawCfg), null, 2) + '\n');
        } catch (_e) {}
        // 2. Clear all project caches
        const allDirs = [
          CONCEPT_CONTEXT_ROOT, PROJECT_STATE_ROOT, REVIEW_CONTEXT_ROOT,
          SCRIPT_CONTEXT_ROOT, SELECTED_CONCEPT_ROOT, REVIEW_PROGRESS_ROOT,
          CONCEPT_REVISION_ROOT, PROJECT_NOTES_ROOT, PROJECT_FEEDBACK_ROOT,
          path.join(CACHE_ROOT, 'text-model-requests'),
          path.join(CACHE_ROOT, 'text-model-responses'),
          path.join(CACHE_ROOT, 'stale'),
        ];
        let cleared = 0;
        for (const dir of allDirs) {
          if (!fs.existsSync(dir)) continue;
          try { fs.rmSync(dir, { recursive: true, force: true }); cleared++; } catch {}
        }
        if (fs.existsSync(PROJECT_HISTORY_PATH)) {
          try { fs.unlinkSync(PROJECT_HISTORY_PATH); cleared++; } catch {}
        }
        // 3. Clear launcher logs (only .log files, not the directory)
        const logLauncherDir = path.join(LOG_ROOT, 'launcher');
        if (fs.existsSync(logLauncherDir)) {
          for (const f of fs.readdirSync(logLauncherDir)) {
            if (f.endsWith('.log')) {
              try { fs.unlinkSync(path.join(logLauncherDir, f)); } catch {}
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          ok: true,
          message: `出厂重置完成。API Key 已清空：${keyCleared}；已清理 ${cleared} 个缓存目录。请重新进入系统配置填写 Kie API Key。`,
        }));

      } else {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: `未知操作: ${htmlEscape(action)}` }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
    }
  }

  // ── WF01 status polling endpoint ──────────────────────────────────────────

  if (req.method === 'GET' && req.url.startsWith('/api/wf01-status')) {
    const _wfUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    const _sinceMs = Number(_wfUrl.searchParams.get('since') || 0);
    try {
      const _elapsed = _sinceMs > 0 ? Date.now() - _sinceMs : 0;
      // Check for concept-context (success indicator)
      let _conceptContextReady = false;
      let _activeRoute = null;
      let _activeProjectId = null;
      try {
        const _latestState = getLatestProjectState(_sinceMs);
        _activeProjectId = String(_latestState.project_id || '').trim() || null;
        if (_activeProjectId) {
          const _cf = getLatestConceptContextFileForProject(_activeProjectId);
          _conceptContextReady = !!_cf;
          if (_conceptContextReady) _activeRoute = getActiveRoute(_activeProjectId, _sinceMs);
        }
        // Also scan concept-context dir directly for files newer than sinceMs
        if (!_conceptContextReady && _sinceMs > 0 && fs.existsSync(CONCEPT_CONTEXT_ROOT)) {
          const _recent = fs.readdirSync(CONCEPT_CONTEXT_ROOT)
            .filter((f) => f.endsWith('.json') && !f.includes('.stale'))
            .find((f) => { try { return fs.statSync(path.join(CONCEPT_CONTEXT_ROOT, f)).mtimeMs >= _sinceMs; } catch { return false; } });
          if (_recent) {
            _conceptContextReady = true;
            const _ctx = readContextFile(path.join(CONCEPT_CONTEXT_ROOT, _recent));
            _activeProjectId = _activeProjectId || String(_ctx.project_id || '').trim() || null;
            if (_activeProjectId) _activeRoute = getActiveRoute(_activeProjectId, _sinceMs);
          }
        }
      } catch {}
      // Check latest WF01 execution
      const _exec = findLatestWF01Execution(_sinceMs);
      let _status = 'waiting';
      let _execId = null;
      let _lastNode = null;
      let _errSummary = null;
      let _errType = null;
      let _execSummary = null;
      if (_exec) {
        _execId = _exec.id;
        _execSummary = readExecutionDataSummary(_exec.id);
        if (_exec.status === 'error' || _exec.status === 'crashed') {
          _status = 'failed';
          _errSummary = _execSummary.errorSummary;
          _errType = _execSummary.errorType;
        } else if (_exec.status === 'success') {
          _status = _conceptContextReady ? 'success' : 'waiting';
        } else {
          _status = 'running';
        }
        _lastNode = _execSummary.lastNodeExecuted || null;
        if (!_activeProjectId) _activeProjectId = _execSummary.projectId || null;
      }
      if (_conceptContextReady) _status = 'success';

      // App-layer fallback: write project-state failed for upstream failures
      // (HTTP Request disconnect, Kie 5xx, maintenance) that bypass the Code node catch.
      if (_status === 'failed' && !_conceptContextReady && _activeProjectId) {
        try {
          const _pid = String(_activeProjectId).replace(/[^a-zA-Z0-9_-]+/g, '_');
          const _statePath = path.join(PROJECT_STATE_ROOT, `project_${_pid}.json`);
          const _existing = (() => { try { return JSON.parse(fs.readFileSync(_statePath, 'utf8')); } catch { return {}; } })();
          const _successSet = new Set(['waiting_for_concept_selection', 'concept_selected', 'script_generated', 'storyboard_generated', 'video_generated']);
          if (!_successSet.has(String(_existing.status || '').trim())) {
            const _now = new Date().toISOString();
            const _errLabel = classifyWF01Error(_errSummary || '').label;
            fs.mkdirSync(PROJECT_STATE_ROOT, { recursive: true });
            fs.writeFileSync(_statePath, JSON.stringify({
              ..._existing,
              project_id: _activeProjectId,
              stage: 'creative_direction',
              status: 'failed',
              error_type: _errType || 'unknown',
              user_message: `创意方向生成失败：${_errLabel}。建议重新生成；连续失败请导出诊断包检查 API Key 和余额。`,
              technical_message: _errSummary || '',
              execution_id: String(_execId || ''),
              workflow_id: String(_exec?.workflowId || WF01_WORKFLOW_ID || ''),
              workflow_name: _exec?.workflowName || 'WF01 创意方向生成',
              last_node_executed: _lastNode || _execSummary?.lastNodeExecuted || '',
              raw_response_summary: _execSummary?.rawResponseSummary || _errSummary || '',
              can_retry: _execSummary ? _execSummary.canRetry : true,
              created_at: _existing.created_at || _now,
              updated_at: _now,
            }, null, 2));
          }
        } catch {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        ok: true,
        status: _status,
        executionId: _execId,
        execId: _execId,
        workflowId: _exec?.workflowId || WF01_WORKFLOW_ID,
        workflowName: _exec?.workflowName || 'WF01 创意方向生成',
        startedAt: _exec?.startedAt || null,
        stoppedAt: _exec?.stoppedAt || null,
        duration: (_exec?.startedAt && _exec?.stoppedAt)
          ? Math.round((parseN8nDateMs(_exec.stoppedAt) - parseN8nDateMs(_exec.startedAt)) / 1000) + 's'
          : null,
        lastNode: _lastNode,
        elapsedMs: _elapsed,
        errorSummary: _errSummary,
        errorType: _errType,
        userMessage: _errType ? classifyWF01Error(_errSummary || '').label : null,
        technicalMessage: _errSummary || null,
        rawResponseSummary: _execSummary?.rawResponseSummary || null,
        canRetry: _execSummary ? _execSummary.canRetry : true,
        projectId: _activeProjectId,
        conceptContextReady: _conceptContextReady,
        activeRoute: _conceptContextReady ? (_activeRoute || '/active') : null,
      }));
    } catch (_e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, status: 'waiting', elapsedMs: Date.now() - (_sinceMs || Date.now()), error: String(_e.message) }));
    }
  }

  // ── Storyboard generation poll endpoint ───────────────────────────────────

  if (req.method === 'GET' && req.url.startsWith('/api/storyboard-poll')) {
    const _spUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    const _spProjId = String(_spUrl.searchParams.get('project_id') || '').trim();
    const _spHdr = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    try {
      if (!_spProjId) {
        res.writeHead(400, _spHdr);
        return res.end(JSON.stringify({ ready: false, status: 'waiting', error: 'project_id 缺失' }));
      }
      const _spPid = _spProjId.replace(/[^a-zA-Z0-9_-]+/g, '_');
      // Check if review_context file exists (storyboard ready)
      const _spReviewItems = fs.existsSync(REVIEW_CONTEXT_ROOT)
        ? fs.readdirSync(REVIEW_CONTEXT_ROOT).filter(
            n => n.startsWith(`review_context_${_spPid}`) && n.endsWith('.json')
              && !n.includes('.stale') && !n.endsWith('.submitted.json'))
        : [];
      if (_spReviewItems.length > 0) {
        const _spLatest = _spReviewItems.sort().at(-1);
        reconcileStoryboardContextStateForUi(_spProjId, readProjectState(_spProjId), true);
        const _spReviewUrl = `/reviews/item?context=${encodeURIComponent(_spLatest)}`;
        res.writeHead(200, _spHdr);
        return res.end(JSON.stringify({ ready: true, status: 'success', reviewUrl: _spReviewUrl }));
      }
      // Check execution state
      const _spExec = findLatestExecutionForProject(_spProjId, STORYBOARD_GENERATE_WORKFLOW_ID);
      // If WF02B is not actively running, check whether panel images exist — if so, the review
      // context was lost/stale rather than still being generated, and we must surface a recovery UI.
      if (_spExec?.status !== 'running') {
        const _spChk = (dir, pfx, ext) => {
          try { return fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.startsWith(pfx) && f.endsWith(ext)); }
          catch { return false; }
        };
        const _spHasPanel =
          _spChk(path.join(CACHE_ROOT, 'nanobanana'), `storyboard_${_spPid}_`, '.png') ||
          _spChk(path.join(CACHE_ROOT, '分镜图裁剪', 'full'), `panel_full_${_spPid}_`, '.jpg') ||
          _spChk(path.join(CACHE_ROOT, '分镜图裁剪', 'previews'), `panel_preview_${_spPid}_`, '.jpg');
        if (_spHasPanel) {
          res.writeHead(200, _spHdr);
          return res.end(JSON.stringify({
            ready: false, status: 'review_context_missing',
            userMessage: '分镜已生成但审核数据丢失，请在项目页点击「重新生成分镜图」重新触发分镜生成。',
          }));
        }
      }
      const _spFailure = (_spExec?.status === 'error' || _spExec?.status === 'crashed') ? markStoryboardGenerationFailed(_spProjId, _spExec) : null;
      const _spStatus = _spFailure ? 'error' : 'running';
      res.writeHead(200, _spHdr);
      return res.end(JSON.stringify({
        ready: false,
        status: _spStatus,
        userMessage: _spFailure?.user_message || null,
        errorType: _spFailure?.error_type || null,
        executionId: _spFailure?.execution_id || null,
        workflowId: _spFailure?.workflow_id || null,
        lastNodeExecuted: _spFailure?.last_node_executed || null,
      }));
    } catch (_spErr) {
      res.writeHead(200, _spHdr);
      return res.end(JSON.stringify({ ready: false, status: 'waiting', error: String(_spErr.message || _spErr).slice(0, 200) }));
    }
  }

  // ── P17-REGRESSION-HARDENING: concept stage poll endpoint ─────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/concept-poll')) {
    const _cpUrl = new URL(req.url, `http://${HOST}:${PORT}`);
    const _cpProjId = String(_cpUrl.searchParams.get('project_id') || '').trim();
    const _cpHdr = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    try {
      if (!_cpProjId) {
        res.writeHead(400, _cpHdr);
        return res.end(JSON.stringify({ ready: false, error: 'project_id 缺失' }));
      }
      const _cpPid = _cpProjId.replace(/[^a-zA-Z0-9_-]+/g, '_');
      const _cpScriptFile = scriptContextPath(_cpPid);
      if (fs.existsSync(_cpScriptFile)) {
        clearScriptRetryState(_cpProjId); // P12-H1b-A: success → drop retry budget
        res.writeHead(200, _cpHdr);
        return res.end(JSON.stringify({
          ready: true, status: 'success',
          scriptUrl: `/script-review?project_id=${encodeURIComponent(_cpProjId)}`,
        }));
      }
      const _cpExec = findLatestExecutionForProject(_cpProjId, CONCEPT_SELECT_WORKFLOW_ID);
      if (_cpExec?.status === 'error' || _cpExec?.status === 'crashed') {
        // P12-H1b-A: safe automatic second submission (max 1) for policy/JSON failures.
        let _cpAuto = { retried: false };
        try { _cpAuto = await maybeAutoRetryScriptGeneration(_cpProjId, { execution: _cpExec }); }
        catch (_e) { _cpAuto = { retried: false, action: 'error', user_message: '脚本框架自动重试失败：' + String(_e.message || _e).slice(0, 200) }; }
        res.writeHead(200, _cpHdr);
        if (_cpAuto.retried) {
          return res.end(JSON.stringify({
            ready: false,
            status: 'retrying',
            attempt: _cpAuto.attempt,
            message: '脚本框架生成失败，系统已自动使用更安全的提示词重新生成（自动重试 1 次），请稍候…',
          }));
        }
        return res.end(JSON.stringify({
          ready: false,
          status: 'error',
          script_failure_type: _cpAuto.script_failure_type || null,
          is_safe_retryable: Boolean(_cpAuto.is_safe_retryable),
          exhausted: Boolean(_cpAuto.exhausted),
          message: _cpAuto.user_message || '脚本框架生成失败，请稍后重试。如连续失败，请导出诊断包。',
        }));
      }
      res.writeHead(200, _cpHdr);
      return res.end(JSON.stringify({ ready: false, status: 'running' }));
    } catch (_cpErr) {
      res.writeHead(200, _cpHdr);
      return res.end(JSON.stringify({ ready: false, status: 'waiting', error: String(_cpErr.message || _cpErr).slice(0, 200) }));
    }
  }

  // ── Export diagnostics route ───────────────────────────────────────────────

  if (req.method === 'GET' && req.url === '/api/export-diagnostics') {
    try {
      const secretValues = new Set();
      const collectSecretValues = (value, parentKey = '') => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          value.forEach((item) => collectSecretValues(item, parentKey));
          return;
        }
        for (const [k, v] of Object.entries(value)) {
          const normalized = String(k).toLowerCase();
          if ((normalized === 'api_key' || normalized.endsWith('_api_key')) && typeof v === 'string' && v.trim()) {
            secretValues.add(v.trim());
          } else {
            collectSecretValues(v, normalized);
          }
        }
      };
      const escapeRegExp = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        collectSecretValues(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
      } catch {}

      const redact = (str) => {
        if (typeof str !== 'string') return str;
        let out = str;
        for (const secret of secretValues) {
          out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED-KEY]');
        }
        return out
          .replace(/("api_key"\s*:\s*")[^"]+"/gi, '$1[REDACTED]"')
          .replace(/Authorization:[^\n\r]+/gi, 'Authorization: [REDACTED]')
          .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
          .replace(/AIzaSy[A-Za-z0-9_-]{30,}/g, '[REDACTED-AIZA]')
          .replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED-SK]')
          .replace(/Kie[A-Za-z0-9_-]{10,}/g, '[REDACTED-KIE]')
          .replace(/\b[a-f0-9]{32}\b/gi, '[REDACTED-HEX32]');
      };

      const diag = {};

      // 1. Version & app info
      try {
        const pkgPath = path.join(PROJECT_ROOT, 'package.json');
        const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {};
        diag.version = { app: pkg.version || 'unknown', name: pkg.name || 'unknown' };
      } catch { diag.version = { error: 'unreadable' }; }

      // 2. System info
      const { execSync: _es } = await import('child_process');
      diag.system = {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        uptime: Math.round(process.uptime()),
        hostname: (() => { try { return _es('hostname', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
        macos: (() => { try { return _es('sw_vers -productVersion', { encoding: 'utf8' }).trim(); } catch { return null; } })(),
      };

      // 3. Port status
      const netMod = await import('net');
      const portCheck = async (port) => new Promise((resolve) => {
        const sock = new netMod.default.Socket();
        sock.setTimeout(1000);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => resolve(false));
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.connect(port, '127.0.0.1');
      });
      diag.ports = {
        ui: { port: PORT, open: await portCheck(Number(PORT)) },
        n8n: { port: 5678, open: await portCheck(5678) },
      };

      // 4. n8n status (healthcheck)
      try {
        const n8nHealth = await fetch('http://127.0.0.1:5678/healthz').then(r => r.text()).catch(() => null);
        diag.n8n = { healthz: n8nHealth ? n8nHealth.trim() : 'unreachable' };
      } catch { diag.n8n = { healthz: 'unreachable' }; }

      // 5. Workflow versions (from .n8n-local-cache workflow JSONs if any)
      try {
        const wfDir = path.join(CACHE_ROOT, 'workflows');
        diag.workflows = fs.existsSync(wfDir)
          ? fs.readdirSync(wfDir).filter(f => f.endsWith('.json')).map(f => {
              try {
                const wf = JSON.parse(fs.readFileSync(path.join(wfDir, f), 'utf8'));
                return { file: f, name: wf.name || '?', id: wf.id || '?', updatedAt: wf.updatedAt || '?' };
              } catch { return { file: f, error: 'parse error' }; }
            })
          : 'no workflow cache dir';
      } catch (e) { diag.workflows = { error: String(e.message) }; }

      // 6. Redacted config summary
      try {
        const rawCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const safeCfg = JSON.parse(redact(JSON.stringify(rawCfg)));
        diag.config = safeCfg;
      } catch { diag.config = { error: 'unreadable' }; }

      // 7. Recent log excerpts (last 50 lines, redacted, no binary/video)
      diag.logs = {};
      const logDirs = [
        { key: 'launcher', dir: path.join(LOG_ROOT, 'launcher') },
        { key: 'diagnostics', dir: path.join(LOG_ROOT, 'diagnostics') },
      ];
      for (const { key, dir } of logDirs) {
        if (!fs.existsSync(dir)) { diag.logs[key] = 'no log dir'; continue; }
        const logFiles = fs.readdirSync(dir)
          .filter(f => f.endsWith('.log') || f.endsWith('.txt'))
          .sort().slice(-3); // most recent 3 files
        diag.logs[key] = {};
        for (const f of logFiles) {
          try {
            const fullPath = path.join(dir, f);
            const stat = fs.statSync(fullPath);
            if (stat.size > 2 * 1024 * 1024) { diag.logs[key][f] = '[file too large, skipped]'; continue; }
            const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
            const excerpt = lines.slice(-50).join('\n');
            diag.logs[key][f] = redact(excerpt);
          } catch { diag.logs[key][f] = '[read error]'; }
        }
      }

      // 8. Cache dir summary with latest file info
      diag.cacheStats = {};
      const cacheDirs = [
        ['conceptContext', CONCEPT_CONTEXT_ROOT],
        ['reviewContext', REVIEW_CONTEXT_ROOT],
        ['projectState', PROJECT_STATE_ROOT],
        ['scriptContext', SCRIPT_CONTEXT_ROOT],
        ['selectedConcepts', SELECTED_CONCEPT_ROOT],
        ['reviewProgress', REVIEW_PROGRESS_ROOT],
        ['projectHistory', PROJECT_HISTORY_PATH],
        ['uploadedProductImages', path.join(CACHE_ROOT, 'uploaded-product-images')],
      ];
      for (const [label, p] of cacheDirs) {
        try {
          if (!fs.existsSync(p)) { diag.cacheStats[label] = 'absent'; continue; }
          const stat = fs.statSync(p);
          if (stat.isDirectory()) {
            const allFiles = fs.readdirSync(p).filter((f) => !f.startsWith('.'));
            const sorted = allFiles
              .map((f) => { try { return { name: f, mtime: fs.statSync(path.join(p, f)).mtimeMs }; } catch { return { name: f, mtime: 0 }; } })
              .sort((a, b) => b.mtime - a.mtime);
            diag.cacheStats[label] = {
              files: allFiles.length,
              latestFile: sorted[0]?.name || null,
              latestMtime: sorted[0]?.mtime ? new Date(sorted[0].mtime).toISOString() : null,
            };
          } else {
            diag.cacheStats[label] = { exists: true, bytes: stat.size, mtime: stat.mtime.toISOString() };
          }
        } catch { diag.cacheStats[label] = 'error'; }
      }

      // 9. Recent n8n executions (last 30 list + top-10 detail summaries)
      diag.executions = {};
      try {
        const recent = queryRecentExecutions(30);
        diag.executions.recent30 = recent.map((e) => ({
          id: e.id,
          workflowId: e.workflowId,
          workflowName: e.workflowName || '?',
          status: e.status,
          finished: e.finished,
          startedAt: e.startedAt,
          stoppedAt: e.stoppedAt,
        }));
        diag.executions.summaries10 = recent.slice(0, 10).map((e) => buildExecutionDetailSummary(e, redact));
      } catch (e) { diag.executions = { error: String(e.message) }; }

      // 10. UI API status snapshot (env-status + reviews.json)
      try {
        const envStatus = await collectEnvStatus();
        const pendingReviews = (() => { try { return readPendingReviews(); } catch { return { ok: false, error: 'error', items: [] }; } })();
        diag.uiApiStatus = {
          envStatusOk: !!(envStatus.ui?.ok && envStatus.n8n?.ok),
          n8nOk: !!envStatus.n8n?.ok,
          n8nError: envStatus.n8n?.error || null,
          workflowsOk: !!envStatus.workflows?.ok,
          apiKeyOk: !!envStatus.apiKey?.ok,
          activeProject: envStatus.activeProject || null,
          reviewsJsonOk: !!pendingReviews.ok,
          reviewsJsonError: pendingReviews.error || null,
          pendingReviewCount: (pendingReviews.items || []).length,
        };
      } catch (e) { diag.uiApiStatus = { error: String(e.message) }; }

      // 11. WF01 latest execution content analysis
      try {
        const _wf01Exec = findLatestWF01Execution(0);
        if (_wf01Exec) {
          const _s11 = readExecutionDataSummary(_wf01Exec.id);
          diag.wf01ContentAnalysis = {
            executionId: _wf01Exec.id,
            workflowName: _wf01Exec.workflowName || 'WF01 创意方向生成',
            status: _wf01Exec.status,
            lastNodeExecuted: _s11.lastNodeExecuted,
            errorType: _s11.errorType,
            errorSummary: _s11.errorSummary,
            rawContentLength: _s11.rawContentLength,
            rawContentLooksJson: _s11.rawContentLooksJson,
            rawContentStartsWithICannot: _s11.rawContentStartsWithICannot,
            rawContentHasCodeFence: _s11.rawContentHasCodeFence,
            jsonRepairAttempted: _s11.jsonRepairAttempted,
            jsonRepairSucceeded: _s11.jsonRepairSucceeded,
            rawContentSummary: redact(String(_s11.rawResponseSummary || '').slice(0, 300)),
            dataTooLarge: _s11.dataTooLarge,
            dataSize: _s11.dataSize,
            extractionError: _s11.extractionError,
          };
        } else {
          diag.wf01ContentAnalysis = { executionId: null, note: 'no recent WF01 execution' };
        }
      } catch (e) { diag.wf01ContentAnalysis = { error: String(e.message) }; }

      // 12. Local output path writability
      try {
        const _cfgPaths = loadConfig();
        const _sbPath = String(_cfgPaths?.output?.storyboard_dir || _cfgPaths?.storyboard_output_dir || '').trim();
        const _vPath = String(_cfgPaths?.output?.video_dir || _cfgPaths?.video_output_dir || '').trim();
        const _chk = (p) => {
          if (!p) return { configured: false };
          const exp = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
          if (!fs.existsSync(exp)) return { configured: true, exists: false, path: exp };
          try { const t = path.join(exp, '.diag_' + Date.now()); fs.writeFileSync(t, ''); fs.unlinkSync(t); return { configured: true, exists: true, writable: true, path: exp }; }
          catch { return { configured: true, exists: true, writable: false, path: exp }; }
        };
        diag.outputPaths = { storyboardDir: _chk(_sbPath), videoDir: _chk(_vPath) };
      } catch (e) { diag.outputPaths = { error: String(e.message) }; }

      // 13. Failed project-state entries (last 5)
      try {
        const _failedStates = [];
        if (fs.existsSync(PROJECT_STATE_ROOT)) {
          const _stateFiles = fs.readdirSync(PROJECT_STATE_ROOT)
            .filter((f) => f.endsWith('.json'))
            .map((f) => ({ f, mtime: (() => { try { return fs.statSync(path.join(PROJECT_STATE_ROOT, f)).mtimeMs; } catch { return 0; } })() }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 10)
            .map((x) => x.f);
          for (const _f of _stateFiles) {
            const _s = readContextFile(path.join(PROJECT_STATE_ROOT, _f));
            if (_s.status === 'failed') {
              _failedStates.push({
                project_id: _s.project_id || null,
                error_type: _s.error_type || null,
                user_message: _s.user_message || null,
                raw_response_summary: _s.raw_response_summary ? redact(String(_s.raw_response_summary).slice(0, 200)) : null,
                updated_at: _s.updated_at || null,
              });
              if (_failedStates.length >= 5) break;
            }
          }
        }
        diag.failedProjectStates = _failedStates;
      } catch (e) { diag.failedProjectStates = { error: String(e.message) }; }

      // 14. Final merge / ffmpeg diagnostics (P13-B1)
      try {
        const _ffPath = String(process.env.AI_VIDEO_FFMPEG_PATH || path.join(PROJECT_ROOT, 'runtime', 'bin', 'ffmpeg'));
        let _ffExists = _ffPath.includes('/') ? fs.existsSync(_ffPath) : false;
        let _ffExec = false, _ffVer = '';
        try {
          const _v = execFileSync(_ffPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).toString('utf8');
          _ffVer = (_v.split('\n')[0] || '').trim();
          _ffExec = true;
          if (!_ffPath.includes('/')) _ffExists = true;
        } catch { _ffExec = false; }

        let _prog = {};
        try {
          if (fs.existsSync(REVIEW_PROGRESS_ROOT)) {
            const _latest = fs.readdirSync(REVIEW_PROGRESS_ROOT).filter((x) => x.endsWith('.json'))
              .map((x) => ({ x, m: (() => { try { return fs.statSync(path.join(REVIEW_PROGRESS_ROOT, x)).mtimeMs; } catch { return 0; } })() }))
              .sort((a, b) => b.m - a.m)[0];
            if (_latest) _prog = JSON.parse(fs.readFileSync(path.join(REVIEW_PROGRESS_ROOT, _latest.x), 'utf8'));
          }
        } catch {}
        const _shots = Array.isArray(_prog.shots) ? _prog.shots : [];
        const _clips = _shots.filter((s) => String(s.status || '') === 'completed' || String(s.video_path || '').trim()).map((s) => {
          const _vp = String(s.video_path || '');
          let _ex = false, _sz = 0;
          try { if (_vp) { const _st = fs.statSync(_vp); _ex = _st.isFile(); _sz = _st.size; } } catch {}
          return { shot_order: s.shot_order ?? s.shot_id ?? null, path: _vp, exists: _ex, size: _sz };
        });
        const _finalPath = String(_prog.final_merged_video_path || '').trim();
        let _finalExists = false, _finalSize = 0;
        try { if (_finalPath) { const _st = fs.statSync(_finalPath); _finalExists = _st.isFile(); _finalSize = _st.size; } } catch {}
        diag.finalMerge = {
          final_output_dir: _finalPath ? path.dirname(_finalPath) : null,
          final_merged_video_path: _finalPath || null,
          final_file_exists: _finalExists,
          final_file_size: _finalSize,
          final_merge_failed: _prog.final_merge_failed === true,
          final_merge_error: redact(String(_prog.final_merge_error || '')) || null,
          final_merge_command_summary: redact(String(_prog.final_merge_command_summary || '')) || null,
          ffmpeg_path: _ffPath,
          ffmpeg_exists: _ffExists,
          ffmpeg_executable: _ffExec,
          ffmpeg_version: _ffVer || null,
          clips_expected_count: Number(_prog.clips_expected_count ?? _prog.total_panels ?? _shots.length ?? 0),
          clips_found_count: Number(_prog.clips_found_count ?? _clips.filter((c) => c.exists).length),
          clips: _clips,
        };
      } catch (e) { diag.finalMerge = { error: String(e.message) }; }

      diag.generatedAt = new Date().toISOString();

      // Write to runtime logs/diagnostics/
      const diagDir = path.join(LOG_ROOT, 'diagnostics');
      if (!fs.existsSync(diagDir)) fs.mkdirSync(diagDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const diagFile = path.join(diagDir, `diag-${ts}.json`);
      const diagJson = redact(JSON.stringify(diag, null, 2));
      fs.writeFileSync(diagFile, diagJson, 'utf8');

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, path: diagFile, content: JSON.parse(diagJson) }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
    }
  }

  // ── Docs route ─────────────────────────────────────────────────────────────

  if (req.url === '/docs' || req.url === '/docs/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderDocsPage());
  }

  // ── Reset test data route ──────────────────────────────────────────────────

  if (req.method === 'POST' && req.url === '/reset-test-data') {
    try {
      const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'reset-local-test-state.sh');
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`重置脚本不存在: ${scriptPath}`);
      }
      const output = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, RESET_CACHE_ROOT: CACHE_ROOT },
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta http-equiv="refresh" content="3; url=/" /><title>已清空项目缓存</title>${commonCSS()}</head><body>${renderStageNav('')}<main style="max-width:680px;"><div class="card" style="margin-top:40px;"><div class="alert-ok">项目缓存已清空，备份已创建。3 秒后返回工作台…</div><pre style="margin-top:10px;font-size:11px;">${htmlEscape(output.slice(0, 2000))}</pre><div class="btn-row"><a class="btn btn-primary" href="/">返回工作台</a></div></div></main></body></html>`);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><title>清空失败</title>${commonCSS()}</head><body>${renderStageNav('')}<main style="max-width:680px;"><div class="card" style="margin-top:40px;"><div class="alert-err">清空失败：${htmlEscape(err.message || String(err))}</div><div class="btn-row"><a class="btn btn-secondary" href="/">返回工作台</a></div></div></main></body></html>`);
    }
  }

  // ── Script review routes ───────────────────────────────────────────────────

  if (req.method === 'POST' && req.url === '/script-shot-save') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const projectId = String(params.get('project_id') || '').trim();
      if (!projectId) throw new Error('缺少 project_id');
      // Collect shot overrides from flattened form fields: shots[0][scene_setting] etc.
      const shotMap = {};
      for (const [key, val] of params.entries()) {
        const m = key.match(/^shots\[(\d+)\]\[([^\]]+)\]$/);
        if (!m) continue;
        const idx = m[1];
        const field = m[2];
        if (!shotMap[idx]) shotMap[idx] = {};
        shotMap[idx][field] = val;
      }
      const shots = Object.values(shotMap).filter(s => s.shot_id);
      fs.mkdirSync(SCRIPT_CONTEXT_ROOT, { recursive: true });
      const overridesFile = path.join(SCRIPT_CONTEXT_ROOT, `script_user_overrides_${String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`);
      fs.writeFileSync(overridesFile, JSON.stringify({ project_id: projectId, shots, saved_at: new Date().toISOString() }, null, 2));
      res.writeHead(302, { Location: `/script-review?project_id=${encodeURIComponent(projectId)}` });
      return res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>保存失败</title>${commonCSS()}</head><body>${renderStageNav('')}<main style="max-width:680px;"><div class="card" style="margin-top:40px;"><div class="alert-err">保存脚本草稿失败：${htmlEscape(err.message || String(err))}</div><div class="btn-row"><a class="btn btn-secondary" href="javascript:history.back()">返回</a></div></div></main></body></html>`);
    }
  }

  if (req.method === 'POST' && req.url === '/script-confirm') {
    try {
      const raw = await readRequestBody(req);
      const params = new URLSearchParams(raw);
      const projectId = String(params.get('project_id') || '').trim();
      if (!projectId) throw new Error('缺少 project_id');
      const pid = String(projectId).replace(/[^a-zA-Z0-9_-]+/g, '_');

      // B3: Collect current form shots (same parsing as /script-shot-save)
      const shotMap = {};
      for (const [key, val] of params.entries()) {
        const m = key.match(/^shots\[(\d+)\]\[([^\]]+)\]$/);
        if (!m) continue;
        if (!shotMap[m[1]]) shotMap[m[1]] = {};
        shotMap[m[1]][m[2]] = val;
      }
      const formShots = Object.values(shotMap).filter(s => s.shot_id);

      // B3: Persist current form state as overrides before building confirmed snapshot
      fs.mkdirSync(SCRIPT_CONTEXT_ROOT, { recursive: true });
      if (formShots.length > 0) {
        const overridesFile = path.join(SCRIPT_CONTEXT_ROOT, `script_user_overrides_${pid}.json`);
        fs.writeFileSync(overridesFile, JSON.stringify({ project_id: projectId, shots: formShots, saved_at: new Date().toISOString() }, null, 2));
      }

      // B3: Build confirmed snapshot (base + overrides + form, form wins)
      const confirmed = buildConfirmedScriptContext(projectId, formShots);
      fs.writeFileSync(confirmedScriptContextPath(projectId), JSON.stringify(confirmed, null, 2));
      // Sync confirmed back to script_context so WF02b reads the authoritative version
      const scriptContextFile = path.join(SCRIPT_CONTEXT_ROOT, `script_context_${pid}.json`);
      fs.writeFileSync(scriptContextFile, JSON.stringify(confirmed, null, 2));

      // P17-C1: Mark downstream storyboard/video stale (scope='storyboard' preserves the new script we just wrote)
      markDownstreamStale(projectId, 'script_confirmed', 'storyboard');

      // P17-C2: Clear export state since project is being regenerated
      updateProjectState(projectId, {
        stage: 'storyboard_generating',
        status: 'storyboard_generating',
        auto_exported_at: null,
        auto_export_copied: null,
        auto_export_skipped: null,
        auto_export_errors: null,
        auto_export_summary: null,
        export_summary: null,
      });

      if (noPaidSmokeEnabled()) {
        writeNoPaidSmokeStoryboardArtifacts(projectId);
        res.writeHead(302, { Location: `/storyboard-status?project_id=${encodeURIComponent(projectId)}` });
        return res.end();
      }

      // Trigger WF02B
      const webhookUrl = resolveStoryboardGenerateWebhookUrl();
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`WF02B webhook 返回 ${response.status}: ${text.slice(0, 300)}`);
      }
      res.writeHead(302, { Location: `/storyboard-status?project_id=${encodeURIComponent(projectId)}` });
      return res.end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>确认失败</title>${commonCSS()}</head><body>${renderStageNav('')}<main style="max-width:680px;"><div class="card" style="margin-top:40px;"><div class="alert-err">脚本确认失败：${htmlEscape(err.message || String(err))}</div><div class="btn-row"><a class="btn btn-secondary" href="javascript:history.back()">返回</a></div></div></main></body></html>`);
    }
  }

  if (req.url.startsWith('/storyboard-status')) {
    const urlObj = new URL(req.url, `http://${HOST}:${PORT}`);
    const projectId = String(urlObj.searchParams.get('project_id') || '').trim();
    if (!projectId) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>缺少参数</title>${commonCSS()}</head><body>${renderStageNav('')}<main style="max-width:680px;"><div class="card" style="margin-top:40px;"><div class="alert-err">缺少 project_id 参数</div><div class="btn-row"><a class="btn btn-secondary" href="/">工作台</a></div></div></main></body></html>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderStoryboardStatusPage(projectId));
  }

  if (req.url.startsWith('/script-review')) {
    const urlObj = new URL(req.url, `http://${HOST}:${PORT}`);
    const projectId = String(urlObj.searchParams.get('project_id') || '').trim();
    if (projectId) {
      // New mode: read from script_context.json (editable)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderScriptReviewPage(projectId));
    }
    // Legacy mode: read from review_context.json (read-only)
    const contextPath = getContextPathFromRequestUrl(req.url);
    if (!contextPath || !fs.existsSync(contextPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Review context not found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(renderScriptReviewLegacyPage(contextPath));
  }

  if (req.url.startsWith('/local-file')) {
    const urlObj = new URL(req.url, `http://${HOST}:${PORT}`);
    const filePath = String(urlObj.searchParams.get('path') || '');
    const ext = path.extname(filePath).toLowerCase();
    const allowed = new Set(['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg']);
    if (!filePath || !allowed.has(ext) || !isAllowedLocalAssetPath(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  const filePath = safeJoin(ROOT, req.url);
  if (!filePath) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    return res.end('Not Found');
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
});

// Eager prompt migration at startup: ensures App Support prompt is up-to-date before first request.
if (APP_MODE === 'dist') loadPromptCenter();

// Auto-create default output directories on startup (no-op if already configured).
ensureDefaultOutputDirs();

server.listen(PORT, HOST, () => {
  console.log(`review assets server ready on http://${HOST}:${PORT}`);
});
