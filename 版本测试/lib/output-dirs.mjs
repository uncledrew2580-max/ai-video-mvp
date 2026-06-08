import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// P14-B4 (2A): output-directory helpers. Pure filesystem logic so they can be
// unit-tested without booting the review-assets server. The browser Web UI has
// no native folder picker on Windows/Linux, so users paste a path manually —
// these helpers normalize it (Windows backslashes, quotes, ~), build the
// canonical subdir layout, and verify each dir is creatable + writable.

const SUBDIRS = {
  storyboard_dir: 'Storyboards',
  video_dir: 'Videos',
  voiceover_dir: 'Voiceovers',
  final_dir: 'Final',
};

// Normalize a user-pasted output base path. Accepts Windows backslashes on any
// host, strips wrapping quotes (Explorer "Copy as path"), expands a leading ~,
// and resolves to an absolute path. Returns '' for empty/invalid input.
export function normalizeManualOutputBase(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return '';
  // Treat '\' as a separator everywhere so Windows-pasted paths work even when
  // this runs on a posix host (CI/test). On Windows path.resolve handles both.
  s = s.replace(/\\/g, '/');
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  try { return path.resolve(s); } catch { return ''; }
}

// Build the canonical 4-subdir layout under an output base.
export function outputSubDirs(base) {
  const out = { base_dir: base };
  for (const [key, name] of Object.entries(SUBDIRS)) out[key] = path.join(base, name);
  return out;
}

// Create dir (recursive) and verify it is a writable directory via a temp file.
// Returns { ok: true } or { ok: false, error } (Chinese); never throws.
export function ensureWritableDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { return { ok: false, error: `无法创建目录：${dir}（${e.code || e.message}）` }; }
  let st = null; try { st = fs.statSync(dir); } catch {}
  if (!st || !st.isDirectory()) return { ok: false, error: `无法创建目录：${dir}` };
  try {
    const t = path.join(dir, '.write_test_' + Date.now());
    fs.writeFileSync(t, '');
    fs.unlinkSync(t);
  } catch (e) { return { ok: false, error: `目录不可写：${dir}（${e.code || e.message}）` }; }
  return { ok: true };
}

// Create + write-probe the base and all 4 subdirs. Returns { ok, dirs, error }.
export function ensureOutputDirsWritable(base) {
  const dirs = outputSubDirs(base);
  for (const key of ['base_dir', 'storyboard_dir', 'video_dir', 'voiceover_dir', 'final_dir']) {
    const r = ensureWritableDir(dirs[key]);
    if (!r.ok) return { ok: false, dirs, error: r.error };
  }
  return { ok: true, dirs };
}
