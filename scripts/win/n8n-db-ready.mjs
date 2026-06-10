/**
 * scripts/win/n8n-db-ready.mjs — P14-B8E / P14-B8K
 *
 * n8n DB schema-readiness helpers. On a fresh profile n8n reports /healthz ready
 * while its first-run SQLite migrations are still running, so the workflow
 * bootstrap can open an un-migrated DB and abort before the workbench/UI starts.
 *
 * B8D failed on "no such table: workflow_entity"; B8J failed later on
 * "no such table: workflow_published_version" — because the readiness gate only
 * checked 3 tables while the bootstrap/sync touch 5 (workflow_published_version
 * and shared_workflow are created by LATER migrations). The gate must wait for
 * EVERY table the bootstrap/sync write before n8n is stopped + bootstrapped.
 *
 * Read-only against the live DB via lib/sqlite-exec.mjs (node:sqlite first,
 * sqlite3 CLI fallback) — it never locks n8n while migrations run. /healthz being
 * ready is NOT sufficient; SQLite schema presence is the source of truth.
 */
import { existsSync, readFileSync } from 'node:fs';
import { runSqlite } from '../../lib/sqlite-exec.mjs';

// EVERY table the workflow bootstrap + sync read/write. Mirrors the tables in
// scripts/bootstrap-ai-video-workflows.mjs and sync_iteration_v1_workflows_to_db.mjs:
//   workflow_entity, workflow_history, workflow_published_version (B8J trap),
//   shared_workflow, project. The DB is only "ready" once ALL of these exist.
export const REQUIRED_SCHEMA_TABLES = [
  'workflow_entity',
  'workflow_history',
  'workflow_published_version',
  'shared_workflow',
  'project',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Return the subset of `names` that currently exist as tables in the DB. */
export function existingTables(dbPath, names) {
  if (!dbPath || !existsSync(dbPath)) return new Set();
  try {
    const inList = names.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',');
    const raw = runSqlite(['-json', dbPath,
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${inList});`,
    ], { encoding: 'utf8' });
    const rows = raw ? JSON.parse(raw) : [];
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

/** The required tables that do NOT yet exist (empty array => schema ready). */
export function missingSchemaTables(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return [...REQUIRED_SCHEMA_TABLES];
  const have = existingTables(dbPath, REQUIRED_SCHEMA_TABLES);
  return REQUIRED_SCHEMA_TABLES.filter((t) => !have.has(t));
}

/** True only when every REQUIRED_SCHEMA_TABLES table exists (migrations done). */
export function n8nDbSchemaReady(dbPath) {
  return missingSchemaTables(dbPath).length === 0;
}

/**
 * Best-effort migration progress read from the n8n log. SQLite schema presence is
 * authoritative; this is a DIAGNOSTIC signal only (logs can be stale/unreliable).
 * Returns 'in_progress' | 'idle' | 'unknown'.
 */
export function migrationLogState(logPath) {
  try {
    if (!logPath || !existsSync(logPath)) return 'unknown';
    const text = readFileSync(logPath, 'utf8');
    if (!text) return 'unknown';
    const started = (text.match(/Starting migration|Running migration|Migrations in progress/gi) || []).length;
    const finished = (text.match(/Finished migration/gi) || []).length;
    if (started === 0 && finished === 0) return 'unknown';
    return started > finished ? 'in_progress' : 'idle';
  } catch {
    return 'unknown';
  }
}

/**
 * Structured readiness diagnostics for the launcher + smoke-report.
 * { db_file_exists, schema_ready, missing_tables, migration_log_state }
 */
export function n8nDbReadinessReport(dbPath, options = {}) {
  const db_file_exists = Boolean(dbPath && existsSync(dbPath));
  const missing_tables = missingSchemaTables(dbPath);
  return {
    db_file_exists,
    schema_ready: db_file_exists && missing_tables.length === 0,
    missing_tables,
    migration_log_state: migrationLogState(options.logPath),
  };
}

/**
 * Poll until the workflow schema is ready or `timeoutMs` elapses (default 120s).
 * Never waits forever; returns a boolean. `onWait` is invoked once when the first
 * not-ready poll happens (used to surface the Chinese "initializing" state).
 */
export async function waitForN8nDbSchemaReady(dbPath, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 2000;
  const onWait = typeof options.onWait === 'function' ? options.onWait : () => {};
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    if (n8nDbSchemaReady(dbPath)) return true;
    if (!announced) { try { onWait(); } catch {} announced = true; }
    await sleep(intervalMs);
  }
  return n8nDbSchemaReady(dbPath); // one final check at the deadline
}

/**
 * Workflow presence that DISTINGUISHES "schema not ready" from "genuinely
 * missing". A not-yet-migrated DB (any required table absent, incl.
 * workflow_published_version) returns status 'schema_not_ready' (found=null)
 * instead of reporting every workflow as missing.
 */
export function workflowPresence(dbPath, ids) {
  if (!n8nDbSchemaReady(dbPath)) {
    return { schemaReady: false, status: 'schema_not_ready', found: null, missing_tables: missingSchemaTables(dbPath) };
  }
  const found = {};
  try {
    const inList = ids.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(',');
    const raw = runSqlite(['-json', dbPath,
      `SELECT id FROM workflow_entity WHERE id IN (${inList});`,
    ], { encoding: 'utf8' });
    const rows = raw ? JSON.parse(raw) : [];
    const present = new Set(rows.map((r) => r.id));
    for (const id of ids) found[id] = present.has(id);
  } catch {
    return { schemaReady: true, status: 'query_error', found: null };
  }
  return { schemaReady: true, status: 'ok', found };
}

export default {
  REQUIRED_SCHEMA_TABLES,
  existingTables,
  missingSchemaTables,
  n8nDbSchemaReady,
  migrationLogState,
  n8nDbReadinessReport,
  waitForN8nDbSchemaReady,
  workflowPresence,
};
