#!/usr/bin/env node
// P14-A1: prove the node_modules native addons were built for win32-x64 ON the
// Windows runner (npm ci), NOT hard-copied from macOS. Every *.node must be a
// Windows PE (MZ header) with machine type x64 (0x8664). Mach-O/ELF => FAIL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NM = path.join(ROOT, 'node_modules');

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
    // Mach-O (darwin): feedface/feedfacf/cafebabe(fat). ELF (linux): 7f454c46.
    const m32 = head.readUInt32BE(0);
    if ([0xcafebabe, 0xfeedface, 0xfeedfacf, 0xcffaedfe, 0xcefaedfe].includes(m32)) return { ok: false, kind: 'mach-o' };
    if (m32 === 0x7f454c46) return { ok: false, kind: 'elf' };
    if (!(head[0] === 0x4d && head[1] === 0x5a)) return { ok: false, kind: 'unknown' }; // not "MZ"
    // PE: e_lfanew at 0x3C -> "PE\0\0" -> Machine (uint16 LE). 0x8664 = x64.
    const peOff = head.readUInt32LE(0x3c);
    const peHdr = Buffer.alloc(6);
    fs.readSync(fd, peHdr, 0, 6, peOff);
    if (peHdr.toString('ascii', 0, 4) !== 'PE\0\0') return { ok: false, kind: 'pe?' };
    const machine = peHdr.readUInt16LE(4);
    return { ok: machine === 0x8664, kind: 'pe', machine: '0x' + machine.toString(16) };
  } finally { fs.closeSync(fd); }
}

if (!fs.existsSync(NM)) { console.error('[native] node_modules missing — run npm ci first'); process.exit(1); }
let total = 0; const bad = []; const mods = new Set();
for (const f of walk(NM)) {
  total++;
  const rel = path.relative(NM, f);
  mods.add(rel.split(path.sep)[0]);
  const c = classify(f);
  if (!c.ok) bad.push(`${rel} [${c.kind}${c.machine ? ' ' + c.machine : ''}]`);
}
console.log(`[native] scanned ${total} .node files across ${mods.size} modules`);
if (total === 0) { console.error('[native] FAIL: no native addons found — npm ci did not build win32 binaries'); process.exit(1); }
if (bad.length) {
  console.error(`[native] FAIL: ${bad.length} non-win32-x64 addon(s) (Mac hard-copy or wrong arch):`);
  for (const b of bad.slice(0, 20)) console.error('  - ' + b);
  process.exit(1);
}
console.log('[native] PASS: all native addons are win32-x64 PE (built on the runner).');
