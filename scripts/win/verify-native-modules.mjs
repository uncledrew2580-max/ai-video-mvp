#!/usr/bin/env node
// P14-A1R2: verify the WINDOWS ARTIFACT TREE (the filtered portable staging
// node_modules), NOT the raw post-install tree. Every *.node that ships in the
// portable zip must be a Windows PE, machine x64 (0x8664). Mach-O/ELF or any
// darwin/linux path/filename in the staging tree => FAIL. Multi-platform packages
// may ship sibling prebuilds after `npm ci`, but the packaging filter must strip
// them before this check runs against the staging tree.
//
// Usage: node verify-native-modules.mjs [targetNodeModulesDir]
//   default target: <repo>/dist-win/AI-Video-Win-x64-Portable-RC-0001/node_modules
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_TARGET = path.join(ROOT, 'dist-win', 'AI-Video-Win-x64-Portable-RC-0001', 'node_modules');
const NM = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_TARGET;

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith('.node')) yield full;
  }
}

// Returns {ok, kind, machine} for a native addon file.
function classify(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    const m32 = head.readUInt32BE(0);
    if ([0xcafebabe, 0xfeedface, 0xfeedfacf, 0xcffaedfe, 0xcefaedfe].includes(m32)) return { ok: false, kind: 'mach-o' };
    if (m32 === 0x7f454c46) return { ok: false, kind: 'elf' };
    if (!(head[0] === 0x4d && head[1] === 0x5a)) return { ok: false, kind: 'unknown' }; // not "MZ"
    const peOff = head.readUInt32LE(0x3c);
    const peHdr = Buffer.alloc(6);
    fs.readSync(fd, peHdr, 0, 6, peOff);
    if (peHdr.toString('ascii', 0, 4) !== 'PE\0\0') return { ok: false, kind: 'pe?' };
    const machine = peHdr.readUInt16LE(4);
    return { ok: machine === 0x8664, kind: 'pe', machine: '0x' + machine.toString(16) };
  } finally { fs.closeSync(fd); }
}

if (!fs.existsSync(NM)) { console.error(`[native] FAIL: target tree missing: ${NM}`); process.exit(1); }
console.log(`[native] verifying artifact tree: ${NM}`);

let total = 0; const bad = []; const leaks = []; const mods = new Set();
for (const f of walk(NM)) {
  total++;
  const rel = path.relative(NM, f);
  mods.add(rel.split(path.sep)[0]);
  // 3) any darwin/linux path or filename in the staging tree is forbidden.
  if (/(?:^|[\\/_.-])(darwin|linux)(?:[\\/_.-]|$)/i.test(rel)) leaks.push(rel);
  const c = classify(f);
  if (!c.ok) bad.push(`${rel} [${c.kind}${c.machine ? ' ' + c.machine : ''}]`);
}
console.log(`[native] scanned ${total} .node in ${mods.size} modules`);

let failed = false;
if (total === 0) { console.error('[native] FAIL: no native addons in staging tree — assemble missing node_modules?'); failed = true; }
if (leaks.length) {
  console.error(`[native] FAIL: ${leaks.length} darwin/linux-named .node in staging tree (must be filtered out):`);
  for (const l of leaks.slice(0, 30)) console.error('  - ' + l);
  failed = true;
}
if (bad.length) {
  console.error(`[native] FAIL: ${bad.length} non-win32-x64 .node in staging tree:`);
  for (const b of bad.slice(0, 30)) console.error('  - ' + b);
  failed = true;
}

// 4) explicit key-module report.
const KEY = {
  '@img/sharp-win32-x64': '@img/sharp-win32-x64',
  'sqlite3': 'sqlite3',
  '@parcel/watcher': path.join('@parcel', 'watcher'),
  'cpu-features': 'cpu-features',
  '@sentry-internal/node-cpu-profiler': path.join('@sentry-internal', 'node-cpu-profiler'),
};
for (const [label, rel] of Object.entries(KEY)) {
  const dir = path.join(NM, rel);
  if (!fs.existsSync(dir)) { console.log(`[native] key: ${label} -> absent (excluded by packaging filter or not needed)`); continue; }
  const found = [...walk(dir)];
  const allWin = found.every((f) => classify(f).ok);
  console.log(`[native] key: ${label} -> present, ${found.length} .node, win32-x64=${found.length === 0 ? 'n/a' : allWin}`);
  if (found.length && !allWin) failed = true;
}

if (failed) process.exit(1);
console.log('[native] PASS: artifact tree native addons are all win32-x64 PE; no darwin/linux leak.');
