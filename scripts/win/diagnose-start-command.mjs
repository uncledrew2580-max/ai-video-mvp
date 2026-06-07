#!/usr/bin/env node
// P14-B2R2: surface the REAL first error behind n8n's masked "Command start not found".
// n8n's command-registry catches the start.js load error and only logs the masked
// message; here we load start.js DIRECTLY (resolving from the portable staging tree)
// and print the full error.stack/name/message/code (+ requireStack), plus a
// resolution/existence/zod audit. Diagnostic ONLY — does not modify anything, does
// not start the server, no model calls.
//
// Usage: <bundled node.exe> diagnose-start-command.mjs <stagingTreeDir>
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STAGE = path.resolve(process.argv[2] || '.');
const NM = path.join(STAGE, 'node_modules');
const rel = (p) => path.relative(STAGE, p);
const log = (m) => process.stdout.write(m + '\n');

log('======== n8n start-command first-error diagnostic ========');
log(`staging: ${STAGE}`);
log(`node: ${process.execPath} (${process.version}) ${process.platform}/${process.arch}`);

// 1) key file existence
log('\n--- key file existence ---');
const EXIST = [
  'n8n/bin/n8n',
  'n8n/dist/commands/start.js',
  'n8n/dist/command-registry.js',
  'n8n/dist/config/index.js',
  '@n8n/backend-common/dist/modules/module-registry.js',
  'n8n/dist/modules/breaking-changes/breaking-changes.module.js',
  'n8n/dist/modules/breaking-changes.ee/breaking-changes.module.js',
];
for (const r of EXIST) {
  const exists = fs.existsSync(path.join(NM, ...r.split('/')));
  log(`  ${exists ? 'EXISTS ' : 'MISSING'} ${r}`);
}
log('  note: n8n 2.16.1 ships dist/modules/breaking-changes/ (no .ee). The .ee path is');
log('        only the loader fallback, so a MISSING breaking-changes.ee is EXPECTED/ok.');

// 2) require.resolve from the staging tree context
log('\n--- require.resolve (anchored at staging node_modules) ---');
const req = createRequire(path.join(NM, '__resolve__.cjs'));
for (const spec of ['n8n', 'n8n/dist/commands/start.js', 'zod', '@n8n/config', '@n8n/backend-common', 'n8n-workflow', '@n8n/api-types']) {
  try { log(`  OK   ${spec} -> ${rel(req.resolve(spec))}`); }
  catch (e) { log(`  FAIL ${spec} -> ${e.code || e.message}`); }
}

// 3) all zod copies + packages declaring a zod dependency
log('\n--- all zod package dirs in staging ---');
const zodDirs = [];
const depsOnZod = [];
(function walk(dir, depth) {
  if (depth > 8) return;
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink() || !e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name === 'node_modules') { walk(full, depth + 1); continue; }
    const pj = path.join(full, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
        if (j.name === 'zod') zodDirs.push(`${rel(full)} (zod@${j.version})`);
        const d = { ...(j.dependencies || {}), ...(j.peerDependencies || {}) };
        if (d.zod) depsOnZod.push(`${rel(full)} (${j.name || '?'}) zod:${d.zod}`);
      } catch {}
    }
    walk(full, depth);
  }
})(NM, 0);
log(`  zod copies: ${zodDirs.length}`);
for (const z of zodDirs.slice(0, 50)) log(`    ${z}`);
log(`  packages declaring a zod dependency: ${depsOnZod.length}`);
for (const d of depsOnZod.slice(0, 60)) log(`    ${d}`);

// 4) load start.js directly and capture the REAL first error
log('\n--- loading n8n/dist/commands/start.js (capturing real first error) ---');
const startPath = path.join(NM, 'n8n', 'dist', 'commands', 'start.js');
if (!process.env.N8N_USER_FOLDER) {
  process.env.N8N_USER_FOLDER = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-diag-'));
}
process.env.N8N_ENCRYPTION_KEY = process.env.N8N_ENCRYPTION_KEY || 'p14diag00000000000000000000000000';
try {
  await import(pathToFileURL(startPath).href);
  log('  start.js loaded OK (no error)');
} catch (e) {
  log(`  REAL ERROR name:    ${e && e.name}`);
  log(`  REAL ERROR message: ${e && e.message}`);
  log(`  REAL ERROR code:    ${e && e.code}`);
  if (e && e.requireStack) log('  requireStack:\n    ' + e.requireStack.join('\n    '));
  log('  REAL ERROR stack:\n' + (e && e.stack ? e.stack : '(no stack)'));
}
log('======== end diagnostic ========');
