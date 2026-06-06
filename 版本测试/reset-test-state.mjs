import fs from 'fs';
import path from 'path';
import os from 'os';

const ROOT = path.join(os.homedir(), 'Downloads', 'tiktok-n8n-workflow-pack');
const CACHE_ROOT = path.join(ROOT, '.n8n-local-cache');

const KEEP = new Set(['.gitkeep']);

function removePath(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      if (KEEP.has(entry)) continue;
      removePath(path.join(target, entry));
    }
    for (const entry of fs.readdirSync(target)) {
      if (KEEP.has(entry)) continue;
      const full = path.join(target, entry);
      if (fs.existsSync(full) && fs.lstatSync(full).isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
      } else if (fs.existsSync(full)) {
        fs.rmSync(full, { force: true });
      }
    }
    return;
  }
  fs.rmSync(target, { force: true });
}

fs.mkdirSync(CACHE_ROOT, { recursive: true });
for (const entry of fs.readdirSync(CACHE_ROOT)) {
  if (KEEP.has(entry)) continue;
  removePath(path.join(CACHE_ROOT, entry));
}

console.log('reset complete:', CACHE_ROOT);
