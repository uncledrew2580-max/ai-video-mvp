#!/usr/bin/env node
/**
 * Build a local macOS MVP package for manual testing.
 *
 * This is not a signed .app. It creates a clean folder with the project files,
 * double-click launch scripts, and install instructions.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distRoot = join(root, 'dist');
const out = join(distRoot, 'TikTok-AI-Video-Workbench-mac-mvp');

const include = [
  'client',
  'config',
  'prompts',
  '版本测试',
  '正式导入文件',
  'scripts',
  'docs/CLIENT_PACKAGING_PLAN.md',
  'docs/tiktok_ai_video_workflow_usage.md',
  'gemini-generate.mjs',
  'veo-download.mjs',
  'veo-sdk-submit.mjs',
  'veo-status.mjs',
  'voiceover_localize.mjs',
  'package.json',
  'package-lock.json',
  'sync_iteration_v1_workflows_to_db.mjs',
  'sync_wf02ab_to_db.mjs',
];

const excludeNames = new Set([
  '.DS_Store',
  'node_modules',
  '.n8n-local-cache',
  '.n8n-local-cache-backups',
  'logs',
  'dist',
]);

function filter(src) {
  const rel = relative(root, src);
  const parts = rel.split('/');
  const base = parts.at(-1);
  if (parts.includes('.n8n-local-cache') || parts.includes('.n8n-local-cache-backups')) return false;
  if (parts[0] === 'logs' || (parts[0] === '版本测试' && parts[1] === 'logs')) return false;
  if (/^node_modules\.broken-/.test(base) && parts.length === 1) return false;
  if (parts[0] === '版本测试' && parts[1] === 'backups') return false;
  if (parts[0] === '版本测试' && parts[1] === '正式导入文件') return false;
  if (parts[0] === '版本测试' && base === 'concept-select-workflow.json') return false;
  if (parts[0] === '版本测试' && base === 'reset-test-state.mjs') return false;
  return !excludeNames.has(base);
}

function scrubApiKeys(value) {
  if (Array.isArray(value)) return value.map(scrubApiKeys);
  if (!value || typeof value !== 'object') return value;

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (normalized === 'api_key' || normalized.endsWith('_api_key')) {
      value[key] = '';
    } else {
      value[key] = scrubApiKeys(child);
    }
  }
  return value;
}

function lockMvpDefaults(config) {
  config.providers ??= {};
  config.providers.kie ??= {};
  config.providers.kie.base_url = 'https://api.kie.ai/api';
  config.providers.kie.text_model = 'gemini-3.1-pro';
  config.providers.kie.image_model = 'nano-banana-pro';
  config.providers.kie.video_model = 'veo3_lite';

  config.kie ??= {};
  config.kie.base_url = 'https://api.kie.ai/api';
  config.kie.text_model = 'gemini-3.1-pro';
  config.kie.image_model = 'nano-banana-pro';
  config.kie.video_model = 'veo3_lite';

  config.tasks ??= {};
  config.tasks.creative_direction = { provider: 'kie', route: 'openai_chat', model: 'gemini-3.1-pro' };
  config.tasks.script_framework = { provider: 'kie', route: 'openai_chat', model: 'gemini-3.1-pro' };
  config.tasks.storyboard_prompt = { provider: 'kie', route: 'openai_chat', model: 'gemini-3.1-pro' };
  config.tasks.storyboard_image = { provider: 'kie', route: 'kie_market_image', model: 'nano-banana-pro' };
  config.tasks.image_to_video = { provider: 'kie', route: 'kie_veo31', model: 'veo3_lite' };

  config.apis ??= {};
  for (const task of ['creative_direction', 'script_framework']) {
    config.apis[task] ??= {};
    config.apis[task].base_url = 'https://api.kie.ai/api';
    config.apis[task].model = 'gemini-3.1-pro';
  }
  config.apis.storyboard_image ??= {};
  config.apis.storyboard_image.base_url = 'https://api.kie.ai/api';
  config.apis.storyboard_image.model = 'nano-banana-pro';
  config.apis.image_to_video ??= {};
  config.apis.image_to_video.base_url = 'https://api.kie.ai/api';
  config.apis.image_to_video.model = 'veo3_lite';
  config.apis.image_to_video.provider = 'kie_veo31';

  config.services ??= {};
  config.services.workspace_host = 'http://127.0.0.1:18788';
  config.services.n8n_host ??= 'http://127.0.0.1:5678';

  return config;
}

function sanitizeConfig(relPath) {
  const file = join(out, relPath);
  if (!existsSync(file)) return;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify(scrubApiKeys(lockMvpDefaults(config)), null, 2) + '\n');
  console.log(`sanitized ${relPath}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const item of include) {
  const src = join(root, item);
  if (!existsSync(src)) continue;
  const dest = join(out, item);
  cpSync(src, dest, { recursive: true, filter });
  console.log('copied', relative(root, src));
}

sanitizeConfig('config/local-config.json');
sanitizeConfig('版本测试/config/local-config.json');

writeFileSync(
  join(out, '请先看我-Mac测试版.txt'),
  [
    'TikTok AI 视频工作台 — Mac MVP 测试包',
    '',
    '使用顺序：',
    '1. 第一次使用：双击 client/mac/安装运行依赖.command',
    '2. 启动工作台：双击 client/mac/TikTok AI 视频工作台.command',
    '3. 浏览器会自动打开 http://127.0.0.1:18788/',
    '',
    '说明：',
    '- 这是 Mac 本地测试封装包，不是最终签名 .app。',
    '- 视频 API 可以稍后在系统配置页填写，不影响前半段测试。',
    '- 输出文件、配置和缓存都保存在本包目录或用户选择的本地目录。',
    '',
    '如果 macOS 阻止打开，请右键 command 文件，选择「打开」。',
    '',
  ].join('\n'),
);

console.log('');
console.log('Mac MVP package ready:');
console.log(out);
