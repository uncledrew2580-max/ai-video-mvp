/**
 * lib/sqlite-exec.mjs — P14-B7
 *
 * A drop-in replacement for the previous `execFileSync('sqlite3', args, opts)`
 * call sites. The Windows portable does NOT ship the `sqlite3` CLI, but the
 * bundled Node (v24.x) exposes the built-in `node:sqlite` DatabaseSync class.
 *
 * Resolution order (per P14-B7):
 *   1. node:sqlite DatabaseSync   (works everywhere the bundled node runs)
 *   2. system `sqlite3` CLI       (fallback for older runtimes / dev machines)
 *
 * `runSqlite(args, options)` mimics the sqlite3 CLI argument shape used across
 * this codebase so the call sites change by name only:
 *   - runSqlite([DB, sql], { encoding:'utf8' })            → plain list output
 *   - runSqlite(['-json', DB, sql], { encoding:'utf8' })   → JSON array string
 *   - runSqlite(['-cmd', '.timeout 8000', DB, sql], {...}) → plain list output
 *   - runSqlite([DB], { input: sqlScript })                → run a multi-stmt script
 *
 * Output parity with the sqlite3 CLI for the shapes this project relies on:
 *   - JSON mode  → `JSON.stringify(rows)` (rows = array of column objects)
 *   - list mode  → rows joined by '\n', columns within a row joined by '|',
 *                  NULL rendered as '' (matches `sqlite3` default list mode for
 *                  the single-column SELECTs used here).
 *   - script in  → executed as one batch; returns '' (callers ignore stdout).
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let _DatabaseSync;
let _checked = false;

/** Lazily resolve node:sqlite's DatabaseSync; returns null if unavailable. */
function loadDatabaseSync() {
  if (_checked) return _DatabaseSync;
  _checked = true;
  try {
    // Built-in since Node 22.5 (experimental). Available unflagged on v24.x.
    ({ DatabaseSync: _DatabaseSync } = require('node:sqlite'));
  } catch {
    _DatabaseSync = null;
  }
  return _DatabaseSync;
}

/** True when the built-in node:sqlite engine can be used. */
export function hasNodeSqlite() {
  return Boolean(loadDatabaseSync());
}

/**
 * Parse a sqlite3-CLI-style argv into { dbPath, sql, jsonMode }.
 * Skips formatting flags we set ourselves (-cmd '.timeout N', -json).
 */
function parseArgs(args) {
  let jsonMode = false;
  let dbPath = null;
  const tail = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-json') { jsonMode = true; continue; }
    if (a === '-cmd') { i++; continue; } // skip the dot-command (e.g. ".timeout 8000")
    if (typeof a === 'string' && a.startsWith('-') && a.length > 1) { continue; } // ignore other flags
    if (dbPath === null) { dbPath = a; continue; }
    tail.push(a);
  }
  return { dbPath, sql: tail.join('\n').trim(), jsonMode };
}

function listRowToLine(row) {
  return Object.values(row)
    .map((v) => (v === null || v === undefined ? '' : String(v)))
    .join('|');
}

function runWithNodeSqlite(DatabaseSync, parsed, options) {
  const { dbPath, sql, jsonMode } = parsed;
  const script = options && typeof options.input === 'string' ? options.input : null;
  // Read-only for pure queries (no lock contention with a live n8n); read-write
  // when executing a script (bootstrap/sync run while n8n is stopped).
  const db = script
    ? new DatabaseSync(dbPath)
    : new DatabaseSync(dbPath, { readOnly: true });
  try {
    try { db.exec('PRAGMA busy_timeout=8000;'); } catch {}
    if (script) {
      db.exec(script);
      return '';
    }
    if (!sql) return '';
    const stmt = db.prepare(sql);
    const rows = stmt.all();
    if (jsonMode) return JSON.stringify(rows);
    return rows.map(listRowToLine).join('\n');
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * Run a sqlite query/script. Prefers node:sqlite; falls back to the sqlite3 CLI.
 * Returns a string (utf8), matching the previous execFileSync('sqlite3', …) usage.
 */
export function runSqlite(args, options = {}) {
  const DatabaseSync = loadDatabaseSync();
  if (DatabaseSync) {
    try {
      return runWithNodeSqlite(DatabaseSync, parseArgs(args), options);
    } catch (nodeErr) {
      // Fall back to the CLI only if it actually exists; otherwise surface the
      // node:sqlite error so genuine SQL failures are not silently swallowed.
      try {
        return execFileSync('sqlite3', args, { encoding: 'utf8', ...options });
      } catch (cliErr) {
        if (cliErr && cliErr.code === 'ENOENT') throw nodeErr;
        throw cliErr;
      }
    }
  }
  return execFileSync('sqlite3', args, { encoding: 'utf8', ...options });
}

export default runSqlite;
