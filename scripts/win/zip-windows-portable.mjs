#!/usr/bin/env node
// P14-A1R2: zip the verified portable staging tree and emit a SHA256.
// Runs AFTER assemble-windows-portable.mjs and AFTER verify-native-modules.mjs
// has confirmed the artifact tree is clean (win32-x64 only, no darwin/linux).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_ROOT = path.join(ROOT, 'dist-win');
const NAME = 'AI-Video-Win-x64-Portable-RC-0001';
const STAGE = path.join(OUT_ROOT, NAME);
const ZIP = path.join(OUT_ROOT, `${NAME}.zip`);

if (!fs.existsSync(STAGE)) { process.stderr.write(`[zip] missing staging tree ${STAGE}\n`); process.exit(1); }

process.stdout.write('[zip] compressing staging tree...\n');
// PowerShell Compress-Archive is available on windows-2022 runners.
execFileSync('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -Force`,
], { stdio: 'inherit' });

const sha = createHash('sha256').update(fs.readFileSync(ZIP)).digest('hex');
fs.writeFileSync(`${ZIP}.sha256`, `${sha}  ${path.basename(ZIP)}\n`);
process.stdout.write(`[zip] ${ZIP}\n[zip] sha256 ${sha}\n`);
