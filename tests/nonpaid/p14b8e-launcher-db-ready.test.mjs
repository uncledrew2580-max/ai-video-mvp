// P14-B8E nonpaid tests — n8n DB schema-readiness gate for the Windows launcher.
// Reproduces the B8D race: /healthz ready but first-run migrations unfinished.
// Uses real temp SQLite DBs (node:sqlite); zero model calls, zero network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  REQUIRED_SCHEMA_TABLES,
  n8nDbSchemaReady,
  missingSchemaTables,
  migrationLogState,
  n8nDbReadinessReport,
  waitForN8nDbSchemaReady,
  workflowPresence,
} from '../../scripts/win/n8n-db-ready.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAUNCHER = path.join(ROOT, 'client', 'launcher.mjs');
const UI_SCRIPT = path.join(ROOT, 'scripts', 'win', 'ui-smoke-image-only.mjs');

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8e-db-'));
  return { dir, db: path.join(dir, 'database.sqlite') };
}
function createSchema(dbPath, tables = REQUIRED_SCHEMA_TABLES) {
  const d = new DatabaseSync(dbPath);
  // workflow_entity needs an id column for the presence query.
  for (const t of tables) {
    d.exec(t === 'workflow_entity' ? `CREATE TABLE workflow_entity (id TEXT PRIMARY KEY, name TEXT);` : `CREATE TABLE ${t} (id TEXT);`);
  }
  d.close();
}

// ── Schema readiness ──────────────────────────────────────────────────────────

test('n8nDbSchemaReady: false when the DB file is absent', () => {
  assert.equal(n8nDbSchemaReady(path.join(os.tmpdir(), 'b8e-nope', 'database.sqlite')), false);
});

test('n8nDbSchemaReady: false while migrations are unfinished (tables missing)', { skip: !DatabaseSync }, () => {
  const { dir, db } = tmpDb();
  try {
    // Mimic an early-migration DB: a connection exists but workflow tables absent.
    const d = new DatabaseSync(db); d.exec('CREATE TABLE migrations (id TEXT);'); d.close();
    assert.equal(n8nDbSchemaReady(db), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('n8nDbSchemaReady: true once all required tables exist', { skip: !DatabaseSync }, () => {
  const { dir, db } = tmpDb();
  try {
    createSchema(db);
    assert.equal(n8nDbSchemaReady(db), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('waitForN8nDbSchemaReady: returns false fast on timeout (no infinite wait)', { skip: !DatabaseSync }, async () => {
  const { dir, db } = tmpDb();
  try {
    const d = new DatabaseSync(db); d.exec('CREATE TABLE migrations (id TEXT);'); d.close();
    const t0 = Date.now();
    const ok = await waitForN8nDbSchemaReady(db, { timeoutMs: 300, intervalMs: 50 });
    const elapsed = Date.now() - t0;
    assert.equal(ok, false, 'must report not-ready on timeout');
    assert.ok(elapsed < 2000, `must not hang (took ${elapsed}ms)`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('waitForN8nDbSchemaReady: succeeds when the schema appears mid-wait (the B8D race)', { skip: !DatabaseSync }, async () => {
  const { dir, db } = tmpDb();
  try {
    const d = new DatabaseSync(db); d.exec('CREATE TABLE migrations (id TEXT);'); d.close();
    let onWaitCalls = 0;
    // Simulate n8n finishing migrations ~150ms after we start waiting.
    setTimeout(() => createSchema(db), 150);
    const ok = await waitForN8nDbSchemaReady(db, { timeoutMs: 5000, intervalMs: 40, onWait: () => { onWaitCalls++; } });
    assert.equal(ok, true, 'must become ready once migrations finish');
    assert.ok(onWaitCalls >= 1, 'onWait (initializing state) must fire while not-ready');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Presence must NOT misreport all-missing when the schema is not ready ───────

test('workflowPresence: schema missing → schema_not_ready (NOT all-missing)', { skip: !DatabaseSync }, () => {
  const { dir, db } = tmpDb();
  try {
    const d = new DatabaseSync(db); d.exec('CREATE TABLE migrations (id TEXT);'); d.close();
    const res = workflowPresence(db, ['rKHHjD2QBlL6EhaM', 'scriptGenerateV1', 'storyboardGenerateV1', 'reviewSubmitVeoV2']);
    assert.equal(res.schemaReady, false);
    assert.equal(res.status, 'schema_not_ready');
    assert.equal(res.found, null, 'must not return a found-map (would imply genuine presence data)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('workflowPresence: schema ready → real found-map', { skip: !DatabaseSync }, () => {
  const { dir, db } = tmpDb();
  try {
    createSchema(db);
    const d = new DatabaseSync(db);
    d.exec(`INSERT INTO workflow_entity (id, name) VALUES ('rKHHjD2QBlL6EhaM','WF01'),('scriptGenerateV1','WF02a');`);
    d.close();
    const res = workflowPresence(db, ['rKHHjD2QBlL6EhaM', 'scriptGenerateV1', 'storyboardGenerateV1']);
    assert.equal(res.status, 'ok');
    assert.equal(res.found.rKHHjD2QBlL6EhaM, true);
    assert.equal(res.found.scriptGenerateV1, true);
    assert.equal(res.found.storyboardGenerateV1, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Launcher integration (source-level) ───────────────────────────────────────

test('launcher waits for DB schema readiness BEFORE running the workflow bootstrap', () => {
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  assert.ok(src.includes("from '../scripts/win/n8n-db-ready.mjs'"), 'launcher must import the readiness helper');
  const waitIdx = src.indexOf('waitForN8nDbSchemaReady(');
  const bootstrapIdx = src.indexOf('runWorkflowBootstrap(n8nDbPathForUi)');
  assert.ok(waitIdx > 0 && bootstrapIdx > 0 && waitIdx < bootstrapIdx,
    'readiness wait must run before runWorkflowBootstrap');
});

test('launcher shows the Chinese init state and a timeout error with a diagnostics path', () => {
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  assert.ok(src.includes('正在初始化本地工作流引擎'), 'must surface the Chinese initializing state');
  assert.ok(src.includes('n8n 数据库初始化未完成，请稍后重试或导出诊断包'), 'must surface the Chinese timeout error');
  // The timeout message must point at the log/DB path for diagnostics.
  assert.ok(/n8n 数据库初始化未完成[\s\S]{0,120}(日志|n8n\.log|DB)/.test(src), 'timeout error must include a diagnostics/log path');
  assert.ok(/timeoutMs:\s*120000/.test(src), 'readiness wait must be capped (120s)');
});

test('readiness helper passes node --check and never reads workflow rows before ready', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'win', 'n8n-db-ready.mjs'), 'utf8');
  // The schema check only queries sqlite_master, never the workflow tables.
  assert.ok(/sqlite_master/.test(src), 'readiness must check sqlite_master');
  // workflowPresence guards on n8nDbSchemaReady before any workflow_entity read.
  const guardIdx = src.indexOf('if (!n8nDbSchemaReady(dbPath))');
  const readIdx = src.indexOf('FROM workflow_entity');
  assert.ok(guardIdx > 0 && readIdx > guardIdx, 'must not read workflow_entity before the readiness guard');
});

// ── UI smoke: no-window fast-fail + diagnostics (B8E) ─────────────────────────

test('ui-smoke wraps the window wait in a hard Promise.race (no run-to-cap)', () => {
  const src = fs.readFileSync(UI_SCRIPT, 'utf8');
  assert.ok(/Promise\.race\(\[\s*\n\s*waitForWorkbench\(/.test(src) || /Promise\.race\(\[[\s\S]{0,80}waitForWorkbench\(/.test(src),
    'window wait must be raced against a hard timeout');
});

test('ui-smoke no-window report carries window/diagnostic fields', () => {
  const src = fs.readFileSync(UI_SCRIPT, 'utf8');
  for (const f of ['window_detected', 'screenshot_available', 'no_window_reason', 'launcher_tail', 'runtime_healthz', 'n8n_healthz']) {
    assert.ok(src.includes(f), `report must include ${f}`);
  }
  assert.ok(src.includes('window-diagnostics.json') && src.includes('process-list.txt') && src.includes('ports-listening.txt'),
    'no-window path must still capture window/process/port diagnostics');
  // launcher_tail is redacted; no raw key material.
  assert.ok(/redactString\(electronOut\.buf/.test(src), 'launcher_tail must be redacted');
});

// Behavioral: missing app still fast-fails and writes a complete report with the
// new no-window fields — no Playwright, no app, no network, no model, no key leak.
test('B8E behavioral: missing app → report has no-window fields + no key leak', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'b8e-out-'));
  const DUMMY = 'dummy-key-ZZZ-not-a-real-secret-0123456789';
  let exitCode = 0;
  try {
    execFileSync(process.execPath, [UI_SCRIPT, path.join(out, 'no-such-stage')], {
      env: { ...process.env, REAL_SMOKE_SCOPE: 'image_only', DISABLE_VIDEO_GENERATION: 'true', UI_SMOKE_MODE: 'diagnostic', AI_VIDEO_API_KEY: DUMMY, AI_VIDEO_SMOKE_OUT: out },
      stdio: 'pipe', timeout: 60_000,
    });
  } catch (e) { exitCode = e.status ?? 1; }
  assert.equal(exitCode, 1);
  const raw = fs.readFileSync(path.join(out, 'smoke-report.json'), 'utf8');
  const r = JSON.parse(raw);
  assert.equal(r.status, 'failed');
  assert.ok('screenshot_available' in r && 'no_window_reason' in r, 'report must carry the no-window fields');
  assert.equal(r.video_generation_skipped, true);
  assert.equal(r.veo_not_called, true);
  assert.equal(r.final_merge_not_called, true);
  assert.equal(r.api_key_leaked, false);
  assert.equal(raw.includes(DUMMY), false, 'the API key must never appear in the report');
  fs.rmSync(out, { recursive: true, force: true });
});

// ── P14-B8K: readiness must cover the FULL schema (workflow_published_version) ──

test('B8K: REQUIRED_SCHEMA_TABLES covers every table bootstrap/sync touch', () => {
  for (const t of ['workflow_entity', 'workflow_history', 'workflow_published_version', 'shared_workflow', 'project']) {
    assert.ok(REQUIRED_SCHEMA_TABLES.includes(t), `REQUIRED_SCHEMA_TABLES must include ${t}`);
  }
});

test('B8K: /healthz ready but workflow_published_version missing → NOT ready (no bootstrap)', { skip: !DatabaseSync }, () => {
  const { dir, db } = tmpDb();
  try {
    // The B8J state: the 3 old tables exist but the later-migration tables do not.
    createSchema(db, ['workflow_entity', 'workflow_history', 'project']);
    assert.equal(n8nDbSchemaReady(db), false, 'must not be ready while workflow_published_version is missing');
    const missing = missingSchemaTables(db);
    assert.ok(missing.includes('workflow_published_version'), 'missing must list workflow_published_version');
    assert.ok(missing.includes('shared_workflow'), 'missing must list shared_workflow');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B8K: waits (does not fail) until workflow_published_version appears mid-migration', { skip: !DatabaseSync }, async () => {
  const { dir, db } = tmpDb();
  try {
    createSchema(db, ['workflow_entity', 'workflow_history', 'project']);
    // Later migration creates the remaining tables ~150ms in.
    setTimeout(() => { try { createSchema(db, ['workflow_published_version', 'shared_workflow']); } catch {} }, 150);
    const ok = await waitForN8nDbSchemaReady(db, { timeoutMs: 5000, intervalMs: 40 });
    assert.equal(ok, true, 'must become ready once the late-migration tables exist');
    assert.equal(missingSchemaTables(db).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B8K: all 5 tables present → ready (bootstrap may run)', { skip: !DatabaseSync }, () => {
  const { dir, db } = tmpDb();
  try {
    createSchema(db); // all REQUIRED_SCHEMA_TABLES
    assert.equal(n8nDbSchemaReady(db), true);
    assert.deepEqual(missingSchemaTables(db), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B8K: readiness report exposes db_file_exists / schema_ready / missing_tables / migration_log_state', { skip: !DatabaseSync }, () => {
  const { dir, db } = tmpDb();
  try {
    createSchema(db, ['workflow_entity', 'workflow_history', 'project']);
    const logPath = path.join(dir, 'n8n.log');
    fs.writeFileSync(logPath, 'Starting migration AddX\nFinished migration AddX\nStarting migration AddPublishedVersion\n');
    const rep = n8nDbReadinessReport(db, { logPath });
    assert.equal(rep.db_file_exists, true);
    assert.equal(rep.schema_ready, false);
    assert.ok(rep.missing_tables.includes('workflow_published_version'));
    assert.equal(rep.migration_log_state, 'in_progress', 'unfinished Starting migration => in_progress');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B8K: migrationLogState reads in_progress vs idle vs unknown', { skip: !DatabaseSync }, () => {
  const { dir } = tmpDb();
  try {
    const lp = path.join(dir, 'n8n.log');
    fs.writeFileSync(lp, 'Starting migration A\nFinished migration A\n');
    assert.equal(migrationLogState(lp), 'idle');
    fs.writeFileSync(lp, 'Starting migration A\nFinished migration A\nStarting migration B\n');
    assert.equal(migrationLogState(lp), 'in_progress');
    fs.writeFileSync(lp, 'n8n ready on port 5678\n');
    assert.equal(migrationLogState(lp), 'unknown');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B8K: workflowPresence does NOT misreport all-missing when a later table is absent', { skip: !DatabaseSync }, () => {
  const { dir, db } = tmpDb();
  try {
    // workflow_entity HAS the 5 WF rows, but workflow_published_version is missing.
    createSchema(db, ['workflow_entity', 'workflow_history', 'project']);
    const d = new DatabaseSync(db);
    d.exec(`INSERT INTO workflow_entity (id, name) VALUES ('rKHHjD2QBlL6EhaM','WF01');`);
    d.close();
    const res = workflowPresence(db, ['rKHHjD2QBlL6EhaM', 'scriptGenerateV1']);
    assert.equal(res.schemaReady, false, 'schema not ready while workflow_published_version is missing');
    assert.equal(res.status, 'schema_not_ready');
    assert.equal(res.found, null, 'must NOT report a found-map (would falsely show all-missing)');
    assert.ok(Array.isArray(res.missing_tables) && res.missing_tables.includes('workflow_published_version'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Launcher + UI-smoke: classification + diagnostics (source-level) ──────────

test('B8K: launcher emits a structured [db-readiness] line + missing-table Chinese error', () => {
  const src = fs.readFileSync(LAUNCHER, 'utf8');
  assert.ok(src.includes('n8nDbReadinessReport'), 'launcher must compute a readiness report');
  assert.ok(/\[db-readiness\]/.test(src), 'launcher must log a structured [db-readiness] line');
  assert.ok(src.includes('n8n 数据库初始化未完成，请稍后重试或导出诊断包'), 'Chinese readiness-timeout error');
  assert.ok(/缺失表/.test(src), 'timeout error must list the missing tables');
  assert.ok(/healthz_ready/.test(src) && /waited_ms/.test(src), 'readiness must record healthz_ready + waited_ms');
});

test('B8K: ui-smoke classifies "no such table" as n8n_migration_readiness (not workflow_sync)', () => {
  const src = fs.readFileSync(UI_SCRIPT, 'utf8');
  assert.ok(/no such table[\s\S]{0,120}n8n_migration_readiness/.test(src) || /failed_stage = 'n8n_migration_readiness'/.test(src),
    'a missing table must be failed_stage=n8n_migration_readiness');
  // The migration-readiness branch must come BEFORE the workflow_sync branch.
  const migIdx = src.indexOf("'n8n_migration_readiness'");
  const syncIdx = src.indexOf("report.failed_stage = 'workflow_sync'");
  assert.ok(migIdx > 0 && syncIdx > 0 && migIdx < syncIdx, 'migration-readiness classification must precede workflow_sync');
  for (const f of ['db_readiness', 'healthz_ready', 'schema_ready', 'missing_tables', 'migration_log_state']) {
    assert.ok(src.includes(f), `report must include ${f}`);
  }
});
