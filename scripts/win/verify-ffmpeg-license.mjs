#!/usr/bin/env node
// P14-A1R3: run the bundled ffmpeg.exe -version in a PLAIN Windows shell (this
// step is invoked via `shell: pwsh`, NOT the MSYS2 shell) and assert:
//   (a) ffmpeg.exe runs standalone — no missing MinGW runtime DLLs (0xC0000139);
//   (b) the build is clean LGPL — no GPL/nonfree/x264/x265/fdk tokens.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FF = process.env.AI_VIDEO_FFMPEG_PATH || path.join(ROOT, 'runtime', 'bin', 'ffmpeg.exe');

const FORBIDDEN = [
  '--enable-gpl', '--enable-nonfree', '--enable-libx264', '--enable-libx265', '--enable-libfdk-aac',
  'libx264', 'libx265', 'libfdk', 'nonfree',
];

if (!fs.existsSync(FF)) { process.stderr.write(`[ffmpeg-license] missing ${FF}\n`); process.exit(1); }
let out;
try {
  out = execFileSync(FF, ['-hide_banner', '-version'], { timeout: 20000 }).toString('utf8');
} catch (e) {
  // 0xC0000139 (3221225785) etc. => dependent DLL / entry point not found.
  process.stderr.write(`[ffmpeg-license] FAIL: ffmpeg.exe did not run standalone (status ${e.status}). `);
  process.stderr.write('Likely a missing MinGW runtime DLL — the build must statically link the toolchain runtime.\n');
  process.exit(1);
}
const cfg = (out.split('\n').find((l) => l.startsWith('configuration:')) || '');
process.stdout.write(`[ffmpeg-license] version: ${out.split('\n')[0]}\n`);
process.stdout.write(`[ffmpeg-license] ${cfg}\n`);

const hits = FORBIDDEN.filter((t) => out.includes(t));
if (hits.length) {
  process.stderr.write(`[ffmpeg-license] FORBIDDEN tokens present: ${hits.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write('[ffmpeg-license] CLEAN — no gpl/nonfree/x264/x265/fdk tokens. PASS.\n');
