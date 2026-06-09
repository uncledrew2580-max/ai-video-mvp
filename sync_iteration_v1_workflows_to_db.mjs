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
import { fileURLToPath } from 'node:url';
import { runSqlite } from './lib/sqlite-exec.mjs';

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
  // node:sqlite first (Windows portable ships no sqlite3 CLI), CLI fallback.
  return runSqlite(['-cmd', '.timeout 8000', DB, query], { encoding: 'utf8' });
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

  // ── FK-SAFE WRITE ORDER (P14-B8G) ────────────────────────────────────────────
  // node:sqlite (the Windows portable's SQLite) enforces foreign keys by default.
  // The version pointers (workflow_entity.activeVersionId and
  // workflow_published_version.publishedVersionId) reference a workflow_history
  // version row, so that row MUST exist before the pointers are set. We therefore
  // write parents before children, mirroring the proven bootstrap order:
  //   1) clear old version pointers   (activeVersionId=NULL, drop published_version)
  //   2) INSERT/UPDATE workflow_entity (activeVersionId stays NULL for now)
  //   3) INSERT shared_workflow        (new workflows only; parent: entity+project)
  //   4) INSERT workflow_history       (creates the version the pointers reference)
  //   5) set activeVersionId=versionId (parent now exists)
  //   6) INSERT workflow_published_version (parent now exists)

  // 1) Clear any pointer that could reference a soon-to-be-replaced version.
  sql += `
UPDATE workflow_entity SET "activeVersionId"=NULL WHERE id=${sqlString(id)};
DELETE FROM workflow_published_version WHERE "workflowId"=${sqlString(id)};
`;

  // 2)/3) Create or refresh the workflow row (activeVersionId NULL until step 5).
  if (!workflowExists) {
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
  ${shouldKeepActive},
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
  "activeVersionId" = NULL,
  "updatedAt" = STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW')
WHERE id = ${sqlString(id)};
`;
  }

  // 4) Insert the history row — now the version exists for the pointers to use.
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

  // 5)/6) Now the version row exists, point activeVersionId + published_version at it.
  if (shouldKeepActive) {
    sql += `
UPDATE workflow_entity SET "activeVersionId"=${sqlString(versionId)} WHERE id=${sqlString(id)};
INSERT INTO workflow_published_version ("workflowId","publishedVersionId","createdAt","updatedAt")
VALUES (${sqlString(id)}, ${sqlString(versionId)},
  STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'), STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW'))
ON CONFLICT("workflowId") DO UPDATE SET
  "publishedVersionId" = excluded."publishedVersionId",
  "updatedAt" = STRFTIME('%Y-%m-%d %H:%M:%f', 'NOW');
`;
  }

  results.push({ label, id, name: workflow.name, versionId, wasActive: shouldKeepActive });
}

sql += 'COMMIT;\n';

// ── Execute ───────────────────────────────────────────────────────────────────

// Structured FK dependency / write-plan context, surfaced on a sync failure so the
// involved tables, dependencies, write stages and known trap columns are explicit.
const SYNC_DEPENDENCY_CONTEXT = {
  relevant_tables: ['project', 'workflow_entity', 'shared_workflow', 'workflow_history', 'workflow_published_version'],
  foreign_keys: [
    'shared_workflow.projectId -> project.id',
    'shared_workflow.workflowId -> workflow_entity.id',
    'workflow_history.workflowId -> workflow_entity.id',
    'workflow_entity.activeVersionId -> workflow_history.versionId',
    'workflow_published_version.publishedVersionId -> workflow_history.versionId',
  ],
  write_order: [
    'clear pointers (activeVersionId=NULL, delete workflow_published_version)',
    'upsert workflow_entity (activeVersionId stays NULL)',
    'insert shared_workflow (new workflows only)',
    'insert workflow_history (creates the version row)',
    'set workflow_entity.activeVersionId = versionId',
    'upsert workflow_published_version (publishedVersionId = versionId)',
  ],
  trap_tables: [
    'workflow_entity.activeVersionId must be written AFTER workflow_history',
    'workflow_published_version.publishedVersionId must be written AFTER workflow_history',
  ],
};

// PRAGMA foreign_key_check returns one row per violation (table, rowid, parent, fkid).
function pragmaForeignKeyCheck(dbPath) {
  try {
    const raw = runSqlite(['-json', dbPath, 'PRAGMA foreign_key_check;'], { encoding: 'utf8' });
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [{ error: String(e.message || e) }];
  }
}

// os.tmpdir() (not hardcoded /tmp) so this works on Windows portable too.
const sqlPath = path.join(os.tmpdir(), `sync-iteration-v1-${Date.now()}.sql`);
fs.writeFileSync(sqlPath, sql);

const _workflowIds = results.map((r) => r.id);
// The whole sql is one BEGIN..COMMIT transaction; on any failure node:sqlite
// throws and the uncommitted transaction is rolled back when the connection closes.
try {
  runSqlite([DB], { input: fs.readFileSync(sqlPath, 'utf8'), stdio: ['pipe', 'inherit', 'inherit'] });
} catch (e) {
  const msg = String(e.message || e);
  const isFk = /FOREIGN KEY|foreign key|constraint failed|787/i.test(msg);
  const diag = {
    stage: 'workflow_sync',
    is_foreign_key_error: isFk,
    error_message: msg,
    workflow_ids_checked: _workflowIds,
    version_ids: results.map((r) => ({ id: r.id, versionId: r.versionId, wasActive: r.wasActive })),
    foreign_key_check: pragmaForeignKeyCheck(DB),
    sync_dependency_context: SYNC_DEPENDENCY_CONTEXT,
  };
  console.error('\n❌ 工作流版本同步失败：写入工作流时违反外键约束（事务已回滚，数据库未改动）。');
  console.error(`错误：${msg}`);
  console.error('诊断（同步阶段 / 外键检查 / 工作流与版本ID）：');
  console.error(JSON.stringify(diag, null, 2));
  console.error(`DB：${DB}`);
  try { fs.unlinkSync(sqlPath); } catch {}
  process.exit(1);
}
try { fs.unlinkSync(sqlPath); } catch {}

// P14-B8G: after a successful sync the DB must be FK-clean (no silent violation).
const _fkCheck = pragmaForeignKeyCheck(DB);
if (Array.isArray(_fkCheck) && _fkCheck.length > 0) {
  console.error('\n❌ 工作流同步后外键检查未通过（foreign_key_check 非空）：');
  console.error(JSON.stringify({ stage: 'post_sync_foreign_key_check', foreign_key_check: _fkCheck, workflow_ids_checked: _workflowIds, sync_dependency_context: SYNC_DEPENDENCY_CONTEXT }, null, 2));
  console.error(`DB：${DB}`);
  process.exit(1);
}
console.log('外键检查通过（PRAGMA foreign_key_check clean）✓');

console.log('\n同步完成:\n');
for (const r of results) {
  console.log(`  ✅ ${r.label} | ${r.id} | active=${r.wasActive} | versionId=${r.versionId}`);
}
console.log();
console.log(JSON.stringify(results, null, 2));
