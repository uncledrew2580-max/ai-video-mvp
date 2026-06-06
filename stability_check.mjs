import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB = path.join(os.homedir(), '.n8n/database.sqlite');
const REQUIRED_WORKFLOWS = [
  'rKHHjD2QBlL6EhaM',
  'conceptSelectStoryboardV1',
  'reviewSubmitVeoV2',
];
const REQUIRED_WEBHOOKS = [
  'e469ccc2-943b-46f6-bc77-7ecf23e6a8ab',
  'conceptSelectStoryboardV1/concept_select_resume/storyboard-concept-select-v1',
  'reviewSubmitVeoV2/review_submit_resume/storyboard-review-submit-v2',
];
const REVIEW_WORKFLOW_FILES = [
  'review-submit-workflow.json',
  '正式导入文件/03-续跑-分镜审核到视频.json',
  '正式导入文件/03-续跑-分镜审核到视频.fixed-basectx.json',
  '正式导入文件/03-续跑-分镜审核到视频.simplified-v1.json',
];
const FORBIDDEN_REVIEW_KEYWORDS = [
  'synthesizeVoiceover',
  'tts_edge_generate',
  'scene-audio',
  'mergeWithAudio',
];
const REQUIRED_REVIEW_KEYWORDS = [
  'modelhub',
  'https://api.modelhub.me/v1/videos',
  'veo3.1-fast',
];
const FORBIDDEN_PROVIDER_KEYWORDS = [
  'https://api.wavespeed.ai/api/v3/vidu/q2-pro/image-to-video-fast',
  'wavespeed-media-upload',
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

function curlOk(url) {
  try {
    run('curl', ['-fsS', '--max-time', '5', url]);
    return true;
  } catch {
    return false;
  }
}

function sqliteJson(query) {
  return JSON.parse(run('sqlite3', [DB, '-json', query]) || '[]');
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertNoForbiddenReviewCode(label, workflowLike) {
  const text = JSON.stringify(workflowLike || {});
  for (const keyword of FORBIDDEN_REVIEW_KEYWORDS) {
    allOk = line(!text.includes(keyword), `${label} 不含旧音频逻辑：${keyword}`) && allOk;
  }
  for (const keyword of REQUIRED_REVIEW_KEYWORDS) {
    allOk = line(text.includes(keyword), `${label} 已切换到 ModelHub：${keyword}`) && allOk;
  }
  for (const keyword of FORBIDDEN_PROVIDER_KEYWORDS) {
    allOk = line(!text.includes(keyword), `${label} 不含旧 WaveSpeed 提交逻辑：${keyword}`) && allOk;
  }
  allOk = line(text.includes('progress.shots.find'), `${label} 使用 progress.shots.find 定位当前 shot`) && allOk;
  allOk = line(text.includes('panel_image_path'), `${label} 使用 panel_image_path 作为图生视频首帧`) && allOk;
}

function line(ok, label, detail = '') {
  const mark = ok ? 'OK' : 'FAIL';
  console.log(`${mark}  ${label}${detail ? ` - ${detail}` : ''}`);
  return ok;
}

let allOk = true;

allOk = line(curlOk('http://127.0.0.1:5678/healthz'), 'n8n 服务') && allOk;
allOk = line(curlOk('http://127.0.0.1:8787/healthz'), '8787 工作台') && allOk;

const workflows = sqliteJson(
  `select id,name,active,activeVersionId,versionId from workflow_entity where id in (${REQUIRED_WORKFLOWS.map((x) => `'${x}'`).join(',')})`,
);
const byId = Object.fromEntries(workflows.map((workflow) => [workflow.id, workflow]));
for (const id of REQUIRED_WORKFLOWS) {
  const workflow = byId[id];
  allOk = line(Boolean(workflow), `workflow 存在：${id}`, workflow?.name || '') && allOk;
  if (workflow) {
    allOk = line(Boolean(workflow.active), `workflow 已激活：${id}`) && allOk;
    allOk =
      line(Boolean(workflow.activeVersionId), `workflow activeVersionId 正常：${id}`, workflow.activeVersionId || '') &&
      allOk;
  }
}

const webhooks = sqliteJson(
  `select workflowId,webhookPath,method,node from webhook_entity where webhookPath in (${REQUIRED_WEBHOOKS.map((x) => `'${x}'`).join(',')})`,
);
const hookSet = new Set(webhooks.map((hook) => hook.webhookPath));
for (const hookPath of REQUIRED_WEBHOOKS) {
  allOk = line(hookSet.has(hookPath), `webhook 已注册：${hookPath}`) && allOk;
}

for (const filePath of REVIEW_WORKFLOW_FILES) {
  try {
    assertNoForbiddenReviewCode(`03 文件 ${filePath}`, readJsonFile(filePath));
  } catch (error) {
    allOk = line(false, `03 文件无法读取：${filePath}`, error.message) && allOk;
  }
}

try {
  const activeRows = sqliteJson(
    `select nodes from workflow_history where versionId=(select activeVersionId from workflow_entity where id='reviewSubmitVeoV2') limit 1`,
  );
  assertNoForbiddenReviewCode('n8n active 03 history', {
    nodes: JSON.parse(activeRows[0]?.nodes || '[]'),
  });
} catch (error) {
  allOk = line(false, 'n8n active 03 history 无法读取', error.message) && allOk;
}

const dirs = [
  process.env.PANEL_OUTPUT_DIR || path.join(os.homedir(), 'Downloads', 'n8n分镜图裁剪'),
  process.env.VIDEO_OUTPUT_DIR || path.join(os.homedir(), 'Downloads', 'n8n视频'),
  path.join(__dirname, '.n8n-local-cache'),
];
for (const dir of dirs) {
  try {
    run('mkdir', ['-p', dir]);
    run('test', ['-w', dir]);
    allOk = line(true, `目录可写：${dir}`) && allOk;
  } catch {
    allOk = line(false, `目录不可写：${dir}`) && allOk;
  }
}

console.log('');
if (!allOk) {
  console.log('稳定性检查未通过。建议先运行：node repair_active_workflow_versions.mjs，然后重启 n8n。');
  process.exit(1);
}

console.log('稳定性检查通过。可以从 n8n 表单或 8787 工作台继续操作。');
