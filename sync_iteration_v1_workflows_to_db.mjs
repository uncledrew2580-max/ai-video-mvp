/**
 * sync_iteration_v1_workflows_to_db.mjs
 *
 * Syncs the four iteration-v1 canonical workflows to the n8n SQLite DB.
 * Source: 正式导入文件/iteration-v1/
 * Target IDs: rKHHjD2QBlL6EhaM, conceptSelectStoryboardV1, storyboardGenerateV1, reviewSubmitVeoV2
 *
 * Pre-write validation (throws on failure — no partial writes):
 *   - JSON parseable
 *   - No AIzaSy API keys
 *   - No /Users/drew hardcoded paths
 *   - WF03: no scene-audio, tts_edge_generate, synthesizeVoiceover, mergeWithAudio, raw-scene-videos
 *   - WF01/WF02: Prompt Library reads prompts/prompt_center.json at runtime
 *   - WF03: has modelhub, modelhub_video_model fallback, progress.shots.find
 *   - WF02b: has kie_market_image, readImageConfig, kieBase
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.TIKTOK_WORKFLOW_ROOT || process.env.PROJECT_ROOT || path.dirname(fileURLToPath(import.meta.url));
const ITER_DIR = path.join(ROOT, '正式导入文件', 'iteration-v1');

// DB resolution priority:
// 1. N8N_DB_PATH env var (set by launcher when running as child process)
// 2. N8N_USER_FOLDER env var + '.n8n/database.sqlite'
// 3. Project-local cache: <ROOT>/.n8n-local-cache/.n8n/database.sqlite (if it exists)
// 4. Global fallback: ~/.n8n/database.sqlite
const _localCacheDb = path.join(ROOT, '.n8n-local-cache', '.n8n', 'database.sqlite');
const DB = process.env.N8N_DB_PATH
  || (process.env.N8N_USER_FOLDER ? path.join(process.env.N8N_USER_FOLDER, '.n8n', 'database.sqlite') : null)
  || (fs.existsSync(_localCacheDb) ? _localCacheDb : null)
  || path.join(os.homedir(), '.n8n', 'database.sqlite');

const WORKFLOW_FILES = [
  {
    file: 'n8n01.json',
    expectedId: 'rKHHjD2QBlL6EhaM',
    label: 'WF01',
    isWF03: false,
    isWF02b: false,
  },
  {
    file: 'n8n02.json',
    expectedId: 'conceptSelectStoryboardV1',
    label: 'WF02',
    isWF03: false,
    isWF02b: false,
  },
  {
    file: 'n8n02a.json',
    expectedId: 'scriptGenerateV1',
    label: 'WF02a',
    isWF03: false,
    isWF02b: false,
  },
  {
    file: 'n8n02b.json',
    expectedId: 'storyboardGenerateV1',
    label: 'WF02b',
    isWF03: false,
    isWF02b: true,
  },
  {
    file: 'n8n03.json',
    expectedId: 'reviewSubmitVeoV2',
    label: 'WF03',
    isWF03: true,
    isWF02b: false,
  },
];

function sqlString(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  return `'${text.replace(/'/g, "''")}'`;
}

function sqlite(query) {
  return execFileSync('sqlite3', ['-cmd', '.timeout 8000', DB, query], { encoding: 'utf8' });
}

// ── Validation ────────────────────────────────────────────────────────────────

function validate(label, filePath, workflow, isWF03, isWF02b) {
  const raw = JSON.stringify(workflow);

  // Use full key pattern (30+ chars) to avoid false-positives from redaction regex literals
  if (/AIzaSy[A-Za-z0-9_-]{30,}/.test(raw)) {
    throw new Error(`[${label}] 拒绝同步：检测到 Gemini API Key (AIzaSy)`);
  }
  if (raw.includes('/Users/drew')) {
    throw new Error(`[${label}] 拒绝同步：检测到硬编码路径 /Users/drew`);
  }

  // WF01/WF02x must not contain ModelHub (video routing logic that belongs only in WF03)
  if (!isWF03) {
    if (raw.includes('modelhub') || raw.includes('ModelHub')) {
      throw new Error(`[${label}] 拒绝同步：非 WF03 文件包含 modelhub — 可能是错误的文件`);
    }
  }

  if (isWF02b) {
    // WF02b must have the adapter chain and nano-banana image model
    const required = ['分镜提示请求体适配', '分镜提示响应适配', 'nano-banana', 'storyboard_prompt', 'kie_openai_chat', 'gemini-3.1-pro'];
    for (const token of required) {
      if (!raw.includes(token)) {
        throw new Error(`[${label}] 拒绝同步：缺少分镜适配逻辑 "${token}"`);
      }
    }
    const configNode = (workflow.nodes || []).find((node) => node.name === '读取分镜API配置');
    const configCode = String(configNode?.parameters?.jsCode || '');
    if (!configNode || !configCode) {
      throw new Error(`[${label}] 拒绝同步：缺少 "读取分镜API配置" 节点`);
    }
    if (/Primary:\s*Google Gemini native/.test(configCode) || /readGeminiKey\s*\(\)/.test(configCode) || /_adapter:\s*'gemini_native'/.test(configCode)) {
      throw new Error(`[${label}] 拒绝同步：WF02B 分镜文本路由不得使用 Google native primary`);
    }
    if (/gemini-3-flash-preview/.test(configCode)) {
      throw new Error(`[${label}] 拒绝同步：WF02B 分镜文本路由不得使用 gemini-3-flash-preview`);
    }
    if (!/adapter:\s*'kie_openai_chat'/.test(configCode) || !/readKieTaskModel\('storyboard_prompt'\)/.test(configCode)) {
      throw new Error(`[${label}] 拒绝同步：WF02B 分镜文本必须以 Kie storyboard_prompt 为主路由`);
    }
    return;
  }

  if (isWF03) {
    const forbidden = [
      'scene-audio',
      'tts_edge_generate',
      'synthesizeVoiceover',
      'mergeWithAudio',
      'raw-scene-videos',
    ];
    for (const token of forbidden) {
      if (raw.includes(token)) {
        throw new Error(`[${label}] 拒绝同步：检测到旧音频逻辑 "${token}" — 请确认文件是 modelhub 去音频版`);
      }
    }

    const required = ['modelhub', 'modelhub_video_model', 'progress.shots.find'];
    for (const token of required) {
      if (!raw.includes(token)) {
        throw new Error(`[${label}] 拒绝同步：缺少必要逻辑 "${token}"`);
      }
    }
  } else {
    const required = ['prompts/prompt_center.json', 'storyboard_grid', 'creative_task_type_mapping'];
    for (const token of required) {
      if (!raw.includes(token)) {
        throw new Error(`[${label}] 拒绝同步：Prompt Library 缺少运行时提示词逻辑 "${token}"`);
      }
    }
  }
}

// ── Workspace host resolution ─────────────────────────────────────────────────
// Primary source: services.workspace_host from local-config.json
// Override: WORKSPACE_HOST env var, then REVIEW_ASSET_PORT env var
let _workspaceHost = '';
try {
  const _cfgPath = path.join(ROOT, '版本测试', 'config', 'local-config.json');
  const _cfg = JSON.parse(fs.readFileSync(_cfgPath, 'utf8'));
  _workspaceHost = (_cfg.services && _cfg.services.workspace_host) || '';
} catch (_e) {}
if (process.env.WORKSPACE_HOST) {
  _workspaceHost = process.env.WORKSPACE_HOST;
} else if (process.env.REVIEW_ASSET_PORT) {
  _workspaceHost = `http://127.0.0.1:${process.env.REVIEW_ASSET_PORT}`;
}
_workspaceHost = _workspaceHost.replace(/\/+$/, '');
if (!_workspaceHost) {
  throw new Error('workspace_host not configured. Set services.workspace_host in 版本测试/config/local-config.json or REVIEW_ASSET_PORT env var.');
}
// Guard: workspace_host must use port 18788 (client dist), not 8788 (dev-only)
if (/:(8788)\b/.test(_workspaceHost)) {
  throw new Error(`workspace_host 使用了开发端口 8788 (${_workspaceHost})。客户端同步必须使用 18788。请修正 services.workspace_host 后重试。`);
}

// Patch Form Trigger redirectUrl node
function patchFormTriggerUrl(workflow) {
  for (const node of (workflow.nodes || [])) {
    if (node.type === 'n8n-nodes-base.formTrigger') {
      const vals = node.parameters?.options?.respondWithOptions?.values;
      if (vals?.respondWith === 'redirect') {
        vals.redirectUrl = `${_workspaceHost}/submitted`;
      }
    }
  }
}

// Belt-and-suspenders: replace any remaining dev-port URLs throughout the workflow JSON
function patchAllWorkspaceUrls(workflow) {
  let str = JSON.stringify(workflow);
  // Single combined pattern: http://(127.0.0.1|localhost):8788 → configured workspace_host
  str = str.replace(/http:\/\/(127\.0\.0\.1|localhost):8788/g, _workspaceHost);
  return JSON.parse(str);
}

// ── Load & validate all files first (fail fast before any DB write) ───────────

console.log('正在加载并校验 iteration-v1 三件套...\n');
console.log(`  workspace_host → ${_workspaceHost}\n`);

const workflows = [];
for (const spec of WORKFLOW_FILES) {
  const filePath = path.join(ITER_DIR, spec.file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`[${spec.label}] 文件不存在: ${filePath}`);
  }

  let workflow;
  try {
    workflow = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`[${spec.label}] JSON 解析失败: ${e.message}`);
  }

  // Patch all workspace URLs (Form Trigger + Code node fallbacks + any other URLs)
  patchFormTriggerUrl(workflow);
  workflow = patchAllWorkspaceUrls(workflow);

  // Force the canonical ID (after patching to preserve id through JSON round-trip)
  workflow.id = spec.expectedId;

  validate(spec.label, filePath, workflow, spec.isWF03, spec.isWF02b);
  console.log(`  ✅ ${spec.label} (${spec.expectedId}) — 校验通过`);

  workflows.push({ ...spec, workflow });
}

console.log('\n所有文件校验通过，开始同步到 DB...\n');

// ── Build SQL ─────────────────────────────────────────────────────────────────

let sql = 'BEGIN TRANSACTION;\n';
const results = [];

for (const { label, workflow, expectedId } of workflows) {
  const id = expectedId;
  const versionId = crypto.randomUUID();

  const currentActive = sqlite(
    `SELECT active FROM workflow_entity WHERE id=${sqlString(id)} LIMIT 1;`,
  ).trim() || '0';
  const shouldKeepActive = Number(currentActive) ? 1 : 0;

  const authors = sqlite(
    `SELECT authors FROM workflow_history WHERE workflowId=${sqlString(id)} ORDER BY createdAt DESC LIMIT 1;`,
  ).trim() || 'codex';

  const workflowExists =
    sqlite(`SELECT COUNT(*) FROM workflow_entity WHERE id=${sqlString(id)};`).trim() !== '0';

  if (!workflowExists) {
    // INSERT path — should be rare for this project
    const projectId = sqlite(
      `SELECT id FROM project WHERE type='personal' LIMIT 1;`,
    ).trim();

    sql += `
INSERT INTO workflow_entity (
  "id", "name", "active", "nodes", "connections", "settings",
  "staticData", "pinData", "versionId", "triggerCount", "meta",
  "parentFolderId", "createdAt", "updatedAt", "isArchived",
  "versionCounter", "description", "activeVersionId"
) VALUES (
  ${sqlString(id)},
  ${sqlString(workflow.name)},
  0,
  ${sqlString(workflow.nodes || [])},
  ${sqlString(workflow.connections || {})},
  ${sqlString(workflow.settings || {})},
  NULL,
  ${sqlString(workflow.pinData || {})},
  ${sqlString(versionId)},
  0,
  ${sqlString(workflow.meta || {})},
  NULL,
  STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'),
  STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'),
  0, 1, NULL, NULL
);

INSERT INTO shared_workflow ("workflowId","projectId","role","createdAt","updatedAt")
VALUES (${sqlString(id)}, ${sqlString(projectId)}, 'workflow:owner',
  STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'), STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'));
`;
  } else {
    // UPDATE path
    sql += `
UPDATE workflow_entity SET
  name = ${sqlString(workflow.name)},
  nodes = ${sqlString(workflow.nodes || [])},
  connections = ${sqlString(workflow.connections || {})},
  settings = ${sqlString(workflow.settings || {})},
  "pinData" = ${sqlString(workflow.pinData || {})},
  meta = ${sqlString(workflow.meta || {})},
  "versionId" = ${sqlString(versionId)},
  active = ${shouldKeepActive},
  "activeVersionId" = ${shouldKeepActive ? sqlString(versionId) : 'NULL'},
  "updatedAt" = STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')
WHERE id = ${sqlString(id)};
`;

    if (shouldKeepActive) {
      sql += `
INSERT INTO workflow_published_version ("workflowId","publishedVersionId","createdAt","updatedAt")
VALUES (${sqlString(id)}, ${sqlString(versionId)},
  STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'), STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
ON CONFLICT("workflowId") DO UPDATE SET
  "publishedVersionId" = excluded."publishedVersionId",
  "updatedAt" = STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW');
`;
    }
  }

  sql += `
INSERT INTO workflow_history (
  "versionId","workflowId","authors","nodes","connections",
  "name","description","autosaved","createdAt","updatedAt"
) VALUES (
  ${sqlString(versionId)}, ${sqlString(id)}, ${sqlString(authors)},
  ${sqlString(workflow.nodes || [])}, ${sqlString(workflow.connections || {})},
  ${sqlString(workflow.name)}, NULL, 0,
  STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'), STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')
);
`;

  results.push({ label, id, name: workflow.name, versionId, wasActive: shouldKeepActive });
}

sql += 'COMMIT;\n';

// ── Execute ───────────────────────────────────────────────────────────────────

const sqlPath = `/tmp/sync-iteration-v1-${Date.now()}.sql`;
fs.writeFileSync(sqlPath, sql);

try {
  execFileSync('sqlite3', [DB], { input: fs.readFileSync(sqlPath, 'utf8'), stdio: ['pipe', 'inherit', 'inherit'] });
} finally {
  fs.unlinkSync(sqlPath);
}

console.log('\n同步完成:\n');
for (const r of results) {
  console.log(`  ✅ ${r.label} | ${r.id} | active=${r.wasActive} | versionId=${r.versionId}`);
}
console.log();
console.log(JSON.stringify(results, null, 2));
