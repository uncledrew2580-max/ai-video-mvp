#!/usr/bin/env node
/**
 * Bootstrap AI Video's canonical n8n workflows into a SQLite n8n database.
 *
 * This is intentionally local and deterministic: the desktop launcher can run
 * it on first start so the packaged app is not just a web shell pointing at an
 * empty n8n instance.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runSqlite } from '../lib/sqlite-exec.mjs';

const ROOT = process.env.PROJECT_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ITER_DIR = path.join(ROOT, '正式导入文件', 'iteration-v1');
const DB =
  process.env.N8N_DB_PATH ||
  (process.env.N8N_USER_FOLDER
    ? path.join(process.env.N8N_USER_FOLDER, '.n8n', 'database.sqlite')
    : path.join(os.homedir(), '.n8n', 'database.sqlite'));

const SPECS = [
  { file: 'n8n01.json', id: 'rKHHjD2QBlL6EhaM', label: 'WF01', active: 1 },
  { file: 'n8n02a.json', id: 'scriptGenerateV1', label: 'WF02A', active: 1 },
  { file: 'n8n02b.json', id: 'storyboardGenerateV1', label: 'WF02B', active: 1 },
  { file: 'n8n03.json', id: 'reviewSubmitVeoV2', label: 'WF03', active: 1 },
];

function sqlString(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  return `'${text.replace(/'/g, "''")}'`;
}

function sqlite(query) {
  // node:sqlite first (Windows portable ships no sqlite3 CLI), CLI fallback.
  return runSqlite(['-cmd', '.timeout 8000', DB, query], {
    encoding: 'utf8',
  });
}

function hasTable(tableName) {
  const count = sqlite(
    `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=${sqlString(tableName)};`,
  ).trim();
  return count !== '0';
}

function getSingleValue(query) {
  try {
    return sqlite(query).trim();
  } catch {
    return '';
  }
}

function validateWorkflow(spec, workflow) {
  const raw = JSON.stringify(workflow);
  // Use full key pattern (30+ chars) to avoid false-positives from redaction regex literals
  if (/AIzaSy[A-Za-z0-9_-]{30,}/.test(raw)) {
    throw new Error(`${spec.label} contains a hardcoded Gemini key`);
  }
  if (raw.includes('/Users/drew')) {
    throw new Error(`${spec.label} contains a hardcoded developer path`);
  }

  const requiredById = {
    rKHHjD2QBlL6EhaM: ['creative_task_type_mapping', 'prompts/prompt_center.json'],
    scriptGenerateV1: ['storyboard-concept-select-v1', '写脚本框架上下文'],
    storyboardGenerateV1: ['storyboard-generate-v1', '读取脚本上下文'],
    reviewSubmitVeoV2: ['review_submit_resume', 'modelhub'],
  };
  for (const token of requiredById[spec.id] || []) {
    if (!raw.includes(token)) {
      throw new Error(`${spec.label} is missing required token: ${token}`);
    }
  }
}

if (!fs.existsSync(DB)) {
  console.error(JSON.stringify({ ok: false, changed: false, reason: `n8n database does not exist: ${DB}` }));
  process.exit(2);
}
if (!hasTable('workflow_entity') || !hasTable('workflow_history') || !hasTable('project')) {
  console.error(JSON.stringify({ ok: false, changed: false, reason: `n8n database schema is not ready: ${DB}` }));
  process.exit(2);
}

const projectId =
  getSingleValue(`SELECT id FROM project WHERE type='personal' ORDER BY "createdAt" LIMIT 1;`) ||
  getSingleValue(`SELECT id FROM project ORDER BY "createdAt" LIMIT 1;`);

if (!projectId) {
  console.error(JSON.stringify({ ok: false, changed: false, reason: 'n8n personal project is not ready yet' }));
  process.exit(2);
}

// Patch Form Trigger redirectUrl to use the runtime workspace host.
// Launcher injects REVIEW_ASSET_PORT (e.g. 18788 for dist, 8788 for source dev).
const _uiPort = process.env.REVIEW_ASSET_PORT || '8788';
const _workspaceHost = (process.env.WORKSPACE_HOST || `http://127.0.0.1:${_uiPort}`).replace(/\/+$/, '');

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

const workflows = SPECS.map((spec) => {
  const filePath = path.join(ITER_DIR, spec.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${spec.label} source file missing: ${filePath}`);
  }
  const workflow = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  workflow.id = spec.id;
  patchFormTriggerUrl(workflow);
  validateWorkflow(spec, workflow);
  return { spec, workflow };
});

let changed = false;
let sql = 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n';
const results = [];

for (const { spec, workflow } of workflows) {
  const versionId = crypto.randomUUID();
  const exists = getSingleValue(
    `SELECT COUNT(*) FROM workflow_entity WHERE id=${sqlString(spec.id)};`,
  ) !== '0';

  const oldVersion = getSingleValue(
    `SELECT "versionId" FROM workflow_entity WHERE id=${sqlString(spec.id)} LIMIT 1;`,
  );

  const nextNodes = JSON.stringify(workflow.nodes || []);
  const nextConnections = JSON.stringify(workflow.connections || {});
  const nextSettings = JSON.stringify(workflow.settings || {});
  const nextPinData = JSON.stringify(workflow.pinData || {});
  const nextMeta = JSON.stringify(workflow.meta || {});

  const same =
    exists &&
    getSingleValue(`SELECT nodes FROM workflow_entity WHERE id=${sqlString(spec.id)} LIMIT 1;`) === nextNodes &&
    getSingleValue(`SELECT connections FROM workflow_entity WHERE id=${sqlString(spec.id)} LIMIT 1;`) === nextConnections &&
    getSingleValue(`SELECT active FROM workflow_entity WHERE id=${sqlString(spec.id)} LIMIT 1;`) === String(spec.active);

  changed ||= !same;

  sql += `
DELETE FROM workflow_published_version WHERE "workflowId"=${sqlString(spec.id)};
UPDATE workflow_entity SET "activeVersionId"=NULL WHERE id=${sqlString(spec.id)};
`;

  if (exists) {
    sql += `
UPDATE workflow_entity SET
  name=${sqlString(workflow.name)},
  nodes=${sqlString(nextNodes)},
  connections=${sqlString(nextConnections)},
  settings=${sqlString(nextSettings)},
  "pinData"=${sqlString(nextPinData)},
  meta=${sqlString(nextMeta)},
  "versionId"=${sqlString(versionId)},
  active=${spec.active},
  "updatedAt"=STRFTIME('%Y-%m-%d %H:%M:%f','NOW')
WHERE id=${sqlString(spec.id)};
`;
  } else {
    sql += `
INSERT INTO workflow_entity (
  "id","name","active","nodes","connections","settings",
  "staticData","pinData","versionId","triggerCount","meta",
  "parentFolderId","createdAt","updatedAt","isArchived",
  "versionCounter","description","activeVersionId"
) VALUES (
  ${sqlString(spec.id)},
  ${sqlString(workflow.name)},
  ${spec.active},
  ${sqlString(nextNodes)},
  ${sqlString(nextConnections)},
  ${sqlString(nextSettings)},
  NULL,
  ${sqlString(nextPinData)},
  ${sqlString(versionId)},
  0,
  ${sqlString(nextMeta)},
  NULL,
  STRFTIME('%Y-%m-%d %H:%M:%f','NOW'),
  STRFTIME('%Y-%m-%d %H:%M:%f','NOW'),
  0, 1, NULL, NULL
);
INSERT OR IGNORE INTO shared_workflow ("workflowId","projectId","role","createdAt","updatedAt")
VALUES (${sqlString(spec.id)}, ${sqlString(projectId)}, 'workflow:owner',
  STRFTIME('%Y-%m-%d %H:%M:%f','NOW'), STRFTIME('%Y-%m-%d %H:%M:%f','NOW'));
`;
  }

  sql += `
INSERT INTO workflow_history (
  "versionId","workflowId","authors","nodes","connections",
  "name","description","autosaved","createdAt","updatedAt"
) VALUES (
  ${sqlString(versionId)}, ${sqlString(spec.id)}, 'AI Video',
  ${sqlString(nextNodes)}, ${sqlString(nextConnections)},
  ${sqlString(workflow.name)}, NULL, 0,
  STRFTIME('%Y-%m-%d %H:%M:%f','NOW'), STRFTIME('%Y-%m-%d %H:%M:%f','NOW')
);
UPDATE workflow_entity SET "activeVersionId"=${sqlString(versionId)} WHERE id=${sqlString(spec.id)};
INSERT INTO workflow_published_version ("workflowId","publishedVersionId","createdAt","updatedAt")
VALUES (${sqlString(spec.id)}, ${sqlString(versionId)},
  STRFTIME('%Y-%m-%d %H:%M:%f','NOW'), STRFTIME('%Y-%m-%d %H:%M:%f','NOW'));
`;

  results.push({ id: spec.id, label: spec.label, name: workflow.name, active: spec.active, versionId, oldVersion });
}

// The old combined WF02 must stay disabled after the split workflow is present.
sql += `
UPDATE workflow_entity
SET active=0, "activeVersionId"=NULL, "updatedAt"=STRFTIME('%Y-%m-%d %H:%M:%f','NOW')
WHERE id='conceptSelectStoryboardV1';
COMMIT;
PRAGMA foreign_keys=ON;
`;

const sqlPath = path.join(os.tmpdir(), `ai-video-bootstrap-${Date.now()}.sql`);
fs.writeFileSync(sqlPath, sql);
try {
  runSqlite([DB], {
    input: fs.readFileSync(sqlPath, 'utf8'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} finally {
  fs.rmSync(sqlPath, { force: true });
}

console.log(JSON.stringify({ ok: true, changed, db: DB, workflows: results }, null, 2));
