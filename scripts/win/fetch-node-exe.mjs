#!/usr/bin/env node
// P14-A1: download the official Windows node.exe v24.14.0 (win-x64) and verify
// its SHA256 against nodejs.org SHASUMS. Placed at runtime/bin/node.exe.
// Runs on the Windows runner. No model calls, no secrets.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE_VERSION = process.env.NODE_VERSION || '24.14.0';
// Pinned, verified against https://nodejs.org/dist/v24.14.0/SHASUMS256.txt
const EXPECTED_SHA = (process.env.NODE_EXE_SHA256 || '63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088').toLowerCase();
const URL = `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`;
const OUT = path.join(ROOT, 'runtime', 'bin', 'node.exe');

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  process.stdout.write(`[node.exe] downloading ${URL}\n`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== EXPECTED_SHA) {
    throw new Error(`SHA256 mismatch!\n expected ${EXPECTED_SHA}\n actual   ${sha}`);
  }
  fs.writeFileSync(OUT, buf);
  process.stdout.write(`[node.exe] OK ${OUT} (sha256 ${sha})\n`);
}
main().catch((e) => { process.stderr.write(`[node.exe] FAILED: ${e.message}\n`); process.exit(1); });
