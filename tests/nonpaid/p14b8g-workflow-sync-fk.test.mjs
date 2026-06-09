// P14-B8G nonpaid tests — Windows fresh-DB workflow SYNC must not violate FKs.
// Reproduces the B8F failure (node:sqlite enforces foreign keys; the sync set the
// version pointers before the workflow_history row existed) on a synthetic n8n-2.x
// schema, and proves the FK-safe write order fixes it end-to-end via the real sync
// subprocess. Zero model calls, zero network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { runSqlite } from '../../lib/sqlite-exec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYNC = path.join(ROOT, 'sync_iteration_v1_workflows_to_db.mjs');

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch {}

const WF_IDS = ['rKHHjD2QBlL6EhaM', 'conceptSelectStoryboardV1', 'scriptGenerateV1', 'storyboardGenerateV1', 'reviewSubmitVeoV2'];

// A faithful slice of the n8n 2.x schema with the FKs that caused the B8F failure:
//  - shared_workflow.workflowId  -> workflow_entity.id
//  - shared_workflow.projectId   -> project.id
//  - workflow_history.workflowId -> workflow_entity.id
//  - workflow_entity.activeVersionId        -> workflow_history.versionId   (the trap)
//  - workflow_published_version.workflowId  -> workflow_entity.id
//  - workflow_published_version.publishedVersionId -> workflow_history.versionId (the trap)
function createN8nSchema(db) {
  db.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, type TEXT, name TEXT, "createdAt" TEXT);
    CREATE TABLE workflow_history (
      "versionId" TEXT PRIMARY KEY, "workflowId" TEXT NOT NULL, authors TEXT,
      nodes TEXT, connections TEXT, name TEXT, description TEXT, autosaved INTEGER,
      "createdAt" TEXT, "updatedAt" TEXT,
      FOREIGN KEY ("workflowId") REFERENCES workflow_entity ("id") ON DELETE CASCADE
    );
    CREATE TABLE workflow_entity (
      id TEXT PRIMARY KEY, name TEXT, active INTEGER, nodes TEXT, connections TEXT,
      settings TEXT, "staticData" TEXT, "pinData" TEXT, "versionId" TEXT,
      "triggerCount" INTEGER, meta TEXT, "parentFolderId" TEXT, "createdAt" TEXT,
      "updatedAt" TEXT, "isArchived" INTEGER, "versionCounter" INTEGER, description TEXT,
      "activeVersionId" TEXT,
      FOREIGN KEY ("activeVersionId") REFERENCES workflow_history ("versionId")
    );
    CREATE TABLE shared_workflow (
      "workflowId" TEXT NOT NULL, "projectId" TEXT NOT NULL, role TEXT,
      "createdAt" TEXT, "updatedAt" TEXT, PRIMARY KEY ("workflowId","projectId"),
      FOREIGN KEY ("workflowId") REFERENCES workflow_entity ("id") ON DELETE CASCADE,
      FOREIGN KEY ("projectId") REFERENCES project ("id") ON DELETE CASCADE
    );
    CREATE TABLE workflow_published_version (
      "workflowId" TEXT PRIMARY KEY, "publishedVersionId" TEXT, "createdAt" TEXT, "updatedAt" TEXT,
      FOREIGN KEY ("workflowId") REFERENCES workflow_entity ("id") ON DELETE CASCADE,
      FOREIGN KEY ("publishedVersionId") REFERENCES workflow_history ("versionId")
    );
  `);
}

// Fresh DB AFTER the bootstrap step: the 5 workflows already exist + active=1,
// so the sync takes the UPDATE path (the one that failed in B8F).
function seedBootstrapped(db) {
  db.exec(`INSERT INTO project (id, type, name, "createdAt") VALUES ('proj1','personal','Personal','2026-01-01');`);
  const stmt = db.prepare(`INSERT INTO workflow_entity (id, name, active, nodes, connections, settings, "pinData", meta, "versionId", "triggerCount", "isArchived", "versionCounter", "activeVersionId") VALUES (?,?,1,'[]','{}','{}','{}','{}',?,0,0,1,NULL)`);
  for (const id of WF_IDS) stmt.run(id, id, 'seed-' + id);
}

function mkDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-'));
  return { dir, db: path.join(dir, 'database.sqlite') };
}
function runSyncSubprocess(dbPath, ok = true) {
  const env = {
    ...process.env,
    N8N_DB_PATH: dbPath,
    TIKTOK_WORKFLOW_ROOT: ROOT,
    REVIEW_ASSET_PORT: '18788',
    WORKSPACE_HOST: 'http://127.0.0.1:18788',
  };
  try {
    const out = execFileSync(process.execPath, [SYNC], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}
function query(db, sql) {
  const d = new DatabaseSync(db, { readOnly: true });
  try { return d.prepare(sql).all(); } finally { d.close(); }
}

// ── Reproduction: the OLD (buggy) order DOES violate the FK under enforcement ──

test('repro: setting activeVersionId before the workflow_history row throws FOREIGN KEY', { skip: !DatabaseSync }, () => {
  const { dir, db } = mkDb();
  try {
    const d = new DatabaseSync(db);
    createN8nSchema(d);
    d.exec(`INSERT INTO project VALUES ('p','personal','P','t');`);
    d.exec(`INSERT INTO workflow_entity (id,name,active,nodes,connections,settings,"pinData",meta,"versionId","triggerCount","isArchived","versionCounter","activeVersionId") VALUES ('w','w',1,'[]','{}','{}','{}','{}','v0',0,0,1,NULL);`);
    // OLD order: point activeVersionId at a version whose history row does not exist yet.
    assert.throws(() => d.exec(`UPDATE workflow_entity SET "activeVersionId"='vNEW' WHERE id='w';`), /FOREIGN KEY|constraint/i);
    d.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── The fix: real sync subprocess seeds all 5 WFs FK-clean from a fresh DB ─────

test('fresh DB: sync seeds WF01/WF02/WF02a/WF02b/WF03 with no FK violation', { skip: !DatabaseSync }, () => {
  const { dir, db } = mkDb();
  try {
    const d = new DatabaseSync(db); createN8nSchema(d); seedBootstrapped(d); d.close();

    const { code, out } = runSyncSubprocess(db);
    assert.equal(code, 0, `sync must succeed; output:\n${out.slice(-1500)}`);
    assert.ok(/外键检查通过|foreign_key_check clean/.test(out), 'sync must report foreign_key_check clean');

    // All five present.
    const ids = new Set(query(db, `SELECT id FROM workflow_entity`).map((r) => r.id));
    for (const id of WF_IDS) assert.ok(ids.has(id), `${id} must be present after sync`);

    // foreign_key_check is clean.
    const violations = query(db, `PRAGMA foreign_key_check;`);
    assert.equal(violations.length, 0, `DB must be FK-clean, got: ${JSON.stringify(violations)}`);

    // Version relationships intact: each active workflow's activeVersionId + published
    // version resolve to a real workflow_history row.
    for (const id of WF_IDS) {
      const we = query(db, `SELECT "activeVersionId" AS v FROM workflow_entity WHERE id='${id}'`)[0];
      assert.ok(we && we.v, `${id} must have an activeVersionId`);
      const hist = query(db, `SELECT "versionId" AS v FROM workflow_history WHERE "versionId"='${we.v}'`);
      assert.equal(hist.length, 1, `${id} activeVersionId must reference a real workflow_history row`);
      const pub = query(db, `SELECT "publishedVersionId" AS v FROM workflow_published_version WHERE "workflowId"='${id}'`)[0];
      assert.ok(pub && pub.v, `${id} must have a published version`);
      assert.equal(query(db, `SELECT 1 FROM workflow_history WHERE "versionId"='${pub.v}'`).length, 1, `${id} publishedVersionId must reference a real history row`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed sync (missing project FK) rolls back and reports workflow_sync diagnostics', { skip: !DatabaseSync }, () => {
  const { dir, db } = mkDb();
  try {
    // Schema but NO project row and NO workflow rows → sync takes INSERT path and the
    // shared_workflow projectId FK fails. The transaction must roll back and the
    // process must emit workflow_sync FK diagnostics.
    const d = new DatabaseSync(db); createN8nSchema(d); d.close();
    const { code, out } = runSyncSubprocess(db);
    assert.equal(code, 1, 'sync must fail when a parent (project) is missing');
    assert.ok(/workflow_sync/.test(out), 'must report stage workflow_sync');
    assert.ok(/foreign_key_check/.test(out), 'must include a foreign_key_check in the diagnostics');
    assert.ok(/workflow_ids_checked/.test(out), 'must list workflow_ids_checked');
    // B8G review: structured table/dependency/write-plan context must be present.
    assert.ok(/sync_dependency_context/.test(out), 'must include sync_dependency_context');
    assert.ok(/relevant_tables/.test(out) && /foreign_keys/.test(out) && /write_order/.test(out) && /trap_tables/.test(out),
      'context must list relevant_tables / foreign_keys / write_order / trap_tables');
    // The specific dependencies and trap columns must be named explicitly.
    assert.ok(/shared_workflow\.projectId -> project\.id/.test(out), 'must name project -> shared_workflow.projectId');
    assert.ok(/shared_workflow\.workflowId -> workflow_entity\.id/.test(out), 'must name workflow_entity.id -> shared_workflow.workflowId');
    assert.ok(/workflow_history\.workflowId -> workflow_entity\.id/.test(out), 'must name workflow_entity.id -> workflow_history.workflowId');
    assert.ok(/workflow_entity\.activeVersionId -> workflow_history\.versionId/.test(out), 'must name workflow_history.versionId -> workflow_entity.activeVersionId');
    assert.ok(/workflow_published_version\.publishedVersionId -> workflow_history\.versionId/.test(out), 'must name workflow_history.versionId -> workflow_published_version.publishedVersionId');
    assert.ok(/activeVersionId must be written AFTER workflow_history/.test(out) && /publishedVersionId must be written AFTER workflow_history/.test(out),
      'trap_tables must state the write-after-history rule');
    // Rolled back: no partial workflow rows committed.
    assert.equal(query(db, `SELECT count(*) AS c FROM workflow_entity`)[0].c, 0, 'failed sync must not leave partial rows');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── runSqlite must surface FK errors (no silent CLI fallback masking them) ────

test('runSqlite surfaces a foreign-key error instead of falling back to the CLI', { skip: !DatabaseSync }, () => {
  const { dir, db } = mkDb();
  try {
    const d = new DatabaseSync(db);
    d.exec('CREATE TABLE a(id TEXT PRIMARY KEY); CREATE TABLE b(id TEXT, aid TEXT, FOREIGN KEY(aid) REFERENCES a(id));');
    d.close();
    // FK violation inside a transaction must throw and roll back — never be re-run
    // by the sqlite3 CLI (FK off) which would silently persist the bad row.
    assert.throws(
      () => runSqlite([db], { input: `BEGIN TRANSACTION; INSERT INTO b VALUES('1','NOPE'); COMMIT;` }),
      /FOREIGN KEY|constraint|SQLITE/i,
    );
    assert.equal(query(db, `SELECT count(*) AS c FROM b`)[0].c, 0, 'failed write must roll back (no CLI fallback persistence)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Source-level guarantees ───────────────────────────────────────────────────

test('sync writes parents before children (history before the version pointers)', () => {
  const src = fs.readFileSync(SYNC, 'utf8');
  const histIdx = src.indexOf('INSERT INTO workflow_history');
  const activeIdx = src.indexOf('SET "activeVersionId"=${sqlString(versionId)}');
  const pubIdx = src.indexOf('INSERT INTO workflow_published_version ("workflowId","publishedVersionId"');
  assert.ok(histIdx > 0 && activeIdx > histIdx, 'activeVersionId pointer must be set AFTER the workflow_history insert');
  assert.ok(pubIdx > histIdx, 'workflow_published_version must be inserted AFTER the workflow_history insert');
});

test('sync does NOT evade FKs by disabling foreign_keys, and verifies FK cleanliness', () => {
  const src = fs.readFileSync(SYNC, 'utf8');
  assert.ok(!/PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(src), 'sync must not disable foreign_keys to evade the problem');
  assert.ok(!/enableForeignKeyConstraints\s*:\s*false/i.test(src), 'sync must not disable FK enforcement');
  assert.ok(/PRAGMA foreign_key_check/.test(src), 'sync must run PRAGMA foreign_key_check');
  assert.ok(/post_sync_foreign_key_check/.test(src), 'sync must verify FK cleanliness after a successful sync');
});

test('sync triggers no model and handles no API key (image/Veo/network-free)', () => {
  const src = fs.readFileSync(SYNC, 'utf8');
  for (const bad of ['gemini-generate', 'veo-sdk', 'createTask', 'generativelanguage', 'api.kie.ai', 'AI_VIDEO_API_KEY', 'Authorization']) {
    assert.ok(!src.includes(bad), `sync must not reference ${bad}`);
  }
  assert.ok(!/\bfetch\(/.test(src) && !/https?\.request\(/.test(src), 'sync must make no network calls');
});

// ── UI smoke surfaces workflow_sync failure (B8G report fields) ───────────────

test('ui-smoke report can flag a workflow_sync failure with FK diagnostics', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'win', 'ui-smoke-image-only.mjs'), 'utf8');
  assert.ok(src.includes('workflow_sync'), 'ui-smoke must detect a workflow_sync failure');
  for (const f of ['sqlite_foreign_key_check', 'sync_stage', 'workflow_ids_checked']) {
    assert.ok(src.includes(f), `ui-smoke report must include ${f}`);
  }
});
