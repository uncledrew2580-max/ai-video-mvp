/**
 * scripts/win/n8n-db-ready.mjs — P14-B8E
 *
 * n8n DB schema-readiness helpers. On a fresh profile n8n reports /healthz ready
 * while its first-run SQLite migrations are still running, so the workflow
 * bootstrap can open an un-migrated DB and abort before the workbench/UI starts
 * (root cause of the B8D Windows startup failure). The launcher uses these to
 * wait for the workflow schema to actually exist BEFORE stopping n8n + running
 * the bootstrap / presence check.
 *
 * Read-only against the live DB via lib/sqlite-exec.mjs (node:sqlite first,
 * sqlite3 CLI fallback) — it never locks n8n while migrations run.
 */
import { existsSync } from 'node:fs';
import { runSqlite } from '../../lib/sqlite-exec.mjs';

// The minimum tables the workflow bootstrap / presence checks need. Mirrors the
// hasTable() guards in scripts/bootstrap-ai-video-workflows.mjs.
export const REQUIRED_SCHEMA_TABLES = ['workflow_entity', 'workflow_history', 'project'];

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

/** True only when every REQUIRED_SCHEMA_TABLES table exists (migrations done). */
export function n8nDbSchemaReady(dbPath) {
  const have = existingTables(dbPath, REQUIRED_SCHEMA_TABLES);
  return REQUIRED_SCHEMA_TABLES.every((t) => have.has(t));
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
 * missing". A not-yet-migrated DB returns status 'schema_not_ready' (found=null)
 * instead of reporting every workflow as missing.
 */
export function workflowPresence(dbPath, ids) {
  if (!n8nDbSchemaReady(dbPath)) {
    return { schemaReady: false, status: 'schema_not_ready', found: null };
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

export default { REQUIRED_SCHEMA_TABLES, existingTables, n8nDbSchemaReady, waitForN8nDbSchemaReady, workflowPresence };
