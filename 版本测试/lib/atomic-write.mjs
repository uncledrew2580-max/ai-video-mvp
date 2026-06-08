import fs from 'node:fs';
import path from 'node:path';

// P14-B4: atomic JSON write that creates the parent directory first. On a fresh
// profile (e.g. Windows %APPDATA%\AI Video\config not yet created) a plain
// writeFileSync to <dir>/local-config.json.tmp fails with ENOENT; ensuring the
// parent dir before writing fixes first-run config saves. Writes to a .tmp
// sibling then renames so a crash mid-write never leaves a truncated file.
export function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}
