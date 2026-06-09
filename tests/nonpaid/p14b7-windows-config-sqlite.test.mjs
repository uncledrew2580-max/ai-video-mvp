/**
 * P14-B7 nonpaid tests — Windows AppData config path + node:sqlite workflow
 * presence + lifecycle tooling.
 *
 * Covers two confirmed Windows root causes:
 *   1. AI Video.exe must inject AppData env so config never lands in
 *      resources/runtime/版本测试/config.
 *   2. Workflow presence must resolve via node:sqlite (Windows portable ships no
 *      sqlite3 CLI), not the system sqlite3 binary.
 *
 * Pure logic + filesystem + a temp SQLite DB. No server boot, no n8n, no model
 * calls, no network, no paid APIs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runSqlite, hasNodeSqlite } from '../../lib/sqlite-exec.mjs';
import { atomicWriteJson } from '../../版本测试/lib/atomic-write.mjs';
import { redactObject } from '../../app-server/shared/redact.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIN_MAIN = path.join(REPO_ROOT, 'desktop', 'win-main.cjs');
const LAUNCHER = path.join(REPO_ROOT, 'client', 'launcher.mjs');
const ASSEMBLE = path.join(REPO_ROOT, 'scripts', 'win', 'assemble-windows-portable.mjs');
const CLIENT_SHAPE = path.join(REPO_ROOT, 'scripts', 'win', 'check-client-shape.mjs');

const WF_IDS = [
  ['rKHHjD2QBlL6EhaM', 'WF01'],
  ['conceptSelectStoryboardV1', 'WF02'],
  ['scriptGenerateV1', 'WF02a'],
  ['storyboardGenerateV1', 'WF02b'],
  ['reviewSubmitVeoV2', 'WF03'],
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p14b7-'));
}

// ── A. node:sqlite workflow presence (no system sqlite3) ──────────────────────

test('node:sqlite is available on the bundled runtime', () => {
  // The Windows portable ships node v24, where node:sqlite is built in. If this
  // ever regresses to false, the helper silently falls back to the (absent)
  // sqlite3 CLI on Windows — which is exactly the bug we are fixing.
  assert.equal(hasNodeSqlite(), true, 'node:sqlite DatabaseSync must be available');
});

test('workflow presence resolves WF01/WF02/WF02a/WF02b/WF03 via runSqlite', () => {
  const base = tmpDir();
  const db = path.join(base, 'database.sqlite');
  try {
    // Build a minimal n8n-like workflow_entity table via the helper's script path.
    runSqlite([db], {
      input: `CREATE TABLE workflow_entity (id TEXT PRIMARY KEY, name TEXT, active INTEGER, nodes TEXT);`,
    });
    let insert = 'BEGIN;';
    for (const [id, label] of WF_IDS) {
      insert += `INSERT INTO workflow_entity (id, name, active, nodes) VALUES ('${id}', '${label} flow', 1, '[]');`;
    }
    insert += 'COMMIT;';
    runSqlite([db], { input: insert });

    // Per-id presence (mirrors serve-review-assets WF_SPECS loop).
    for (const [id, label] of WF_IDS) {
      const raw = runSqlite(['-json', db, `SELECT id, name, active, nodes FROM workflow_entity WHERE id='${id}' LIMIT 1;`], { encoding: 'utf8' }).trim();
      const rows = raw ? JSON.parse(raw) : [];
      assert.equal(rows.length, 1, `${label} (${id}) must be found`);
      assert.equal(rows[0].id, id);
      assert.equal(Number(rows[0].active), 1);
    }

    // Aggregate count (mirrors the /system self-check query, 4 core ids).
    const rawCount = runSqlite(['-json', db,
      "SELECT count(*) AS c FROM workflow_entity WHERE id IN ('rKHHjD2QBlL6EhaM','scriptGenerateV1','storyboardGenerateV1','reviewSubmitVeoV2');",
    ], { encoding: 'utf8' }).trim();
    assert.equal(JSON.parse(rawCount)[0].c, 4);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('runSqlite plain (list) mode returns a single trimmed column value', () => {
  const base = tmpDir();
  const db = path.join(base, 'database.sqlite');
  try {
    runSqlite([db], { input: `CREATE TABLE webhook_entity (workflowId TEXT, method TEXT, webhookPath TEXT);
      INSERT INTO webhook_entity VALUES ('rKHHjD2QBlL6EhaM','GET','form-abc');` });
    const out = runSqlite([db,
      `SELECT webhookPath FROM webhook_entity WHERE workflowId='rKHHjD2QBlL6EhaM' AND method='GET' LIMIT 1;`,
    ], { encoding: 'utf8' }).trim();
    assert.equal(out, 'form-abc');

    // -cmd '.timeout N' is accepted and ignored (busy_timeout is set internally).
    const cnt = runSqlite(['-cmd', '.timeout 8000', db,
      `SELECT COUNT(*) FROM webhook_entity WHERE workflowId='rKHHjD2QBlL6EhaM';`,
    ], { encoding: 'utf8' }).trim();
    assert.equal(cnt, '1');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('runSqlite returns empty string when no rows match (plain mode)', () => {
  const base = tmpDir();
  const db = path.join(base, 'database.sqlite');
  try {
    runSqlite([db], { input: `CREATE TABLE t (v TEXT);` });
    const out = runSqlite([db, `SELECT v FROM t WHERE v='nope' LIMIT 1;`], { encoding: 'utf8' }).trim();
    assert.equal(out, '');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── B. Windows config path is AppData, not resources/runtime/版本测试/config ───

test('win-main.cjs injects the full AppData env set', () => {
  const src = fs.readFileSync(WIN_MAIN, 'utf8');
  for (const key of [
    'AI_VIDEO_HOME', 'AI_VIDEO_CONFIG_DIR', 'AI_VIDEO_CONFIG_PATH',
    'AI_VIDEO_LOG_DIR', 'AI_VIDEO_RUNTIME_ROOT', 'WORKFLOW_DATA_ROOT', 'N8N_USER_FOLDER',
  ]) {
    assert.ok(src.includes(key), `win-main.cjs must inject ${key}`);
  }
  // Paths derive from Electron's appData (= %APPDATA% on Windows), under "AI Video".
  assert.ok(src.includes("app.getPath('appData')"), 'win-main.cjs must base paths on appData');
  assert.ok(/['"]AI Video['"]/.test(src), 'win-main.cjs must scope user data under "AI Video"');
  assert.ok(src.includes('local-config.json'), 'win-main.cjs config path must end at local-config.json');
  // Must NOT build a config path into the read-only packaged source tree. (A
  // quoted '版本测试' path segment would mean config is being written there; a
  // bare mention inside a comment is fine.)
  assert.ok(!/['"]版本测试['"]/.test(src), 'win-main.cjs must never path-join into 版本测试');
});

test('win-main.cjs points N8N_USER_FOLDER at workflow-data, never n8n-user', () => {
  const src = fs.readFileSync(WIN_MAIN, 'utf8');
  // n8n user folder must equal the workflow-data root so the n8n DB lives under
  // %APPDATA%\AI Video\workflow-data (the P14-B7 directory boundary).
  assert.ok(/n8nUserFolder:\s*path\.join\(home,\s*['"]workflow-data['"]\)/.test(src),
    'win-main.cjs n8nUserFolder must resolve to workflow-data');
  assert.ok(!/['"]n8n-user['"]/.test(src),
    'win-main.cjs must not use an n8n-user folder on Windows dist');
});

test('assemble ENV_BLOCK sets N8N_USER_FOLDER to workflow-data (not n8n-user)', () => {
  const src = fs.readFileSync(ASSEMBLE, 'utf8');
  assert.ok(src.includes('set "N8N_USER_FOLDER=%AI_VIDEO_HOME%\\\\workflow-data"'),
    'cmd-mode ENV_BLOCK must set N8N_USER_FOLDER to workflow-data');
  assert.ok(!src.includes('N8N_USER_FOLDER=%AI_VIDEO_HOME%\\\\n8n-user'),
    'cmd-mode ENV_BLOCK must not point N8N_USER_FOLDER at n8n-user');
});

test('launcher Windows dist defaults N8N_USER_FOLDER to workflow-data', () => {
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  // win32 dist default must derive the n8n DB from the workflow-data root so the
  // exe, cmd, and default paths never split.
  assert.ok(/process\.platform === 'win32'\s*\?\s*join\(APP_SUPPORT_DIR, 'workflow-data'\)/.test(src),
    'launcher win32 dist N8N_USER_FOLDER default must be APP_SUPPORT_DIR/workflow-data');
});

test('launcher dist detection honors AI_VIDEO_APP_MODE and packaged layout', () => {
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  assert.ok(src.includes("process.env.AI_VIDEO_APP_MODE === '1'"),
    'launcher _IS_DIST must treat AI_VIDEO_APP_MODE=1 as dist (Windows packaged exe/cmd)');
  assert.ok(src.includes('/resources/runtime/'),
    'launcher _IS_DIST must recognize the Windows resources/runtime/ packaged layout');
  // Config path stays env-first so injected AppData paths win over source defaults.
  assert.ok(src.includes('process.env.AI_VIDEO_CONFIG_PATH'),
    'launcher CONFIG_PATH must prefer the injected AI_VIDEO_CONFIG_PATH');
});

// ── C. client/n8n config path consistency ─────────────────────────────────────

test('launcher passes the same CONFIG_PATH to n8n and the UI server', () => {
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  // Both the n8n child env and the UI child env must set AI_VIDEO_CONFIG_PATH
  // from the single CONFIG_PATH const, so save-path and read-path agree.
  const occurrences = (src.match(/AI_VIDEO_CONFIG_PATH:\s*CONFIG_PATH/g) || []).length;
  assert.ok(occurrences >= 2,
    `launcher must forward AI_VIDEO_CONFIG_PATH: CONFIG_PATH to both n8n and UI (found ${occurrences})`);
});

// ── D. API key save/reload reports configured without leaking the key ─────────

test('config save/reload reports configured=true and never echoes the key', () => {
  const base = tmpDir();
  const cfgPath = path.join(base, 'AI Video', 'config', 'local-config.json');
  try {
    const secret = 'kie-sk-9f8e7d6c5b4a3210ZYXWVUTSRQPONMLK';
    atomicWriteJson(cfgPath, { providers: { kie: { api_key: secret } } });
    assert.equal(fs.existsSync(cfgPath + '.tmp'), false);

    const reloaded = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const key = (reloaded.providers?.kie?.api_key || '').trim();
    // Status logic mirrors serve: configured iff a non-empty key is present.
    assert.equal(Boolean(key), true, 'reloaded config must report the key configured');

    // Any surfacing of the config must redact — the raw secret must never leak.
    const redacted = redactObject(reloaded);
    assert.notEqual(redacted.providers.kie.api_key, secret, 'api_key must be masked');
    assert.equal(JSON.stringify(redacted).includes(secret), false, 'status must not leak the api key');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── E. Lifecycle tools + PID path ─────────────────────────────────────────────

test('win-main.cjs writes/removes the AppData runtime PID file safely', () => {
  const src = fs.readFileSync(WIN_MAIN, 'utf8');
  assert.ok(src.includes('ai-video.pid'), 'win-main.cjs must use ai-video.pid');
  assert.ok(/['"]runtime['"]/.test(src), 'PID file must live under the AI Video/runtime dir');
  assert.ok(src.includes('writePidFile') && src.includes('removePidFile'),
    'win-main.cjs must both write and remove the PID file');
  // Only removes a PID it owns — never kills/cleans an unknown process.
  assert.ok(src.includes('=== String(process.pid)'),
    'removePidFile must verify the file names this process before unlinking');
});

test('assemble emits Stop-AI-Video.cmd guarded by image name + PID file', () => {
  const src = fs.readFileSync(ASSEMBLE, 'utf8');
  assert.ok(src.includes("'Stop-AI-Video.cmd'"), 'assemble must write tools/Stop-AI-Video.cmd');
  assert.ok(src.includes('ai-video.pid'), 'Stop cmd must read the ai-video.pid file');
  assert.ok(src.includes('IMAGENAME eq AI Video.exe'),
    'Stop cmd must only target the AI Video.exe image (never an unknown PID)');
  // Open-Logs + Export-Diagnostics lifecycle tools remain present.
  assert.ok(src.includes("'Open-Logs.cmd'") && src.includes("'Export-Diagnostics.cmd'"),
    'Open-Logs.cmd and Export-Diagnostics.cmd must still be emitted');
});

test('client-shape requires the Stop-AI-Video lifecycle tool', () => {
  const src = fs.readFileSync(CLIENT_SHAPE, 'utf8');
  assert.ok(src.includes('tools/Stop-AI-Video.cmd'),
    'check-client-shape must require tools/Stop-AI-Video.cmd');
});
