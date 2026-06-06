#!/usr/bin/env node
/**
 * check-port-safety.mjs — Read-only static audit of port conflict handling
 *
 * Checks:
 *   1. _IS_DIST && !n8nOwnedByThisApp path does NOT call killProcessesOnPort
 *   2. UI port non-owned path does NOT call killProcessesOnPort
 *   3. killProcessesOnPort is only reachable for known-owned (this App) processes
 *   4. The remaining killProcessesOnPort call (owned stale process) has a clear owner check
 *   5. Error messages for external-occupied ports include LOG_DIR (no hardcoded user path)
 *   6. 8788 source-dev detect path does NOT call killProcessesOnPort
 *
 * NEVER reads or outputs secret values.
 *
 * Usage: node scripts/check-port-safety.mjs
 * Exit 0 = all clear, Exit 1 = issues found
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER_PATH = path.join(PROJECT_ROOT, 'client', 'launcher.mjs');

const rows = [];
let anyFail = false;

function addRow(check, status, detail) {
  rows.push({ check, status, detail });
  if (status === 'FAIL') anyFail = true;
}

if (!fs.existsSync(LAUNCHER_PATH)) {
  console.error(`launcher.mjs not found: ${LAUNCHER_PATH}`);
  process.exit(2);
}

const src = fs.readFileSync(LAUNCHER_PATH, 'utf8');

// ── Extract the main() function body for scoped analysis ─────────────────────
const mainStart = src.indexOf('async function main()');
const mainBody = mainStart !== -1 ? src.slice(mainStart) : src;

// ── Helper: find a block of text between two markers ─────────────────────────
function sliceBetween(text, startPat, endPat) {
  const s = text.search(startPat);
  if (s === -1) return '';
  const e = text.indexOf(endPat, s + 10);
  return e !== -1 ? text.slice(s, e + endPat.length) : text.slice(s, s + 600);
}

// ── Check 1: _IS_DIST && !n8nOwnedByThisApp branch ───────────────────────────
// This block should NOT contain killProcessesOnPort
{
  const block = sliceBetween(mainBody,
    /if\s*\(_IS_DIST\s*&&\s*!n8nOwnedByThisApp\)/,
    '} else if (n8nHealthy)',
  );

  const hasKill = /killProcessesOnPort/.test(block);
  const hasExit = /process\.exit\(1\)/.test(block);
  const hasFailMsg = /AI Video 未清理该进程/.test(block);

  addRow(
    'n8n external (dist+!owned): no killProcessesOnPort',
    !hasKill ? 'PASS' : 'FAIL',
    !hasKill ? 'block contains no killProcessesOnPort call' : 'STILL calls killProcessesOnPort for external process',
  );
  addRow(
    'n8n external (dist+!owned): exits with process.exit(1)',
    hasExit ? 'PASS' : 'FAIL',
    hasExit ? 'process.exit(1) found in block' : 'no process.exit(1) — may not block startup',
  );
  addRow(
    'n8n external (dist+!owned): error says AI Video did not kill',
    hasFailMsg ? 'PASS' : 'WARN',
    hasFailMsg ? '"AI Video 未清理该进程" found in error message' : 'message text not found — verify manually',
  );
}

// ── Check 2: UI port non-owned branch ────────────────────────────────────────
// After the ownsPort check, the else branch should NOT contain killProcessesOnPort
{
  const ownsPortIdx = mainBody.indexOf('const ownsPort =');
  const afterOwnsPort = ownsPortIdx !== -1 ? mainBody.slice(ownsPortIdx) : '';
  // Grab text up to the 8788 source-dev warn block as a boundary
  const blockEnd = afterOwnsPort.indexOf('// Warn about source dev server on 8788');
  const uiBlock = blockEnd !== -1 ? afterOwnsPort.slice(0, blockEnd) : afterOwnsPort.slice(0, 1200);

  const hasKill = /killProcessesOnPort\(UI_PORT\)/.test(uiBlock);
  const hasDistExit = /_IS_DIST[\s\S]{0,300}AI Video 未清理该进程/.test(uiBlock);
  const hasDevExit = /lsof -ti:/.test(uiBlock);

  addRow(
    'UI non-owned: no killProcessesOnPort(UI_PORT)',
    !hasKill ? 'PASS' : 'FAIL',
    !hasKill ? 'block contains no killProcessesOnPort(UI_PORT)' : 'STILL calls killProcessesOnPort(UI_PORT)',
  );
  addRow(
    'UI non-owned (dist): error says AI Video did not kill',
    hasDistExit ? 'PASS' : 'FAIL',
    hasDistExit ? '"AI Video 未清理该进程" in dist branch' : 'dist error message pattern not found',
  );
  addRow(
    'UI non-owned (dev): provides diagnostic lsof hint (no kill)',
    hasDevExit ? 'PASS' : 'WARN',
    hasDevExit ? 'lsof diagnostic hint found for dev mode' : 'dev diagnostic hint not found — verify manually',
  );
}

// ── Check 3: killProcessesOnPort is only reached when owned by this App ───────
// The only remaining calls should be inside the "else" block that follows
// the n8nHealthy check — which is only reachable when n8nOwnedByThisApp is true
// (because _IS_DIST && !n8nOwnedByThisApp is handled first and exits).
{
  // Count total killProcessesOnPort calls in main()
  const allKillCalls = [...mainBody.matchAll(/killProcessesOnPort\(/g)];
  const killCount = allKillCalls.length;

  // They should only appear inside the "owned stale" block (dist+owned+unhealthy)
  // Extract that block: after "} else {" following the n8nHealthy branch, before the UI port block
  const ownedStaleBlock = sliceBetween(mainBody,
    /端口 .* 被本 App 旧进程占用但健康检查失败/,
    'if (uiPortState',
  );
  const killsInOwnedBlock = [...ownedStaleBlock.matchAll(/killProcessesOnPort\(/g)].length;

  addRow(
    `killProcessesOnPort: all ${killCount} call(s) are for owned-stale process only`,
    killCount === killsInOwnedBlock ? 'PASS' : 'FAIL',
    killCount === killsInOwnedBlock
      ? `${killCount} call(s) in main(), all within the owned-stale-process block`
      : `${killCount} call(s) in main(), only ${killsInOwnedBlock} in owned-stale block — extra calls may target unknown processes`,
  );
}

// ── Check 4: owned-stale block message clarifies it is our own process ────────
{
  const hasOwnedMsg = /本 App 旧进程/.test(src);
  addRow(
    'n8n owned-stale error: message clarifies it is this App\'s process',
    hasOwnedMsg ? 'PASS' : 'WARN',
    hasOwnedMsg ? '"本 App 旧进程" found in stale-process message' : 'owned-stale message text not found',
  );
}

// ── Check 4b: broker kill is guarded by ownership check ──────────────────────
// killProcessesOnPort(N8N_RUNNERS_BROKER_PORT) must only be reached when
// brokerOwnedByThisApp is true; there must also be a fail+exit for the
// busy-but-not-owned case.
{
  const ownedStaleBlock = sliceBetween(mainBody,
    /端口 .* 被本 App 旧进程占用但健康检查失败/,
    'if (uiPortState',
  );

  // The broker kill must be conditional: brokerOwnedByThisApp && kill
  const brokerKillIsGuarded = /brokerOwnedByThisApp[\s\S]{0,50}killProcessesOnPort\(N8N_RUNNERS_BROKER_PORT\)/.test(ownedStaleBlock) ||
    /killProcessesOnPort\(N8N_RUNNERS_BROKER_PORT\)[\s\S]{0,10}/.test(ownedStaleBlock) &&
    /if\s*\([^)]*brokerOwnedByThisApp[^)]*\)[\s\S]{0,80}killProcessesOnPort\(N8N_RUNNERS_BROKER_PORT\)/.test(ownedStaleBlock);

  const brokerOwnershipVarPresent = /brokerOwnedByThisApp\s*=/.test(ownedStaleBlock);
  const brokerNotOwnedExits = /!brokerOwnedByThisApp[\s\S]{0,200}process\.exit\(1\)/.test(ownedStaleBlock);

  addRow(
    'broker kill: brokerOwnedByThisApp variable checked before kill',
    brokerOwnershipVarPresent ? 'PASS' : 'FAIL',
    brokerOwnershipVarPresent
      ? 'brokerOwnedByThisApp variable assigned in owned-stale block'
      : 'brokerOwnedByThisApp not found — broker kill may target unknown process',
  );
  addRow(
    'broker kill: not-owned path exits (no kill of external broker)',
    brokerNotOwnedExits ? 'PASS' : 'FAIL',
    brokerNotOwnedExits
      ? '!brokerOwnedByThisApp branch calls process.exit(1)'
      : '!brokerOwnedByThisApp exit not found — may kill external broker process',
  );
  addRow(
    'broker kill: kill call is inside brokerOwnedByThisApp guard',
    brokerKillIsGuarded ? 'PASS' : 'FAIL',
    brokerKillIsGuarded
      ? 'killProcessesOnPort(N8N_RUNNERS_BROKER_PORT) is inside ownership guard'
      : 'kill call not clearly guarded by brokerOwnedByThisApp check',
  );
}

// ── Check 5: 8788 source-dev block does NOT call killProcessesOnPort ──────────
{
  const warnBlock8788 = sliceBetween(src,
    /Warn about source dev server on 8788/,
    'const children',
  );
  const hasKill = /killProcessesOnPort/.test(warnBlock8788);
  addRow(
    '8788 source-dev detect: no killProcessesOnPort',
    !hasKill ? 'PASS' : 'FAIL',
    !hasKill ? '8788 warn block contains no kill call' : '8788 block calls killProcessesOnPort',
  );
}

// ── Check 6: error messages use LOG_DIR variable (no hardcoded paths) ─────────
{
  // Grab error messages for external n8n and external UI
  const n8nExtMsg = sliceBetween(mainBody, /AI Video 未清理该进程/, 'process.exit(1)');
  const hasLogDirInN8nMsg = n8nExtMsg.includes('LOG_DIR');

  // Check UI dist message too
  const uiDistMsg = sliceBetween(mainBody, /_IS_DIST[\s\S]{0,5}\n[\s\S]{0,20}fail/, 'process.exit(1)');
  const hasLogDirInUiMsg = src.includes('LOG_DIR') && /AI Video 未清理该进程[\s\S]{0,200}LOG_DIR/.test(src);

  addRow(
    'external port error messages: reference LOG_DIR variable',
    (hasLogDirInN8nMsg || hasLogDirInUiMsg) ? 'PASS' : 'WARN',
    (hasLogDirInN8nMsg || hasLogDirInUiMsg)
      ? 'LOG_DIR variable referenced in external-port error messages'
      : 'LOG_DIR not found in error messages — verify absolute path is shown',
  );
}

// ── Render ────────────────────────────────────────────────────────────────────

const COL = { check: 60, status: 8 };
const header = ['check'.padEnd(COL.check), 'status'.padEnd(COL.status), 'detail'].join('  ');
const sep = '-'.repeat(header.length);

console.log('\n=== check-port-safety — static analysis, no secrets output ===\n');
console.log(header);
console.log(sep);
for (const r of rows) {
  const statusDisplay =
    r.status === 'PASS' ? '✅ PASS ' :
    r.status === 'FAIL' ? '❌ FAIL ' :
    r.status === 'WARN' ? '⚠️  WARN ' :
    '   SKIP ';
  console.log([
    String(r.check).padEnd(COL.check),
    statusDisplay.padEnd(COL.status),
    String(r.detail).slice(0, 120),
  ].join('  '));
}
console.log(sep);

if (anyFail) {
  console.log('\n❌ RESULT: One or more port safety checks FAILED.');
  process.exit(1);
} else {
  console.log('\n✅ RESULT: All port safety checks passed.');
  process.exit(0);
}
